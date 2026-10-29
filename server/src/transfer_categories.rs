//! The two system "transfer between own accounts" categories (`<<--->>`): one
//! income, one expense. See `docs/plans/transfer-categories.md`.
//!
//! - They exist always: created at startup and after a wipe, kept at the top
//!   level, cannot be deleted or moved (`categories.rs`).
//! - Every **new** link — a transfer between own accounts or a cash
//!   withdrawal — puts them on both sides that have no category yet (income
//!   side → income one, expense side → expense one). The user may reassign.
//! - Unlinking takes them off again, but only where the transaction still has
//!   exactly that category; a category the user chose stays.
//! - The category agent never sees them (linked transactions are not its
//!   business, and they must not be suggested for ordinary ones).

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::suggestions::Lang;

pub(crate) const KEY_INCOME: &str = "transfer_income";
pub(crate) const KEY_EXPENSE: &str = "transfer_expense";
const NAME: &str = "<<--->>";
const COLOR: &str = "#9ca3af";

/// Create the two categories if they are missing. A top-level category the
/// user already called `<<--->>` of the same kind is adopted instead of
/// duplicated.
pub(crate) fn ensure_system_categories(conn: &Connection) -> rusqlite::Result<()> {
    let description = Lang::of(conn).pick(
        "Так отмечаются все переводы между собственными счетами и выводы в кэш. Ставится \
автоматически, когда транзакции связываются; можно заменить на другую категорию. Удалить нельзя.",
        "All transfers between own accounts and cash withdrawals are marked like this. Set \
automatically when transactions are linked; you may replace it with another category. Cannot be deleted.",
    );
    for (key, kind) in [(KEY_INCOME, "income"), (KEY_EXPENSE, "expense")] {
        let exists: bool =
            conn.query_row("SELECT EXISTS (SELECT 1 FROM categories WHERE system_key = ?1)", [key], |r| r.get(0))?;
        if exists {
            continue;
        }
        let adopted = conn.execute(
            "UPDATE categories SET system_key = ?1
             WHERE id = (SELECT id FROM categories
                         WHERE parent_id IS NULL AND kind = ?2 AND name = ?3 AND system_key IS NULL
                         LIMIT 1)",
            params![key, kind, NAME],
        )?;
        if adopted == 0 {
            conn.execute(
                "INSERT INTO categories (name, color, kind, parent_id, description, system_key)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                params![NAME, COLOR, kind, description, key],
            )?;
        }
    }
    Ok(())
}

/// Ids of the system categories (for whoever has to leave them out).
pub(crate) fn system_category_ids(conn: &Connection) -> rusqlite::Result<HashSet<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM categories WHERE system_key IS NOT NULL")?;
    let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<HashSet<i64>>>()?;
    Ok(ids)
}

fn system_category(conn: &Connection, key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM categories WHERE system_key = ?1", [key], |r| r.get(0))
        .optional()
}

