//! FX-conversion deltas for inter-account transfer pairs.
//!
//! For every linked pair `(txn_a, txn_b)` we compute the gain/loss the user
//! actually realised relative to the dictionary (Frankfurter EUR-base) rate
//! at the date the transfer was initiated. The result is expressed in *each
//! side's own currency* — so a USD↔THB transfer surfaces both a cents-level
//! delta on the USD row and a satang-level delta on the THB row.
//!
//! Rate semantics match what `exchange_rates.rate_to_base` actually stores:
//! Frankfurter publishes `rates: { CUR: q }` against EUR base meaning
//! `1 EUR = q CUR`. We therefore convert between two non-EUR currencies via
//! the cross `cross(D→C) = q_C / q_D`. EUR itself is the base and uses `q = 1`
//! by convention.
//!
//! Formula derivation. Let `signed_x = credit_x - debit_x` (positive = received,
//! negative = paid) and same for the partner side. The two sides of a clean
//! same-currency transfer cancel: `signed_x + signed_y = 0`. For a cross-
//! currency transfer the partner net has to be re-expressed in `x`'s currency
//! before adding, which gives the unified expression used below:
//!
//! ```text
//!     delta_x = signed_x + signed_y * q_x / q_y
//! ```
//!
//! Both `q_x` and `q_y` are looked up at `min(date_x, date_y)` — the user's
//! "transfer initiation" date, so the reference point matches across both
//! rows of the same pair.

use rusqlite::Connection;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::Serialize;
use tauri::State;

use crate::db::DbState;
use crate::exchange_rates::lookup_rate_at;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferDelta {
    pub transaction_id: i64,
    /// Signed delta in the transaction's own currency, in minor units. `None`
    /// when at least one rate could not be resolved — the frontend renders a
    /// red dash in that case.
    pub delta_minor: Option<i64>,
    /// Absolute "expected" amount on this side at the dictionary cross-rate,
    /// in the same currency / minor units as `delta_minor`. Always positive
    /// when present. Acts as the percentage base for the frontend's % mode:
    /// `pct = delta_minor / expected_minor × 100`. `None` whenever
    /// `delta_minor` is None (same missing-rate condition).
    pub expected_minor: Option<i64>,
    pub currency: String,
    /// Actual `rate_date` from `exchange_rates` used to back the calculation.
    /// When the two sides of the pair pin different rate dates we surface the
    /// later one (the freshest constraint on accuracy). `None` for EUR/EUR
    /// transfers — there is literally no rate row involved.
    pub rate_date: Option<String>,
}

/// Per-transaction deltas for every pair currently in `transaction_links`.
///
/// One link contributes two entries — one per side. Transactions that don't
/// belong to any link are simply absent from the response; the frontend keys
/// off the transaction id and leaves their cell blank.
#[tauri::command]
pub fn list_transfer_deltas(state: State<'_, DbState>) -> Result<Vec<TransferDelta>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    list_transfer_deltas_impl(&conn)
}

