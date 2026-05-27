//! Transfer-between-own-accounts links.
//!
//! Marks two transactions on different accounts as the two sides of one
//! internal transfer (debit on the source, credit on the destination). The
//! pair is stored canonicalised — the smaller id always lands in `txn_a_id`
//! — so callers don't have to care about argument order.
//!
//! Constraints enforced here:
//!   - Both transactions must exist.
//!   - They must live on different accounts.
//!   - One must be incoming (credit > 0), the other outgoing (debit > 0).
//!     Currency / amount equality is *not* required — a future cross-currency
//!     transfer should still be markable.
//!   - Neither side may already participate in another link.
//!
//! Categories on the underlying transactions are *not* touched. The two
//! semantics coexist: the link tells the report "this is an internal
//! transfer", the categories carry whatever the user assigned. Report-side
//! exclusion logic lives in [`crate::reports`].

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnLink {
    pub id: i64,
    pub txn_a_id: i64,
    pub txn_b_id: i64,
}

#[derive(Debug)]
struct TxnSnapshot {
    account_id: i64,
    credit: i64,
    debit: i64,
}

fn load_snapshot(conn: &Connection, txn_id: i64) -> rusqlite::Result<Option<TxnSnapshot>> {
    conn.query_row(
        "SELECT account_id, credit, debit FROM transactions WHERE id = ?1",
        [txn_id],
        |r| {
            Ok(TxnSnapshot {
                account_id: r.get(0)?,
                credit: r.get(1)?,
                debit: r.get(2)?,
            })
        },
    )
    .optional()
}

