//! CRUD for manually-entered cash transactions.
//!
//! Unlike bank accounts (where every row carries the bank-provided
//! after-operation balance and we only validate the chain), cash accounts
//! own their balance: every insert / update / delete recomputes the running
//! balance of the touched transaction and everything that follows it in
//! (`occurred_at_utc`, `id`) order — the same sort the listing uses.

use chrono::{DateTime, SecondsFormat};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use crate::host::State;

use crate::db::DbState;
use crate::money;
use crate::transactions::Transaction;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CashDirection {
    In,
    Out,
}

fn split_amount(direction: &CashDirection, amount: &str) -> Result<(i64, i64), String> {
    let minor = money::parse_minor(amount).map_err(|e| e.to_string())?;
    if minor < 0 {
        return Err("amount must be non-negative".to_string());
    }
    Ok(match direction {
        CashDirection::In => (minor, 0),
        CashDirection::Out => (0, minor),
    })
}

pub(crate) fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub(crate) fn normalize_occurred_at(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let dt = DateTime::parse_from_rfc3339(trimmed)
        .map_err(|e| format!("invalid occurred_at '{trimmed}': {e}"))?;
    Ok(dt
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub(crate) fn ensure_cash_account(conn: &Connection, account_id: i64) -> Result<(), String> {
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM accounts WHERE id = ?1",
            [account_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match kind.as_deref() {
        Some("cash") => Ok(()),
        Some(other) => Err(format!(
            "account {account_id} is of kind '{other}', not 'cash'"
        )),
        None => Err(format!("account {account_id} does not exist")),
    }
}

fn ensure_cash_transaction(
    conn: &Connection,
    txn_id: i64,
) -> Result<(i64, String), String> {
    let row: Option<(i64, String, Option<String>)> = conn
        .query_row(
            "SELECT t.account_id, t.occurred_at_utc, a.kind
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             WHERE t.id = ?1",
            [txn_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Err(format!("transaction {txn_id} does not exist")),
        Some((_, _, kind)) if kind.as_deref() != Some("cash") => Err(format!(
            "transaction {txn_id} does not belong to a cash account"
        )),
        Some((account_id, occurred_at, _)) => Ok((account_id, occurred_at)),
    }
}

pub(crate) fn fetch_transaction(conn: &Connection, txn_id: i64) -> Result<Transaction, String> {
    conn.query_row(
        "SELECT id, account_id, import_batch_id, occurred_at_utc, credit, debit, balance,
                peer, bank_description, comment, is_correcting
         FROM transactions WHERE id = ?1",
        [txn_id],
        |r| {
            let credit: i64 = r.get(4)?;
            let debit: i64 = r.get(5)?;
            let balance: i64 = r.get(6)?;
            Ok(Transaction {
                id: r.get(0)?,
                account_id: r.get(1)?,
                import_batch_id: r.get(2)?,
                occurred_at_utc: r.get(3)?,
                credit: money::format_minor(credit),
                debit: money::format_minor(debit),
                balance: money::format_minor(balance),
                peer: r.get(7)?,
                bank_description: r.get(8)?,
                comment: r.get(9)?,
                is_correcting: r.get(10)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Recompute the running balance for `account_id` starting from `from_utc`.
/// The starting balance is the balance of the most recent transaction with
/// `occurred_at_utc < from_utc` (or 0 if none). Then we walk every
/// transaction at or after `from_utc` in `(occurred_at_utc, id)` order — the
/// same order `list_transactions` uses — and rewrite its `balance` column
/// as `running + credit - debit`.
pub(crate) fn recompute_cash_balances(
    conn: &Connection,
    account_id: i64,
    from_utc: &str,
) -> rusqlite::Result<()> {
    let mut running: i64 = conn
        .query_row(
            "SELECT balance FROM transactions
             WHERE account_id = ?1 AND occurred_at_utc < ?2
             ORDER BY occurred_at_utc DESC, id DESC
             LIMIT 1",
            params![account_id, from_utc],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);

    let mut stmt = conn.prepare(
        "SELECT id, credit, debit FROM transactions
         WHERE account_id = ?1 AND occurred_at_utc >= ?2
         ORDER BY occurred_at_utc ASC, id ASC",
    )?;
    let rows: Vec<(i64, i64, i64)> = stmt
        .query_map(params![account_id, from_utc], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let mut update = conn.prepare("UPDATE transactions SET balance = ?1 WHERE id = ?2")?;
    for (id, credit, debit) in rows {
        running = running + credit - debit;
        update.execute(params![running, id])?;
    }
    Ok(())
}

/// Insert one cash transaction row inside an already-open SQL transaction and
/// recompute the running balance for the touched account from this point
/// forward. Returns the new row id. The caller owns the SQL transaction (open,
/// commit, rollback) and is expected to have already validated that
/// `account_id` belongs to a cash account.
///
/// `credit` and `debit` are in minor units (e.g. cents); exactly one of them
/// must be non-zero for a normal entry. Both zero is allowed by the schema
/// but doesn't make sense semantically — callers should reject earlier.
pub(crate) fn insert_cash_transaction_row(
    tx: &Connection,
    account_id: i64,
    occurred_at_utc: &str,
    credit: i64,
    debit: i64,
    peer: Option<&str>,
    comment: Option<&str>,
) -> Result<i64, String> {
    let new_id = insert_cash_row(tx, account_id, occurred_at_utc, credit, debit, peer, comment)?;
    recompute_cash_balances(tx, account_id, occurred_at_utc).map_err(|e| e.to_string())?;
    Ok(new_id)
}

/// The bare insert, with a placeholder balance: the caller recomputes the
/// running balance — once, from the earliest row, when it inserts many.
pub(crate) fn insert_cash_row(
    tx: &Connection,
    account_id: i64,
    occurred_at_utc: &str,
    credit: i64,
    debit: i64,
    peer: Option<&str>,
    comment: Option<&str>,
) -> Result<i64, String> {
    tx
        .query_row(
            "INSERT INTO transactions
                (account_id, import_batch_id, occurred_at_utc,
                 credit, debit, balance,
                 peer, bank_description, comment, is_correcting)
             VALUES (?1, NULL, ?2, ?3, ?4, 0, ?5, NULL, ?6, 0)
             RETURNING id",
            params![account_id, occurred_at_utc, credit, debit, peer, comment],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
}

pub fn create_cash_transaction(
    state: State<'_, DbState>,
    account_id: i64,
    occurred_at_utc: String,
    direction: CashDirection,
    amount: String,
    peer: Option<String>,
    comment: Option<String>,
) -> Result<Transaction, String> {
    let occurred_at = normalize_occurred_at(&occurred_at_utc)?;
    let (credit, debit) = split_amount(&direction, &amount)?;
    let peer = normalize_optional(peer);
    let comment = normalize_optional(comment);

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;

    ensure_cash_account(conn, account_id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let new_id = insert_cash_transaction_row(
        &tx,
        account_id,
        &occurred_at,
        credit,
        debit,
        peer.as_deref(),
        comment.as_deref(),
    )?;
    tx.commit().map_err(|e| e.to_string())?;

    fetch_transaction(conn, new_id)
}

pub fn update_cash_transaction(
    state: State<'_, DbState>,
    id: i64,
    occurred_at_utc: String,
    direction: CashDirection,
    amount: String,
    peer: Option<String>,
    comment: Option<String>,
) -> Result<Transaction, String> {
    let occurred_at = normalize_occurred_at(&occurred_at_utc)?;
    let (credit, debit) = split_amount(&direction, &amount)?;
    let peer = normalize_optional(peer);
    let comment = normalize_optional(comment);

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;

    let (account_id, old_occurred_at) = ensure_cash_transaction(conn, id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE transactions
            SET occurred_at_utc = ?1,
                credit = ?2,
                debit  = ?3,
                peer = ?4,
                comment = ?5
          WHERE id = ?6",
        params![occurred_at, credit, debit, peer, comment, id],
    )
    .map_err(|e| e.to_string())?;

    // Recompute starting from whichever timestamp is earlier — a move
    // backwards in time means earlier rows are now downstream of this txn,
    // a move forward means the old slot needs its tail rewritten.
    let from = if old_occurred_at.as_str() < occurred_at.as_str() {
        old_occurred_at
    } else {
        occurred_at.clone()
    };
    recompute_cash_balances(&tx, account_id, &from).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    fetch_transaction(conn, id)
}

pub fn delete_cash_transaction(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;

    let (account_id, occurred_at) = ensure_cash_transaction(conn, id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    delete_row(&tx, id)?;
    recompute_cash_balances(&tx, account_id, &occurred_at).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete one cash transaction row. Its link (a cash withdrawal or a transfer)
/// goes with it by cascade; the partner on the other account is then no
/// longer linked, so it loses the `<<--->>` transfer category the same way an
/// unlink takes it off (`transfer_categories::clear_on_unlink`).
fn delete_row(tx: &Connection, id: i64) -> Result<(), String> {
    let partner: Option<i64> = tx
        .query_row(
            "SELECT CASE WHEN txn_a_id = ?1 THEN txn_b_id ELSE txn_a_id END
             FROM transaction_links WHERE txn_a_id = ?1 OR txn_b_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM transactions WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if let Some(partner) = partner {
        crate::transfer_categories::clear_on_unlink(tx, &[partner]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCashSummary {
    pub deleted: usize,
    /// Selected rows that are not on a cash account — never deleted here.
    pub skipped_not_cash: usize,
}

/// Bulk delete for the Transactions screen (Actions ▾ → Manual): only rows of
/// cash accounts go; bank rows in the selection are skipped. One SQL
/// transaction; each touched cash account gets its running balance
/// recomputed once, from its earliest deleted row.
pub fn delete_cash_transactions(
    state: State<'_, DbState>,
    transaction_ids: Vec<i64>,
) -> Result<DeleteCashSummary, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut summary = DeleteCashSummary::default();
    let mut from_by_account: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for id in transaction_ids {
        let Ok((account_id, occurred_at)) = ensure_cash_transaction(&tx, id) else {
            summary.skipped_not_cash += 1;
            continue;
        };
        delete_row(&tx, id)?;
        summary.deleted += 1;
        let from = from_by_account.entry(account_id).or_insert_with(|| occurred_at.clone());
        if occurred_at < *from {
            *from = occurred_at;
        }
    }
    for (account_id, from) in &from_by_account {
        recompute_cash_balances(&tx, *account_id, from).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn make_cash_account(conn: &Connection) -> i64 {
        conn.query_row(
            "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
             VALUES ('Cash', 'cash', 'Cash', 'THB', NULL, NULL) RETURNING id",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn insert_cash_txn(
        conn: &Connection,
        account_id: i64,
        occurred_at: &str,
        credit: i64,
        debit: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO transactions
                (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, is_correcting)
             VALUES (?1, NULL, ?2, ?3, ?4, 0, 0) RETURNING id",
            params![account_id, occurred_at, credit, debit],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn balances(conn: &Connection, account_id: i64) -> Vec<i64> {
        conn.prepare(
            "SELECT balance FROM transactions
             WHERE account_id = ?1 ORDER BY occurred_at_utc, id",
        )
        .unwrap()
        .query_map([account_id], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    #[test]
    fn bulk_delete_takes_only_cash_rows_and_unlinks_the_partner() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        crate::transfer_categories::ensure_system_categories(&conn).unwrap();
        let cash = make_cash_account(&conn);
        let bank: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency) VALUES ('Main', 'bank', 'KBank', 'THB') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let state: DbState = std::sync::Mutex::new(conn);
        let atm: i64 = state
            .lock()
            .unwrap()
            .query_row(
                "INSERT INTO transactions (account_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, '2026-01-01T10:00:00.000Z', 0, 200000, 0) RETURNING id",
                [bank],
                |r| r.get(0),
            )
            .unwrap();
        let withdrawal = crate::cash_withdrawals::create_cash_withdrawal(&state, atm, cash, "2000.00".into()).unwrap();
        let spent = {
            let conn = state.lock().unwrap();
            let id = insert_cash_txn(&conn, cash, "2026-01-02T00:00:00.000Z", 0, 500_00);
            recompute_cash_balances(&conn, cash, "2026-01-01T00:00:00.000Z").unwrap();
            id
        };
        assert_eq!(balances(&state.lock().unwrap(), cash), vec![2000_00, 1500_00]);

        let summary = delete_cash_transactions(&state, vec![atm, withdrawal.new_transaction.id]).unwrap();
        assert_eq!((summary.deleted, summary.skipped_not_cash), (1, 1));
        let conn = state.lock().unwrap();
        // The bank side stays, unlinked and without the transfer category.
        let (links, cats): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM transaction_links),
                        (SELECT COUNT(*) FROM transaction_categories WHERE transaction_id = ?1)",
                [atm],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((links, cats), (0, 0));
        // The cash balance after the deleted inflow is recomputed.
        assert_eq!(balances(&conn, cash), vec![-500_00]);
        assert!(conn.query_row("SELECT 1 FROM transactions WHERE id = ?1", [spent], |_| Ok(())).is_ok());
    }

    #[test]
    fn running_balance_after_insert_chain() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let account = make_cash_account(&conn);

        insert_cash_txn(&conn, account, "2026-01-01T00:00:00.000Z", 1000_00, 0);
        insert_cash_txn(&conn, account, "2026-01-02T00:00:00.000Z", 0, 300_00);
        insert_cash_txn(&conn, account, "2026-01-03T00:00:00.000Z", 50_00, 0);

        recompute_cash_balances(&conn, account, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(balances(&conn, account), vec![1000_00, 700_00, 750_00]);
    }

    #[test]
    fn recompute_handles_negative_balance() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let account = make_cash_account(&conn);

        insert_cash_txn(&conn, account, "2026-01-01T00:00:00.000Z", 0, 500_00);
        insert_cash_txn(&conn, account, "2026-01-02T00:00:00.000Z", 100_00, 0);

        recompute_cash_balances(&conn, account, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(balances(&conn, account), vec![-500_00, -400_00]);
    }

    #[test]
    fn insert_in_the_middle_recomputes_tail() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let account = make_cash_account(&conn);

        insert_cash_txn(&conn, account, "2026-01-01T00:00:00.000Z", 1000_00, 0);
        insert_cash_txn(&conn, account, "2026-01-03T00:00:00.000Z", 50_00, 0);
        recompute_cash_balances(&conn, account, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(balances(&conn, account), vec![1000_00, 1050_00]);

        insert_cash_txn(&conn, account, "2026-01-02T00:00:00.000Z", 0, 200_00);
        recompute_cash_balances(&conn, account, "2026-01-02T00:00:00.000Z").unwrap();
        assert_eq!(balances(&conn, account), vec![1000_00, 800_00, 850_00]);
    }

    #[test]
    fn delete_recomputes_tail() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let account = make_cash_account(&conn);

        let _a = insert_cash_txn(&conn, account, "2026-01-01T00:00:00.000Z", 1000_00, 0);
        let b = insert_cash_txn(&conn, account, "2026-01-02T00:00:00.000Z", 0, 200_00);
        let _c = insert_cash_txn(&conn, account, "2026-01-03T00:00:00.000Z", 50_00, 0);
        recompute_cash_balances(&conn, account, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(balances(&conn, account), vec![1000_00, 800_00, 850_00]);

        conn.execute("DELETE FROM transactions WHERE id = ?1", [b]).unwrap();
        recompute_cash_balances(&conn, account, "2026-01-02T00:00:00.000Z").unwrap();
        assert_eq!(balances(&conn, account), vec![1000_00, 1050_00]);
    }

    #[test]
    fn ensure_cash_rejects_bank_accounts() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let bank: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
                 VALUES ('B', 'bank', 'Bank', 'USD', '1', 'me') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ensure_cash_account(&conn, bank).is_err());
    }
}
