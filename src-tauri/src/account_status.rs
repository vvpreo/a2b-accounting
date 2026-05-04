use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
use crate::transactions::validate_account_chain;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthRange {
    pub year_month: String,
    pub start_utc: String,
    pub end_utc: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountMonthCell {
    pub account_id: i64,
    pub year_month: String,
    pub status: String,
    pub balance_error: bool,
    pub uncategorized_correcting: bool,
    /// True if the account has at least one transaction strictly after this
    /// month — i.e. the chain "closes" past this point. Drives the black
    /// anchor border in the UI (red error border still wins on top).
    pub anchored: bool,
}

#[tauri::command]
pub fn account_monthly_status(
    state: State<'_, DbState>,
    months: Vec<MonthRange>,
) -> Result<Vec<AccountMonthCell>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    compute(&conn, &months).map_err(|e| e.to_string())
}

struct TxnRow {
    occurred_at_utc: String,
    is_correcting: bool,
    has_categories: bool,
    is_linked: bool,
}

fn compute(
    conn: &Connection,
    months: &[MonthRange],
) -> rusqlite::Result<Vec<AccountMonthCell>> {
    let mut stmt = conn.prepare("SELECT id FROM accounts ORDER BY id ASC")?;
    let account_ids: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut out = Vec::with_capacity(account_ids.len() * months.len());

    for account_id in account_ids {
        let mut stmt = conn.prepare(
            "SELECT t.occurred_at_utc,
                    t.is_correcting,
                    EXISTS(SELECT 1 FROM transaction_categories tc
                           WHERE tc.transaction_id = t.id) AS has_categories,
                    EXISTS(SELECT 1 FROM transaction_links tl
                           WHERE tl.txn_a_id = t.id OR tl.txn_b_id = t.id) AS is_linked
             FROM transactions t
             WHERE t.account_id = ?1
             ORDER BY t.occurred_at_utc ASC",
        )?;
        let txns: Vec<TxnRow> = stmt
            .query_map([account_id], |r| {
                Ok(TxnRow {
                    occurred_at_utc: r.get(0)?,
                    is_correcting: r.get(1)?,
                    has_categories: r.get(2)?,
                    is_linked: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        let first_txn_utc = txns.first().map(|t| t.occurred_at_utc.clone());
        let last_txn_utc = txns.last().map(|t| t.occurred_at_utc.clone());
        let errors = validate_account_chain(conn, account_id)?;

        for range in months {
            // Months that end on or before the account's first transaction are
            // treated as "the account did not yet exist" — we don't render any
            // data for them. An account with zero transactions still falls
            // through to the normal logic and shows up as `no_data`.
            if let Some(first) = first_txn_utc.as_deref() {
                if range.end_utc.as_str() <= first {
                    out.push(AccountMonthCell {
                        account_id,
                        year_month: range.year_month.clone(),
                        status: "pre_account".to_string(),
                        balance_error: false,
                        uncategorized_correcting: false,
                        anchored: false,
                    });
                    continue;
                }
            }

            let in_range: Vec<&TxnRow> = txns
                .iter()
                .filter(|t| {
                    t.occurred_at_utc.as_str() >= range.start_utc.as_str()
                        && t.occurred_at_utc.as_str() < range.end_utc.as_str()
                })
                .collect();

            let total = in_range.len();
            let uncategorized_correcting_count = in_range
                .iter()
                .filter(|t| t.is_correcting && !t.has_categories)
                .count();

            // A transaction counts as "real data" unless it is an uncategorized
            // correcting entry. This matches the spec: a regular transaction is
            // data even without categories; only correcting entries need to be
            // categorized to count.
            let real_data = total - uncategorized_correcting_count;

            let dashed = in_range
                .iter()
                .any(|t| t.is_correcting && !t.has_categories && !t.is_linked);

            let balance_error = errors.iter().any(|e| {
                e.occurred_at_utc.as_str() >= range.start_utc.as_str()
                    && e.occurred_at_utc.as_str() < range.end_utc.as_str()
            });

            let no_data = total == 0 || real_data == 0;

            // Anchor signal is independent of the fill color: the cell is
            // anchored whenever any later transaction exists for this account.
            let anchored = last_txn_utc
                .as_deref()
                .map(|t| t >= range.end_utc.as_str())
                .unwrap_or(false);

            // Fill is binary now — either there's real data in the month or
            // there isn't. Within-month problems (balance break, uncategorized
            // correcting) are surfaced via the independent `balance_error` and
            // `uncategorized_correcting` flags so the UI can paint the cell
            // red or dash its border without polluting the fill state.
            let status = if no_data { "no_data" } else { "complete" };

            out.push(AccountMonthCell {
                account_id,
                year_month: range.year_month.clone(),
                status: status.to_string(),
                balance_error,
                uncategorized_correcting: dashed,
                anchored,
            });
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    struct Fixture {
        _dir: TempDir,
        conn: Connection,
        account_id: i64,
        batch_id: i64,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let account_id: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, bank, currency, account_number, owner_name)
                 VALUES ('Main', 'TestBank', 'RUB', '1', 'Alice') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let batch_id: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();

        Fixture {
            _dir: dir,
            conn,
            account_id,
            batch_id,
        }
    }

    fn insert_txn(
        f: &Fixture,
        occurred_at_utc: &str,
        credit: i64,
        debit: i64,
        balance: i64,
        is_correcting: bool,
    ) -> i64 {
        f.conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, is_correcting)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
                params![
                    f.account_id,
                    f.batch_id,
                    occurred_at_utc,
                    credit,
                    debit,
                    balance,
                    is_correcting as i64
                ],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn insert_category(conn: &Connection, name: &str, kind: &str) -> i64 {
        conn.query_row(
            "INSERT INTO categories (name, color, kind) VALUES (?1, '#cccccc', ?2) RETURNING id",
            params![name, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn link_to_category(conn: &Connection, txn_id: i64, category_id: i64, share: i64) {
        conn.execute(
            "INSERT INTO transaction_categories
             (transaction_id, category_id, share_minor, position) VALUES (?1, ?2, ?3, 0)",
            params![txn_id, category_id, share],
        )
        .unwrap();
    }

    fn ranges(months: &[(&str, &str, &str)]) -> Vec<MonthRange> {
        months
            .iter()
            .map(|(ym, s, e)| MonthRange {
                year_month: ym.to_string(),
                start_utc: s.to_string(),
                end_utc: e.to_string(),
            })
            .collect()
    }

    fn cell<'a>(cells: &'a [AccountMonthCell], ym: &str) -> &'a AccountMonthCell {
        cells.iter().find(|c| c.year_month == ym).expect(ym)
    }

    #[test]
    fn no_transactions_means_no_data_everywhere() {
        let f = fixture();
        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();
        assert_eq!(r.len(), 2);
        for c in &r {
            assert_eq!(c.status, "no_data");
            assert!(!c.balance_error);
            assert!(!c.uncategorized_correcting);
        }
    }

    #[test]
    fn regular_transaction_status_complete_anchor_decoupled() {
        let f = fixture();
        // January: regular debit, balance 9000
        insert_txn(&f, "2026-01-15T10:00:00Z", 0, 1000, 9000, false);
        // February: regular debit (later than January)
        insert_txn(&f, "2026-02-15T10:00:00Z", 0, 500, 8500, false);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        // Both months are "complete" by fill — the data is clean. The
        // difference is captured by the `anchored` flag instead.
        let jan = cell(&r, "2026-01");
        assert_eq!(jan.status, "complete");
        assert!(jan.anchored);
        let feb = cell(&r, "2026-02");
        assert_eq!(feb.status, "complete");
        assert!(!feb.anchored);
    }

    #[test]
    fn only_uncategorized_correcting_means_no_data() {
        let f = fixture();
        // Regular txn in March (so "data after" is satisfied for January)
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 100, 8900, false);
        // January: only an uncategorized correcting entry
        insert_txn(&f, "2026-01-15T10:00:00Z", 0, 100, 9000, true);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        let jan = cell(&r, "2026-01");
        assert_eq!(jan.status, "no_data");
        // Dashed: uncategorized correcting that's not linked to a transfer.
        assert!(jan.uncategorized_correcting);
        assert!(!jan.balance_error);
    }

    #[test]
    fn correcting_categorized_makes_cell_complete() {
        let f = fixture();
        let category = insert_category(&f.conn, "Misc", "expense");
        // Regular anchor in March
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 100, 8900, false);
        // January: regular + correcting that we will categorize
        insert_txn(&f, "2026-01-10T10:00:00Z", 0, 100, 9000, false);
        let correcting = insert_txn(&f, "2026-01-20T10:00:00Z", 0, 50, 8950, true);
        link_to_category(&f.conn, correcting, category, 50);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        let jan = cell(&r, "2026-01");
        assert_eq!(jan.status, "complete");
        assert!(!jan.uncategorized_correcting);
        assert!(!jan.balance_error);
    }

    #[test]
    fn uncategorized_correcting_alongside_regular_is_complete_with_dashed() {
        let f = fixture();
        // Anchor in March
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 100, 8900, false);
        // January: regular + uncategorized correcting
        insert_txn(&f, "2026-01-10T10:00:00Z", 0, 100, 9000, false);
        insert_txn(&f, "2026-01-20T10:00:00Z", 0, 50, 8950, true);

        let m = ranges(&[(
            "2026-01",
            "2026-01-01T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )]);
        let r = compute(&f.conn, &m).unwrap();
        let jan = cell(&r, "2026-01");
        // Fill is just `complete` now — the dashed flag carries the
        // "needs review" signal independently.
        assert_eq!(jan.status, "complete");
        assert!(jan.uncategorized_correcting);
        assert!(!jan.balance_error);
    }

    #[test]
    fn linked_correcting_does_not_dash_but_still_blocks_complete() {
        let f = fixture();
        // We need two accounts to be able to link transactions.
        let other_account: i64 = f.conn
            .query_row(
                "INSERT INTO accounts (name, bank, currency, account_number, owner_name)
                 VALUES ('Other', 'TestBank', 'RUB', '2', 'Alice') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let other_batch: i64 = f.conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [other_account],
                |r| r.get(0),
            )
            .unwrap();

        // Anchor in March on main account (data after for January)
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 100, 8900, false);
        // January: regular + correcting (uncategorized) that will be linked.
        insert_txn(&f, "2026-01-10T10:00:00Z", 0, 100, 9000, false);
        let correcting = insert_txn(&f, "2026-01-20T10:00:00Z", 0, 50, 8950, true);
        // Counterparty correcting on the other account (incoming, opposite direction).
        let other_correcting: i64 = f.conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, is_correcting)
                 VALUES (?1, ?2, '2026-01-20T10:00:00Z', 50, 0, 50, 1) RETURNING id",
                params![other_account, other_batch],
                |r| r.get(0),
            )
            .unwrap();
        // Link the two (canonical order: smaller id first).
        let (a, b) = if correcting < other_correcting {
            (correcting, other_correcting)
        } else {
            (other_correcting, correcting)
        };
        f.conn
            .execute(
                "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
                params![a, b],
            )
            .unwrap();

        let m = ranges(&[(
            "2026-01",
            "2026-01-01T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )]);
        let r = compute(&f.conn, &m).unwrap();
        // We are looking at the main account's January cell.
        let jan = r
            .iter()
            .find(|c| c.account_id == f.account_id && c.year_month == "2026-01")
            .unwrap();
        // Linked correcting does NOT raise the dashed border flag…
        assert!(!jan.uncategorized_correcting);
        // …and the fill is just `complete` — there is real data in the month.
        // The "uncategorized" concern doesn't show up anywhere when the
        // correcting entry is part of a linked transfer.
        assert_eq!(jan.status, "complete");
        assert!(!jan.balance_error);
    }

    #[test]
    fn balance_error_in_month_is_flagged() {
        let f = fixture();
        // January: balance chain breaks (declared balance != computed)
        insert_txn(&f, "2026-01-10T10:00:00Z", 0, 100, 9900, false);
        insert_txn(&f, "2026-01-20T10:00:00Z", 0, 100, 1234, false);
        // Anchor in March so January has "data after"
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 100, 1134, false);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        let jan = cell(&r, "2026-01");
        assert!(jan.balance_error);
        // Status fill is binary — either there is real data in the month or
        // not. The balance break is reported via the independent
        // `balance_error` flag (rendered as a red fill in the UI).
        assert_eq!(jan.status, "complete");
    }

    #[test]
    fn data_in_last_month_is_complete_but_unanchored() {
        let f = fixture();
        // Only data is in March (the most recent of our three ranges).
        insert_txn(&f, "2026-03-10T10:00:00Z", 0, 100, 9900, false);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        // March: clean data → complete fill, but no later transaction
        // exists, so the cell is not anchored.
        let mar = cell(&r, "2026-03");
        assert_eq!(mar.status, "complete");
        assert!(!mar.anchored);
        // Months that end before the account's first transaction are
        // treated as if the account didn't exist yet.
        assert_eq!(cell(&r, "2026-01").status, "pre_account");
        assert_eq!(cell(&r, "2026-02").status, "pre_account");
    }

    #[test]
    fn months_before_first_transaction_are_pre_account() {
        let f = fixture();
        // First transaction lands mid-March; January and February ended
        // before that, so they pre-date the account's existence.
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 500, 9500, false);
        // April provides "data after" so March can settle as `complete`.
        insert_txn(&f, "2026-04-05T10:00:00Z", 0, 100, 9400, false);

        let m = ranges(&[
            ("2025-12", "2025-12-01T00:00:00Z", "2026-01-01T00:00:00Z"),
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
            ("2026-04", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        for ym in ["2025-12", "2026-01", "2026-02"] {
            let c = cell(&r, ym);
            assert_eq!(c.status, "pre_account", "{ym} should be pre_account");
            assert!(!c.balance_error);
            assert!(!c.uncategorized_correcting);
        }
        // The month containing the first transaction is back to normal logic.
        let mar = cell(&r, "2026-03");
        assert_eq!(mar.status, "complete");
        assert!(mar.anchored);
        // The latest month has no data after it: still complete by fill,
        // but unanchored — the strip will render no border.
        let apr = cell(&r, "2026-04");
        assert_eq!(apr.status, "complete");
        assert!(!apr.anchored);
    }

    #[test]
    fn empty_month_is_anchored_when_later_data_exists() {
        // A no_data month that sits between the account's first transaction
        // and the latest transaction should still be flagged anchored — the
        // chain "passes through" it. The UI treats this as a verified-empty
        // month (gray fill + black anchor border).
        let f = fixture();
        insert_txn(&f, "2026-01-15T10:00:00Z", 0, 100, 9900, false);
        insert_txn(&f, "2026-03-15T10:00:00Z", 0, 100, 9800, false);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();

        let feb = cell(&r, "2026-02");
        assert_eq!(feb.status, "no_data");
        assert!(feb.anchored, "no_data month with later data must be anchored");
        let mar = cell(&r, "2026-03");
        assert!(!mar.anchored, "month containing the latest txn is not anchored");
    }

    #[test]
    fn pre_account_month_is_never_anchored() {
        let f = fixture();
        insert_txn(&f, "2026-03-10T10:00:00Z", 0, 100, 9900, false);

        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-03", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();
        let jan = cell(&r, "2026-01");
        assert_eq!(jan.status, "pre_account");
        assert!(!jan.anchored);
    }

    #[test]
    fn account_with_no_transactions_stays_no_data_not_pre_account() {
        // Without a "first transaction" anchor, the pre_account fast-path
        // shouldn't fire — empty accounts should still surface as no_data
        // so the user notices that the account exists but has nothing.
        let f = fixture();
        let m = ranges(&[
            ("2026-01", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            ("2026-02", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
        ]);
        let r = compute(&f.conn, &m).unwrap();
        for c in &r {
            assert_eq!(c.status, "no_data");
        }
    }
}
