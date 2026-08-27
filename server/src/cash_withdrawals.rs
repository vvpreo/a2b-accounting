//! "Withdraw to cash" — a convenience command that pairs one outgoing bank
//! transaction with a new incoming cash transaction in a single atomic step.
//!
//! Typical use case: an ATM withdrawal shows up as a debit on a bank account
//! statement; the user wants to record the matching credit on their cash
//! account and mark the two as a transfer between own accounts. Doing this
//! manually requires three trips (manual entry on the cash tab, navigating
//! back, picking the link partner) — this command collapses all of it.
//!
//! Invariants enforced here:
//!   - Source transaction must exist and be outgoing (debit > 0).
//!   - Target account must exist and be of kind 'cash'.
//!   - The two must be on different accounts.
//!   - Source must not already participate in another link.
//!   - The provided amount must parse as a positive decimal.
//!
//! Side effects (one SQL transaction):
//!   - Inserts a new cash transaction (credit = amount, debit = 0) at
//!     `source.occurred_at_utc + 1 second`, with NULL peer/comment.
//!   - Inserts a `transaction_links` row pairing the two ids.
//!   - Recomputes running balances on the cash account from the new row
//!     onward.

use chrono::{DateTime, Duration, SecondsFormat};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use crate::host::State;

use crate::cash_transactions::{
    ensure_cash_account, fetch_transaction, insert_cash_transaction_row,
};
use crate::db::DbState;
use crate::money;
use crate::transaction_links::{
    insert_link_unchecked, is_already_linked, TxnLink, ERR_ALREADY_LINKED, ERR_NOT_FOUND,
    ERR_SAME_ACCOUNT,
};
use crate::transactions::Transaction;

const ERR_SOURCE_NOT_OUTGOING: &str = "withdrawal.source_not_outgoing";
const ERR_ACCOUNT_NOT_CASH: &str = "withdrawal.account_not_cash";
const ERR_INVALID_AMOUNT: &str = "withdrawal.invalid_amount";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashWithdrawalResult {
    pub new_transaction: Transaction,
    pub link: TxnLink,
}

#[derive(Debug)]
struct SourceSnapshot {
    account_id: i64,
    occurred_at_utc: String,
    credit: i64,
    debit: i64,
}

fn load_source(conn: &Connection, txn_id: i64) -> rusqlite::Result<Option<SourceSnapshot>> {
    conn.query_row(
        "SELECT account_id, occurred_at_utc, credit, debit
           FROM transactions WHERE id = ?1",
        [txn_id],
        |r| {
            Ok(SourceSnapshot {
                account_id: r.get(0)?,
                occurred_at_utc: r.get(1)?,
                credit: r.get(2)?,
                debit: r.get(3)?,
            })
        },
    )
    .optional()
}