fn already_linked(conn: &Connection, txn_id: i64) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM transaction_links
         WHERE txn_a_id = ?1 OR txn_b_id = ?1",
        [txn_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Stable error codes returned across the Tauri boundary so the frontend can
/// localise messages without parsing English/Russian text.
pub(crate) const ERR_NOT_FOUND: &str = "link.txn_not_found";
const ERR_SAME_TXN: &str = "link.same_txn";
pub(crate) const ERR_SAME_ACCOUNT: &str = "link.same_account";
const ERR_SAME_DIRECTION: &str = "link.same_direction";
pub(crate) const ERR_ALREADY_LINKED: &str = "link.already_linked";

/// Canonicalise the pair `(a_id, b_id)` (smaller id first) and INSERT a link
/// row. Performs no validation — the caller is expected to have already
/// checked existence, account/direction/already-linked invariants. Used by
/// internal flows (e.g. `cash_withdrawals`) that build the pair themselves
/// and don't want the redundant validation cost.
pub(crate) fn insert_link_unchecked(
    tx: &Connection,
    a_id: i64,
    b_id: i64,
) -> Result<TxnLink, String> {
    let (lo, hi) = if a_id < b_id { (a_id, b_id) } else { (b_id, a_id) };
    let id: i64 = tx
        .query_row(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2) RETURNING id",
            params![lo, hi],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(TxnLink {
        id,
        txn_a_id: lo,
        txn_b_id: hi,
    })
}

/// Check if `txn_id` already participates in any link. Public to the crate so
/// other flows that create links can short-circuit before doing other work.
pub(crate) fn is_already_linked(conn: &Connection, txn_id: i64) -> rusqlite::Result<bool> {
    already_linked(conn, txn_id)
}

#[tauri::command]
pub fn link_transactions(
    state: State<'_, DbState>,
    a_id: i64,
    b_id: i64,
) -> Result<TxnLink, String> {
    if a_id == b_id {
        return Err(ERR_SAME_TXN.to_string());
    }
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let a = load_snapshot(&tx, a_id).map_err(|e| e.to_string())?;
    let b = load_snapshot(&tx, b_id).map_err(|e| e.to_string())?;
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err(ERR_NOT_FOUND.to_string()),
    };
    if a.account_id == b.account_id {
        return Err(ERR_SAME_ACCOUNT.to_string());
    }
    let a_is_incoming = a.credit > 0;
    let b_is_incoming = b.credit > 0;
    if a_is_incoming == b_is_incoming || a.credit + a.debit == 0 || b.credit + b.debit == 0 {
        return Err(ERR_SAME_DIRECTION.to_string());
    }
    if already_linked(&tx, a_id).map_err(|e| e.to_string())?
        || already_linked(&tx, b_id).map_err(|e| e.to_string())?
    {
        return Err(ERR_ALREADY_LINKED.to_string());
    }

    let link = insert_link_unchecked(&tx, a_id, b_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(link)
}

/// Drops the link involving `transaction_id`, if any. Returns Ok even when no
/// link exists — callers treat the post-condition (no link on this txn) as
/// the success criterion.
#[tauri::command]
pub fn unlink_transaction(state: State<'_, DbState>, transaction_id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM transaction_links WHERE txn_a_id = ?1 OR txn_b_id = ?1",
        [transaction_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_transaction_links(
    state: State<'_, DbState>,
    account_ids: Option<Vec<i64>>,
) -> Result<Vec<TxnLink>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let ids = account_ids.unwrap_or_default();
    if ids.is_empty() {
        let mut stmt = conn
            .prepare("SELECT id, txn_a_id, txn_b_id FROM transaction_links ORDER BY id ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TxnLink {
                    id: r.get(0)?,
                    txn_a_id: r.get(1)?,
                    txn_b_id: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        return rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string());
    }
    // Return any link where AT LEAST one side touches the selected accounts —
    // the frontend uses this to render the chain icon and partner-row hover
    // even when one half of the link is filtered out by account selection.
    let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{i}")).collect();
    let placeholders_b: Vec<String> = (1..=ids.len()).map(|i| format!("?{}", i + ids.len())).collect();
    let sql = format!(
        "SELECT DISTINCT l.id, l.txn_a_id, l.txn_b_id FROM transaction_links l
         JOIN transactions ta ON ta.id = l.txn_a_id
         JOIN transactions tb ON tb.id = l.txn_b_id
         WHERE ta.account_id IN ({}) OR tb.account_id IN ({})
         ORDER BY l.id ASC",
        placeholders.join(","),
        placeholders_b.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(ids.len() * 2);
    for id in &ids {
        params_vec.push(Box::new(*id));
    }
    for id in &ids {
        params_vec.push(Box::new(*id));
    }
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |r| {
            Ok(TxnLink {
                id: r.get(0)?,
                txn_a_id: r.get(1)?,
                txn_b_id: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::{Connection, params};
    use tempfile::TempDir;

    struct Fx {
        _dir: TempDir,
        conn: Connection,
        acc_a: i64,
        acc_b: i64,
        batch_a: i64,
        batch_b: i64,
    }

    fn fx() -> Fx {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let acc_a: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'USD', 'a', 'O') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let acc_b: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'USD', 'b', 'O') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch_a: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [acc_a],
                |r| r.get(0),
            )
            .unwrap();
        let batch_b: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [acc_b],
                |r| r.get(0),
            )
            .unwrap();
        Fx { _dir: dir, conn, acc_a, acc_b, batch_a, batch_b }
    }

    fn insert_txn(
        conn: &Connection,
        account_id: i64,
        batch_id: i64,
        credit: i64,
        debit: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO transactions
             (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
             VALUES (?1, ?2, '2026-04-15T10:00:00Z', ?3, ?4, 0) RETURNING id",
            params![account_id, batch_id, credit, debit],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn link(fx: &mut Fx, a: i64, b: i64) -> Result<TxnLink, String> {
        // Mimic the tauri command body without the State<'_> wrapper.
        let conn = &mut fx.conn;
        if a == b {
            return Err(ERR_SAME_TXN.to_string());
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let sa = load_snapshot(&tx, a).map_err(|e| e.to_string())?;
        let sb = load_snapshot(&tx, b).map_err(|e| e.to_string())?;
        let (sa, sb) = match (sa, sb) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err(ERR_NOT_FOUND.to_string()),
        };
        if sa.account_id == sb.account_id {
            return Err(ERR_SAME_ACCOUNT.to_string());
        }
        let a_in = sa.credit > 0;
        let b_in = sb.credit > 0;
        if a_in == b_in || sa.credit + sa.debit == 0 || sb.credit + sb.debit == 0 {
            return Err(ERR_SAME_DIRECTION.to_string());
        }
        if already_linked(&tx, a).map_err(|e| e.to_string())?
            || already_linked(&tx, b).map_err(|e| e.to_string())?
        {
            return Err(ERR_ALREADY_LINKED.to_string());
        }
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let id: i64 = tx
            .query_row(
                "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2) RETURNING id",
                params![lo, hi],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(TxnLink {
            id,
            txn_a_id: lo,
            txn_b_id: hi,
        })
    }

    #[test]
    fn happy_path_links_canonical_pair() {
        let mut f = fx();
        let out_a = insert_txn(&f.conn, f.acc_a, f.batch_a, 0, 100_00);
        let in_b = insert_txn(&f.conn, f.acc_b, f.batch_b, 100_00, 0);
        let link_record = link(&mut f, in_b, out_a).unwrap(); // pass in reverse
        assert_eq!(link_record.txn_a_id, out_a.min(in_b));
        assert_eq!(link_record.txn_b_id, out_a.max(in_b));
    }

    #[test]
    fn rejects_same_txn() {
        let mut f = fx();
        let t = insert_txn(&f.conn, f.acc_a, f.batch_a, 100_00, 0);
        let err = link(&mut f, t, t).unwrap_err();
        assert_eq!(err, ERR_SAME_TXN);
    }

    #[test]
    fn rejects_missing_txn() {
        let mut f = fx();
        let t = insert_txn(&f.conn, f.acc_a, f.batch_a, 100_00, 0);
        let err = link(&mut f, t, 9_999).unwrap_err();
        assert_eq!(err, ERR_NOT_FOUND);
    }

    #[test]
    fn rejects_same_account() {
        let mut f = fx();
        let a = insert_txn(&f.conn, f.acc_a, f.batch_a, 100_00, 0);
        let b = insert_txn(&f.conn, f.acc_a, f.batch_a, 0, 100_00);
        let err = link(&mut f, a, b).unwrap_err();
        assert_eq!(err, ERR_SAME_ACCOUNT);
    }

    #[test]
    fn rejects_same_direction() {
        let mut f = fx();
        let a = insert_txn(&f.conn, f.acc_a, f.batch_a, 100_00, 0); // incoming
        let b = insert_txn(&f.conn, f.acc_b, f.batch_b, 50_00, 0); // also incoming
        let err = link(&mut f, a, b).unwrap_err();
        assert_eq!(err, ERR_SAME_DIRECTION);
    }

    #[test]
    fn rejects_when_either_side_already_linked() {
        let mut f = fx();
        let out_a = insert_txn(&f.conn, f.acc_a, f.batch_a, 0, 100_00);
        let in_b = insert_txn(&f.conn, f.acc_b, f.batch_b, 100_00, 0);
        let in_b2 = insert_txn(&f.conn, f.acc_b, f.batch_b, 50_00, 0);
        link(&mut f, out_a, in_b).unwrap();
        // Now try to link out_a with a different incoming — must fail.
        let err = link(&mut f, out_a, in_b2).unwrap_err();
        assert_eq!(err, ERR_ALREADY_LINKED);
    }

    #[test]
    fn cascade_delete_removes_link_when_txn_dropped() {
        let mut f = fx();
        let out_a = insert_txn(&f.conn, f.acc_a, f.batch_a, 0, 100_00);
        let in_b = insert_txn(&f.conn, f.acc_b, f.batch_b, 100_00, 0);
        link(&mut f, out_a, in_b).unwrap();
        // Drop the parent batch on side A → its txn cascades, link must follow.
        f.conn
            .execute("DELETE FROM import_batches WHERE id = ?1", [f.batch_a])
            .unwrap();
        let n: i64 = f
            .conn
            .query_row("SELECT COUNT(*) FROM transaction_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "ON DELETE CASCADE should drop the link");
    }

    #[test]
    fn unlink_is_idempotent() {
        let mut f = fx();
        let out_a = insert_txn(&f.conn, f.acc_a, f.batch_a, 0, 100_00);
        let in_b = insert_txn(&f.conn, f.acc_b, f.batch_b, 100_00, 0);
        link(&mut f, out_a, in_b).unwrap();
        // First unlink succeeds.
        f.conn
            .execute(
                "DELETE FROM transaction_links WHERE txn_a_id = ?1 OR txn_b_id = ?1",
                [out_a],
            )
            .unwrap();
        // Second unlink is a no-op, no error.
        f.conn
            .execute(
                "DELETE FROM transaction_links WHERE txn_a_id = ?1 OR txn_b_id = ?1",
                [out_a],
            )
            .unwrap();
        // After both sides freed: relinking is allowed again.
        link(&mut f, out_a, in_b).unwrap();
    }

    #[test]
    fn check_constraint_blocks_unordered_pair_in_db() {
        let f = fx();
        let out_a = insert_txn(&f.conn, f.acc_a, f.batch_a, 0, 100_00);
        let in_b = insert_txn(&f.conn, f.acc_b, f.batch_b, 100_00, 0);
        // Direct INSERT bypassing canonicalisation must trip the CHECK
        // (txn_a_id < txn_b_id).
        let res = f.conn.execute(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
            params![out_a.max(in_b), out_a.min(in_b)],
        );
        assert!(res.is_err(), "CHECK should block reversed pair");
    }
}