/// A new link between `a` and `b`: each side without a category gets the
/// transfer category of its direction, for its whole amount.
pub(crate) fn assign_on_link(conn: &Connection, a: i64, b: i64) -> rusqlite::Result<()> {
    for txn in [a, b] {
        let row: Option<(i64, i64, bool)> = conn
            .query_row(
                "SELECT credit, debit,
                        EXISTS (SELECT 1 FROM transaction_categories WHERE transaction_id = t.id)
                 FROM transactions t WHERE id = ?1",
                [txn],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((credit, debit, categorised)) = row else { continue };
        if categorised || credit + debit == 0 {
            continue;
        }
        let key = if credit > 0 { KEY_INCOME } else { KEY_EXPENSE };
        let Some(category) = system_category(conn, key)? else { continue };
        conn.execute(
            "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
             VALUES (?1, ?2, ?3, 0)",
            params![txn, category, credit + debit],
        )?;
    }
    Ok(())
}

/// The link of these transactions is going away: drop the transfer category
/// where it is still the transaction's only category.
pub(crate) fn clear_on_unlink(conn: &Connection, txns: &[i64]) -> rusqlite::Result<()> {
    for &txn in txns {
        conn.execute(
            "DELETE FROM transaction_categories
             WHERE transaction_id = ?1
               AND (SELECT COUNT(*) FROM transaction_categories WHERE transaction_id = ?1) = 1
               AND category_id IN (SELECT id FROM categories WHERE system_key IS NOT NULL)",
            [txn],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn setup() -> (TempDir, crate::db::DbState, i64, i64) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        ensure_system_categories(&conn).unwrap();
        let account = |name: &str| -> i64 {
            conn.query_row(
                "INSERT INTO accounts (name, kind, bank, currency) VALUES (?1, 'bank', 'KBank', 'THB') RETURNING id",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        let (a, b) = (account("A"), account("B"));
        (dir, Mutex::new(conn), a, b)
    }

    fn txn(state: &crate::db::DbState, account: i64, credit: i64, debit: i64) -> i64 {
        state
            .lock()
            .unwrap()
            .query_row(
                "INSERT INTO transactions (account_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, '2026-05-01T03:00:00.000Z', ?2, ?3, 0) RETURNING id",
                params![account, credit, debit],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn categories_of(state: &crate::db::DbState, txn: i64) -> Vec<(Option<String>, i64)> {
        let conn = state.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT c.system_key, tc.share_minor FROM transaction_categories tc
                 JOIN categories c ON c.id = tc.category_id WHERE tc.transaction_id = ?1",
            )
            .unwrap();
        stmt.query_map([txn], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn system_categories_are_created_once_and_adopt_a_same_named_one() {
        let (_dir, state, ..) = setup();
        let conn = state.lock().unwrap();
        ensure_system_categories(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories WHERE system_key IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        // After a wipe, an existing user category named <<--->> is adopted.
        conn.execute("DELETE FROM categories", []).unwrap();
        conn.execute("INSERT INTO categories (name, color, kind) VALUES ('<<--->>', '#000000', 'income')", [])
            .unwrap();
        ensure_system_categories(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn linking_sets_and_unlinking_clears_the_transfer_categories() {
        let (_dir, state, a, b) = setup();
        let out = txn(&state, a, 0, 5_000);
        let inc = txn(&state, b, 5_000, 0);
        crate::transaction_links::link_transactions(&state, out, inc).unwrap();
        assert_eq!(categories_of(&state, out), vec![(Some(KEY_EXPENSE.to_string()), 5_000)]);
        assert_eq!(categories_of(&state, inc), vec![(Some(KEY_INCOME.to_string()), 5_000)]);

        // The user reassigns one side; unlinking keeps that, clears the other.
        let food: i64 = state
            .lock()
            .unwrap()
            .query_row("INSERT INTO categories (name, color, kind) VALUES ('Food', '#888888', 'expense') RETURNING id", [], |r| {
                r.get(0)
            })
            .unwrap();
        crate::transaction_categories::set_transaction_categories(
            &state,
            out,
            vec![crate::transaction_categories::CategoryItem { category_id: food, share_minor: 5_000, position: 0 }],
        )
        .unwrap();
        crate::transaction_links::unlink_transaction(&state, inc).unwrap();
        assert_eq!(categories_of(&state, out), vec![(None, 5_000)]);
        assert!(categories_of(&state, inc).is_empty());
    }

    #[test]
    fn a_categorised_side_keeps_its_category_and_cash_withdrawals_get_it_too() {
        let (_dir, state, a, _) = setup();
        let cash: i64 = state
            .lock()
            .unwrap()
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency) VALUES ('Wallet', 'cash', '', 'THB') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let atm = txn(&state, a, 0, 2_000);
        let result = crate::cash_withdrawals::create_cash_withdrawal(&state, atm, cash, "20.00".into()).unwrap();
        assert_eq!(categories_of(&state, atm), vec![(Some(KEY_EXPENSE.to_string()), 2_000)]);
        assert_eq!(categories_of(&state, result.new_transaction.id), vec![(Some(KEY_INCOME.to_string()), 2_000)]);

        // A side the user had already categorised keeps its category.
        let gift: i64 = state
            .lock()
            .unwrap()
            .query_row("INSERT INTO categories (name, color, kind) VALUES ('Gift', '#888888', 'expense') RETURNING id", [], |r| {
                r.get(0)
            })
            .unwrap();
        let out = txn(&state, a, 0, 3_000);
        crate::transaction_categories::set_transaction_categories(
            &state,
            out,
            vec![crate::transaction_categories::CategoryItem { category_id: gift, share_minor: 3_000, position: 0 }],
        )
        .unwrap();
        let wallet_in = txn(&state, cash, 3_000, 0);
        crate::transaction_links::link_transactions(&state, out, wallet_in).unwrap();
        assert_eq!(categories_of(&state, out), vec![(None, 3_000)]);
        assert_eq!(categories_of(&state, wallet_in), vec![(Some(KEY_INCOME.to_string()), 3_000)]);
    }

    #[test]
    fn system_categories_cannot_be_deleted_or_moved() {
        let (_dir, state, ..) = setup();
        let (id, other): (i64, i64) = {
            let conn = state.lock().unwrap();
            let id = conn
                .query_row("SELECT id FROM categories WHERE system_key = ?1", [KEY_EXPENSE], |r| r.get(0))
                .unwrap();
            let other = conn
                .query_row(
                    "INSERT INTO categories (name, color, kind) VALUES ('Home', '#888888', 'expense') RETURNING id",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            (id, other)
        };
        assert_eq!(crate::categories::delete_category(&state, id).unwrap_err(), crate::categories::ERR_SYSTEM);
        let err = crate::categories::update_category(&state, id, NAME.into(), COLOR.into(), None, Some(other))
            .unwrap_err();
        assert_eq!(err, crate::categories::ERR_SYSTEM);
        // Renaming / recolouring is fine.
        crate::categories::update_category(&state, id, "Transfers".into(), "#123456".into(), None, None).unwrap();
    }
}