/// Add one second to an ISO-8601 timestamp and re-serialise in the same
/// `YYYY-MM-DDTHH:MM:SS.sssZ` style the rest of the codebase uses for
/// cash transactions.
fn plus_one_second(occurred_at: &str) -> Result<String, String> {
    let dt = DateTime::parse_from_rfc3339(occurred_at.trim())
        .map_err(|e| format!("invalid source timestamp '{occurred_at}': {e}"))?;
    let next = dt
        .checked_add_signed(Duration::seconds(1))
        .ok_or_else(|| "timestamp overflow when adding 1 second".to_string())?;
    Ok(next
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Returns true if the target cash account exists. The kind check raises a
/// distinct error from "not found" so the frontend can show a more useful
/// message when the user picked, say, a bank account by mistake.
fn ensure_cash_or(conn: &Connection, account_id: i64) -> Result<(), String> {
    // `ensure_cash_account` returns generic "does not exist" / "is of kind X"
    // messages. Translate them to our stable error codes.
    match ensure_cash_account(conn, account_id) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Distinguish missing vs wrong kind for the frontend.
            let kind: Option<String> = conn
                .query_row(
                    "SELECT kind FROM accounts WHERE id = ?1",
                    [account_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match kind {
                None => Err(ERR_NOT_FOUND.to_string()),
                Some(_) => Err(ERR_ACCOUNT_NOT_CASH.to_string()),
            }
        }
    }
}

pub fn create_cash_withdrawal(
    state: State<'_, DbState>,
    source_txn_id: i64,
    cash_account_id: i64,
    amount: String,
) -> Result<CashWithdrawalResult, String> {
    // Parse + validate amount first — cheap, no DB needed.
    let amount_minor = money::parse_minor(&amount).map_err(|_| ERR_INVALID_AMOUNT.to_string())?;
    if amount_minor <= 0 {
        return Err(ERR_INVALID_AMOUNT.to_string());
    }

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;

    let source = load_source(conn, source_txn_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ERR_NOT_FOUND.to_string())?;

    // Source must be outgoing — debit > 0, credit == 0. An ATM withdrawal
    // is a debit; this is the only direction that makes semantic sense for
    // "withdraw to cash".
    if source.debit <= 0 || source.credit != 0 {
        return Err(ERR_SOURCE_NOT_OUTGOING.to_string());
    }

    ensure_cash_or(conn, cash_account_id)?;

    if source.account_id == cash_account_id {
        return Err(ERR_SAME_ACCOUNT.to_string());
    }

    if is_already_linked(conn, source_txn_id).map_err(|e| e.to_string())? {
        return Err(ERR_ALREADY_LINKED.to_string());
    }

    let new_occurred_at = plus_one_second(&source.occurred_at_utc)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let new_id = insert_cash_transaction_row(
        &tx,
        cash_account_id,
        &new_occurred_at,
        amount_minor, // credit
        0,            // debit
        None,         // peer — intentionally empty per product spec
        None,         // comment
    )?;
    let link = insert_link_unchecked(&tx, source_txn_id, new_id)?;
    tx.commit().map_err(|e| e.to_string())?;

    let new_transaction = fetch_transaction(conn, new_id)?;
    Ok(CashWithdrawalResult {
        new_transaction,
        link,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::{params, Connection};
    use tempfile::TempDir;

    struct Fx {
        _dir: TempDir,
        conn: Connection,
        bank_account: i64,
        bank_batch: i64,
        cash_account: i64,
    }

    fn fx() -> Fx {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let bank_account: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
                 VALUES ('Bank', 'bank', 'Bank', 'THB', '1', 'me') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let bank_batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                   (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-05-20T10:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [bank_account],
                |r| r.get(0),
            )
            .unwrap();
        let cash_account: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
                 VALUES ('Cash', 'cash', 'Cash', 'THB', NULL, NULL) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        Fx { _dir: dir, conn, bank_account, bank_batch, cash_account }
    }

    fn insert_bank_txn(fx: &Fx, occurred_at: &str, credit: i64, debit: i64) -> i64 {
        fx.conn
            .query_row(
                "INSERT INTO transactions
                   (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0) RETURNING id",
                params![fx.bank_account, fx.bank_batch, occurred_at, credit, debit],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// Same body as `create_cash_withdrawal`, but takes a `&mut Connection`
    /// directly so tests don't need a Tauri `State<'_>` wrapper.
    fn create(
        conn: &mut Connection,
        source_txn_id: i64,
        cash_account_id: i64,
        amount: &str,
    ) -> Result<CashWithdrawalResult, String> {
        let amount_minor =
            money::parse_minor(amount).map_err(|_| ERR_INVALID_AMOUNT.to_string())?;
        if amount_minor <= 0 {
            return Err(ERR_INVALID_AMOUNT.to_string());
        }
        let source = load_source(conn, source_txn_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| ERR_NOT_FOUND.to_string())?;
        if source.debit <= 0 || source.credit != 0 {
            return Err(ERR_SOURCE_NOT_OUTGOING.to_string());
        }
        ensure_cash_or(conn, cash_account_id)?;
        if source.account_id == cash_account_id {
            return Err(ERR_SAME_ACCOUNT.to_string());
        }
        if is_already_linked(conn, source_txn_id).map_err(|e| e.to_string())? {
            return Err(ERR_ALREADY_LINKED.to_string());
        }
        let new_occurred_at = plus_one_second(&source.occurred_at_utc)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let new_id = insert_cash_transaction_row(
            &tx,
            cash_account_id,
            &new_occurred_at,
            amount_minor,
            0,
            None,
            None,
        )?;
        let link = insert_link_unchecked(&tx, source_txn_id, new_id)?;
        tx.commit().map_err(|e| e.to_string())?;
        let new_transaction = fetch_transaction(conn, new_id)?;
        Ok(CashWithdrawalResult { new_transaction, link })
    }

    #[test]
    fn happy_path_creates_credit_and_link_with_offset_timestamp() {
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 0, 3014_00);

        let result = create(&mut f.conn, source, f.cash_account, "3014.00").unwrap();

        // New txn is on the cash account, credit-only, with placeholder
        // balance overwritten by the recompute.
        assert_eq!(result.new_transaction.account_id, f.cash_account);
        assert_eq!(result.new_transaction.credit, "3014.00");
        assert_eq!(result.new_transaction.debit, "0.00");
        assert_eq!(result.new_transaction.balance, "3014.00");
        // +1 second exactly.
        assert_eq!(
            result.new_transaction.occurred_at_utc,
            "2026-05-20T09:00:01.000Z"
        );
        // No metadata bleed-through.
        assert!(result.new_transaction.peer.is_none());
        assert!(result.new_transaction.comment.is_none());

        // Link covers both sides, canonical lo < hi.
        assert_eq!(result.link.txn_a_id, source.min(result.new_transaction.id));
        assert_eq!(result.link.txn_b_id, source.max(result.new_transaction.id));
    }

    #[test]
    fn happy_path_supports_cross_currency_amount() {
        // Cash account is THB, source is THB, but the user could have
        // adjusted the amount to a different value than the source debit.
        // The backend doesn't enforce 1:1 — that's a UI concern.
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 0, 90_00);

        let result = create(&mut f.conn, source, f.cash_account, "3014.00").unwrap();
        assert_eq!(result.new_transaction.credit, "3014.00");
    }

    #[test]
    fn rejects_incoming_source() {
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 1000_00, 0);
        let err = create(&mut f.conn, source, f.cash_account, "1000.00").unwrap_err();
        assert_eq!(err, ERR_SOURCE_NOT_OUTGOING);
    }

    #[test]
    fn rejects_missing_source() {
        let mut f = fx();
        let err = create(&mut f.conn, 99_999, f.cash_account, "100.00").unwrap_err();
        assert_eq!(err, ERR_NOT_FOUND);
    }

    #[test]
    fn rejects_non_cash_account() {
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 0, 100_00);
        // Use the BANK account as the "cash" target — must be rejected.
        let err = create(&mut f.conn, source, f.bank_account, "100.00").unwrap_err();
        // bank_account exists but is the wrong kind, AND it's the same
        // account as the source — either rejection is acceptable, but
        // `ensure_cash_or` runs first.
        assert_eq!(err, ERR_ACCOUNT_NOT_CASH);
    }

    #[test]
    fn rejects_already_linked_source() {
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 0, 500_00);
        // First call succeeds…
        create(&mut f.conn, source, f.cash_account, "500.00").unwrap();
        // …second must fail because the source is now linked.
        let err = create(&mut f.conn, source, f.cash_account, "500.00").unwrap_err();
        assert_eq!(err, ERR_ALREADY_LINKED);
    }

    #[test]
    fn rejects_zero_amount() {
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 0, 100_00);
        let err = create(&mut f.conn, source, f.cash_account, "0").unwrap_err();
        assert_eq!(err, ERR_INVALID_AMOUNT);
    }

    #[test]
    fn rejects_negative_amount() {
        let mut f = fx();
        let source = insert_bank_txn(&f, "2026-05-20T09:00:00.000Z", 0, 100_00);
        let err = create(&mut f.conn, source, f.cash_account, "-10.00").unwrap_err();
        assert_eq!(err, ERR_INVALID_AMOUNT);
    }

    #[test]
    fn plus_one_second_handles_millisecond_input() {
        let next = plus_one_second("2026-05-20T09:00:00.500Z").unwrap();
        assert_eq!(next, "2026-05-20T09:00:01.500Z");
    }

    #[test]
    fn plus_one_second_handles_timezone_input() {
        // Bank statements often arrive in a local-time-with-offset format;
        // the result must be normalised to UTC.
        let next = plus_one_second("2026-05-20T16:00:00+07:00").unwrap();
        assert_eq!(next, "2026-05-20T09:00:01.000Z");
    }
}