fn list_transfer_deltas_impl(conn: &Connection) -> Result<Vec<TransferDelta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT
               ta.id, ta.credit, ta.debit, ta.occurred_at_utc, aa.currency,
               tb.id, tb.credit, tb.debit, tb.occurred_at_utc, ab.currency
             FROM transaction_links l
             JOIN transactions ta ON ta.id = l.txn_a_id
             JOIN transactions tb ON tb.id = l.txn_b_id
             JOIN accounts     aa ON aa.id = ta.account_id
             JOIN accounts     ab ON ab.id = tb.account_id",
        )
        .map_err(|e| e.to_string())?;

    let pairs: Vec<PairRow> = stmt
        .query_map([], |r| {
            Ok(PairRow {
                a: SideRow {
                    txn_id: r.get(0)?,
                    credit: r.get(1)?,
                    debit: r.get(2)?,
                    occurred_at_utc: r.get(3)?,
                    currency: r.get(4)?,
                },
                b: SideRow {
                    txn_id: r.get(5)?,
                    credit: r.get(6)?,
                    debit: r.get(7)?,
                    occurred_at_utc: r.get(8)?,
                    currency: r.get(9)?,
                },
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(pairs.len() * 2);
    for pair in pairs {
        let (da, db) = compute_pair(conn, &pair.a, &pair.b);
        out.push(da);
        out.push(db);
    }
    Ok(out)
}

struct PairRow {
    a: SideRow,
    b: SideRow,
}

struct SideRow {
    txn_id: i64,
    credit: i64,
    debit: i64,
    occurred_at_utc: String,
    currency: String,
}

impl SideRow {
    /// Signed minor amount: positive when the side received money, negative
    /// when it paid out. The link constraint guarantees exactly one of credit
    /// / debit is non-zero, so this is unambiguous.
    fn signed_minor(&self) -> i64 {
        self.credit - self.debit
    }

    /// First 10 chars of `2026-04-15T10:00:00Z` → `2026-04-15`. Robust against
    /// timestamps that omit `Z` or use a fractional seconds field.
    fn date_yyyy_mm_dd(&self) -> &str {
        let s = self.occurred_at_utc.as_str();
        if s.len() >= 10 {
            &s[..10]
        } else {
            s
        }
    }
}

fn compute_pair(conn: &Connection, a: &SideRow, b: &SideRow) -> (TransferDelta, TransferDelta) {
    let date_a = a.date_yyyy_mm_dd();
    let date_b = b.date_yyyy_mm_dd();
    // "Initiation" date = earliest of the two — both sides resolve their rate
    // at the same as-of point so the cross-rate is internally consistent.
    let early = if date_a <= date_b { date_a } else { date_b };

    let lookup_a = lookup_rate_at(conn, &a.currency, early);
    let lookup_b = lookup_rate_at(conn, &b.currency, early);

    let (qa, da_date, qb, db_date) = match (lookup_a, lookup_b) {
        (Some((qa, da)), Some((qb, db))) => (qa, da, qb, db),
        _ => {
            // Either currency has no rate row yet (e.g. background download
            // hasn't finished). Surface as null on both sides; the UI shows
            // a dash and the user can still see the link existed.
            return (
                TransferDelta {
                    transaction_id: a.txn_id,
                    delta_minor: None,
                    expected_minor: None,
                    currency: a.currency.clone(),
                    rate_date: None,
                },
                TransferDelta {
                    transaction_id: b.txn_id,
                    delta_minor: None,
                    expected_minor: None,
                    currency: b.currency.clone(),
                    rate_date: None,
                },
            );
        }
    };

    // Pick the latest of the two backing dates for the tooltip — that is the
    // one bounding the staleness of the cross. If both sides are EUR (no row
    // dates), surface `None` and let the UI fall back to the txn date.
    let combined_date = match (da_date, db_date) {
        (Some(x), Some(y)) => Some(if x >= y { x } else { y }),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    };

    let signed_a = Decimal::from(a.signed_minor());
    let signed_b = Decimal::from(b.signed_minor());

    // delta_x = signed_x + signed_y * q_x / q_y
    let delta_a = signed_a + signed_b * qa / qb;
    let delta_b = signed_b + signed_a * qb / qa;

    // Absolute "expected" magnitude on each side at the fair cross-rate —
    // i.e. what side X *should* have moved given side Y's actual amount.
    // Always positive when computable. Used by the frontend as the base for
    // the % display: `pct = delta / expected × 100`.
    let expected_a = (signed_b * qa / qb).abs();
    let expected_b = (signed_a * qb / qa).abs();

    (
        TransferDelta {
            transaction_id: a.txn_id,
            delta_minor: decimal_to_rounded_i64(delta_a),
            expected_minor: decimal_to_rounded_i64(expected_a),
            currency: a.currency.clone(),
            rate_date: combined_date.clone(),
        },
        TransferDelta {
            transaction_id: b.txn_id,
            delta_minor: decimal_to_rounded_i64(delta_b),
            expected_minor: decimal_to_rounded_i64(expected_b),
            currency: b.currency.clone(),
            rate_date: combined_date,
        },
    )
}

/// Round-half-away-from-zero into i64. Returns `None` if the rounded value
/// would overflow (defensive — should never happen with realistic amounts).
fn decimal_to_rounded_i64(d: Decimal) -> Option<i64> {
    d.round_dp_with_strategy(0, rust_decimal::RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    struct Fx {
        _dir: TempDir,
        conn: Connection,
    }

    fn open() -> Fx {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        Fx { _dir: dir, conn }
    }

    fn make_account(conn: &Connection, currency: &str, number: &str) -> i64 {
        conn.query_row(
            "INSERT INTO accounts (bank, currency, account_number, owner_name)
             VALUES ('B', ?1, ?2, 'O') RETURNING id",
            params![currency, number],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn make_batch(conn: &Connection, account_id: i64) -> i64 {
        conn.query_row(
            "INSERT INTO import_batches
             (account_id, imported_at, source_filename, row_count, timezone_offset)
             VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
            [account_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn make_txn(
        conn: &Connection,
        account_id: i64,
        batch_id: i64,
        credit: i64,
        debit: i64,
        date_iso: &str,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO transactions
             (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
             VALUES (?1, ?2, ?3, ?4, ?5, 0) RETURNING id",
            params![account_id, batch_id, date_iso, credit, debit],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn link(conn: &Connection, a: i64, b: i64) {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        conn.execute(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
            params![lo, hi],
        )
        .unwrap();
    }

    fn insert_rate(conn: &Connection, currency: &str, date: &str, rate: &str) {
        conn.execute(
            "INSERT INTO exchange_rates (currency, rate_date, rate_to_base)
             VALUES (?1, ?2, ?3)",
            params![currency, date, rate],
        )
        .unwrap();
    }

    fn delta_for(out: &[TransferDelta], txn_id: i64) -> &TransferDelta {
        out.iter().find(|d| d.transaction_id == txn_id).unwrap()
    }

    #[test]
    fn user_example_usd_thb_yields_expected_signs_and_magnitudes() {
        // Example from the task spec: $1 → 35 THB at dictionary cross-rate
        // 32 THB/USD. Expected: USD row +0.09, THB row +3.00 (both gains
        // because the actual rate beat the reference).
        //
        // Frankfurter stores units-per-EUR, so we encode the cross 32 THB/USD
        // as q_USD = 1, q_THB = 32 (any common scale works).
        let f = open();
        let usd = make_account(&f.conn, "USD", "u1");
        let thb = make_account(&f.conn, "THB", "t1");
        let bu = make_batch(&f.conn, usd);
        let bt = make_batch(&f.conn, thb);
        let usd_out = make_txn(&f.conn, usd, bu, 0, 100, "2026-04-10T10:00:00Z");
        let thb_in = make_txn(&f.conn, thb, bt, 35_00, 0, "2026-04-10T10:00:00Z");
        link(&f.conn, usd_out, thb_in);
        insert_rate(&f.conn, "USD", "2026-04-10", "1");
        insert_rate(&f.conn, "THB", "2026-04-10", "32");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        assert_eq!(out.len(), 2);

        // USD: -100c paid, expected -109.375c at fair rate → delta +9 (rounded).
        let usd_delta = delta_for(&out, usd_out);
        assert_eq!(usd_delta.currency, "USD");
        assert_eq!(usd_delta.delta_minor, Some(9));
        // |expected| = 3500 × 1/32 = 109.375 → rounds to 109.
        assert_eq!(usd_delta.expected_minor, Some(109));
        assert_eq!(usd_delta.rate_date.as_deref(), Some("2026-04-10"));

        // THB: +3500 satang received, expected +3200 at fair rate → +300.
        let thb_delta = delta_for(&out, thb_in);
        assert_eq!(thb_delta.currency, "THB");
        assert_eq!(thb_delta.delta_minor, Some(300));
        // |expected| = 100 × 32 = 3200.
        assert_eq!(thb_delta.expected_minor, Some(3200));
        assert_eq!(thb_delta.rate_date.as_deref(), Some("2026-04-10"));
    }

    #[test]
    fn unfavorable_rate_yields_negative_deltas_on_both_sides() {
        // Same direction, but actual conversion was worse than reference:
        // $1 → 30 THB while reference is still 32 THB/USD. Both rows lose.
        let f = open();
        let usd = make_account(&f.conn, "USD", "u1");
        let thb = make_account(&f.conn, "THB", "t1");
        let bu = make_batch(&f.conn, usd);
        let bt = make_batch(&f.conn, thb);
        let usd_out = make_txn(&f.conn, usd, bu, 0, 100, "2026-04-10T10:00:00Z");
        let thb_in = make_txn(&f.conn, thb, bt, 30_00, 0, "2026-04-10T10:00:00Z");
        link(&f.conn, usd_out, thb_in);
        insert_rate(&f.conn, "USD", "2026-04-10", "1");
        insert_rate(&f.conn, "THB", "2026-04-10", "32");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        let usd_delta = delta_for(&out, usd_out);
        let thb_delta = delta_for(&out, thb_in);
        // USD expected = -3000 / 32 = -93.75c paid → delta = -100 - (-93.75)
        // = -6.25 → rounds to -6 (half away from zero gives -6 not -7 because
        // 0.25 < 0.5).
        assert_eq!(usd_delta.delta_minor, Some(-6));
        // THB expected = 100 * 32 = 3200, got 3000 → delta = -200.
        assert_eq!(thb_delta.delta_minor, Some(-200));
    }

    #[test]
    fn same_currency_transfer_yields_zero_when_amounts_match() {
        // Plain RUB→RUB internal move with no fee — both rows should net to
        // exactly 0.
        let f = open();
        let a = make_account(&f.conn, "RUB", "a");
        let b = make_account(&f.conn, "RUB", "b");
        let ba = make_batch(&f.conn, a);
        let bb = make_batch(&f.conn, b);
        let out_a = make_txn(&f.conn, a, ba, 0, 5000_00, "2026-04-10T10:00:00Z");
        let in_b = make_txn(&f.conn, b, bb, 5000_00, 0, "2026-04-10T10:00:00Z");
        link(&f.conn, out_a, in_b);
        insert_rate(&f.conn, "RUB", "2026-04-10", "100");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        assert_eq!(delta_for(&out, out_a).delta_minor, Some(0));
        assert_eq!(delta_for(&out, in_b).delta_minor, Some(0));
    }

    #[test]
    fn same_currency_transfer_with_fee_surfaces_loss() {
        // Bank kept 50 kopecks as a wire fee — the credit is smaller than
        // the debit even though both sides are the same currency. The delta
        // formula naturally captures this: signed_x + signed_y where one
        // side is -5000 and the other is +4950 → delta is -50 on each row.
        let f = open();
        let a = make_account(&f.conn, "RUB", "a");
        let b = make_account(&f.conn, "RUB", "b");
        let ba = make_batch(&f.conn, a);
        let bb = make_batch(&f.conn, b);
        let out_a = make_txn(&f.conn, a, ba, 0, 5000_00, "2026-04-10T10:00:00Z");
        let in_b = make_txn(&f.conn, b, bb, 4950_00, 0, "2026-04-10T10:00:00Z");
        link(&f.conn, out_a, in_b);
        insert_rate(&f.conn, "RUB", "2026-04-10", "100");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        // Outgoing side "expected to pay" 4950, paid 5000 → delta -50.
        assert_eq!(delta_for(&out, out_a).delta_minor, Some(-50_00));
        // Incoming side "expected to receive" 5000, got 4950 → delta -50.
        assert_eq!(delta_for(&out, in_b).delta_minor, Some(-50_00));
    }

    #[test]
    fn eur_base_pair_uses_implicit_rate_one_and_no_rate_date() {
        // EUR is base — no row in `exchange_rates`. The lookup returns
        // (1, None) so the calc still works; rate_date should be the other
        // side's actual rate_date.
        let f = open();
        let eur = make_account(&f.conn, "EUR", "e1");
        let usd = make_account(&f.conn, "USD", "u1");
        let be = make_batch(&f.conn, eur);
        let bu = make_batch(&f.conn, usd);
        let eur_out = make_txn(&f.conn, eur, be, 0, 1_00, "2026-04-10T10:00:00Z");
        // q_USD = 1.10 → 1 EUR = 1.10 USD → fair: 1 EUR → 110c.
        // Got 105c → loss on both sides.
        let usd_in = make_txn(&f.conn, usd, bu, 1_05, 0, "2026-04-10T10:00:00Z");
        link(&f.conn, eur_out, usd_in);
        insert_rate(&f.conn, "USD", "2026-04-10", "1.10");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        let eur_d = delta_for(&out, eur_out);
        // EUR expected to pay = 105 / 1.10 ≈ 95.45c → delta = -100 - (-95.45)
        // = -4.55 → rounds to -5.
        assert_eq!(eur_d.delta_minor, Some(-5));
        // The USD row pinned the rate_date.
        assert_eq!(eur_d.rate_date.as_deref(), Some("2026-04-10"));

        let usd_d = delta_for(&out, usd_in);
        // USD expected = 100 * 1.10 = 110, got 105 → -5.
        assert_eq!(usd_d.delta_minor, Some(-5));
    }

    #[test]
    fn missing_rate_returns_none_on_both_sides() {
        // Link exists, but rates haven't been downloaded yet. Both deltas
        // come back as None so the UI can render the red dash.
        let f = open();
        let usd = make_account(&f.conn, "USD", "u1");
        let thb = make_account(&f.conn, "THB", "t1");
        let bu = make_batch(&f.conn, usd);
        let bt = make_batch(&f.conn, thb);
        let usd_out = make_txn(&f.conn, usd, bu, 0, 100, "2026-04-10T10:00:00Z");
        let thb_in = make_txn(&f.conn, thb, bt, 35_00, 0, "2026-04-10T10:00:00Z");
        link(&f.conn, usd_out, thb_in);
        // Only USD has a rate; THB is missing.
        insert_rate(&f.conn, "USD", "2026-04-10", "1");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        assert!(delta_for(&out, usd_out).delta_minor.is_none());
        assert!(delta_for(&out, usd_out).expected_minor.is_none());
        assert!(delta_for(&out, thb_in).delta_minor.is_none());
        assert!(delta_for(&out, thb_in).expected_minor.is_none());
        assert!(delta_for(&out, usd_out).rate_date.is_none());
    }

    #[test]
    fn earliest_date_anchors_lookup_when_two_rows_disagree() {
        // Outgoing on 2026-04-10, incoming on 2026-04-12 — initiation date
        // should be 2026-04-10, and the rate row picked at that date.
        let f = open();
        let usd = make_account(&f.conn, "USD", "u1");
        let thb = make_account(&f.conn, "THB", "t1");
        let bu = make_batch(&f.conn, usd);
        let bt = make_batch(&f.conn, thb);
        let usd_out = make_txn(&f.conn, usd, bu, 0, 100, "2026-04-10T10:00:00Z");
        let thb_in = make_txn(&f.conn, thb, bt, 32_00, 0, "2026-04-12T10:00:00Z");
        link(&f.conn, usd_out, thb_in);
        // Two snapshots — calc should pick the earlier one.
        insert_rate(&f.conn, "USD", "2026-04-08", "1");
        insert_rate(&f.conn, "THB", "2026-04-08", "32");
        insert_rate(&f.conn, "USD", "2026-04-12", "1");
        insert_rate(&f.conn, "THB", "2026-04-12", "30");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        let thb_delta = delta_for(&out, thb_in);
        // Using 2026-04-08 cross (1, 32) the conversion is exact: -100 USD →
        // 3200 satang received → delta = 0.
        assert_eq!(thb_delta.delta_minor, Some(0));
        assert_eq!(thb_delta.rate_date.as_deref(), Some("2026-04-08"));
    }

    #[test]
    fn unlinked_transactions_produce_no_entry() {
        // A standalone transaction without a link must not appear in the
        // response at all — the frontend keys off presence to decide whether
        // to render anything in the column.
        let f = open();
        let usd = make_account(&f.conn, "USD", "u1");
        let bu = make_batch(&f.conn, usd);
        make_txn(&f.conn, usd, bu, 100_00, 0, "2026-04-10T10:00:00Z");

        let out = list_transfer_deltas_impl(&f.conn).unwrap();
        assert!(out.is_empty());
    }
}
