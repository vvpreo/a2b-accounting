use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use crate::host::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionCategoryView {
    pub transaction_id: i64,
    pub category_id: i64,
    pub share_minor: i64,
    pub position: i64,
    pub category_name: String,
    pub category_color: String,
    pub category_kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryItem {
    pub category_id: i64,
    pub share_minor: i64,
    pub position: i64,
}

fn from_view_row(row: &Row) -> rusqlite::Result<TransactionCategoryView> {
    Ok(TransactionCategoryView {
        transaction_id: row.get(0)?,
        category_id: row.get(1)?,
        share_minor: row.get(2)?,
        position: row.get(3)?,
        category_name: row.get(4)?,
        category_color: row.get(5)?,
        category_kind: row.get(6)?,
    })
}

const VIEW_COLUMNS: &str = "tc.transaction_id, tc.category_id, tc.share_minor, tc.position, \
                            c.name, c.color, c.kind";

fn set_categories_internal(
    conn: &Connection,
    transaction_id: i64,
    items: &[CategoryItem],
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;

    // 1. Transaction exists + load credit/debit.
    let txn = tx
        .query_row(
            "SELECT credit, debit FROM transactions WHERE id = ?1",
            [transaction_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("transaction {transaction_id} does not exist")
            }
            other => other.to_string(),
        })?;
    let (credit, debit) = txn;
    let total_minor = credit + debit;
    let direction = if credit > 0 { "income" } else { "expense" };

    // 2. Validate items: positive shares, unique ids/positions, sum <= total.
    let mut sum: i64 = 0;
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_positions = std::collections::HashSet::new();
    for item in items {
        if item.share_minor <= 0 {
            return Err(format!(
                "share_minor for category {} must be > 0",
                item.category_id
            ));
        }
        if !seen_ids.insert(item.category_id) {
            return Err(format!(
                "category {} appears more than once",
                item.category_id
            ));
        }
        if !seen_positions.insert(item.position) {
            return Err(format!("position {} appears more than once", item.position));
        }
        sum += item.share_minor;
    }
    if sum > total_minor {
        return Err(format!(
            "sum of shares {sum} exceeds transaction total {total_minor}"
        ));
    }

    // 3. Validate kind matches direction for every category in items.
    for item in items {
        let kind: String = tx
            .query_row(
                "SELECT kind FROM categories WHERE id = ?1",
                [item.category_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("category {} does not exist", item.category_id)
                }
                other => other.to_string(),
            })?;
        if kind != direction {
            return Err(format!(
                "category {} has kind '{kind}' but transaction direction is '{direction}'",
                item.category_id
            ));
        }
    }

    // 4. Replace existing rows atomically.
    tx.execute(
        "DELETE FROM transaction_categories WHERE transaction_id = ?1",
        [transaction_id],
    )
    .map_err(|e| e.to_string())?;

    for item in items {
        tx.execute(
            "INSERT INTO transaction_categories
             (transaction_id, category_id, share_minor, position)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                transaction_id,
                item.category_id,
                item.share_minor,
                item.position
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn list_categories_internal(
    conn: &Connection,
    account_ids: Option<&[i64]>,
) -> Result<Vec<TransactionCategoryView>, String> {
    match account_ids {
        Some(ids) if !ids.is_empty() => {
            let placeholders = std::iter::repeat("?")
                .take(ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT {VIEW_COLUMNS}
                 FROM transaction_categories tc
                 JOIN categories c ON c.id = tc.category_id
                 WHERE tc.transaction_id IN (
                     SELECT id FROM transactions WHERE account_id IN ({placeholders})
                 )
                 ORDER BY tc.transaction_id ASC, tc.position ASC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(ids.iter()), from_view_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())
        }
        _ => {
            let sql = format!(
                "SELECT {VIEW_COLUMNS}
                 FROM transaction_categories tc
                 JOIN categories c ON c.id = tc.category_id
                 ORDER BY tc.transaction_id ASC, tc.position ASC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], from_view_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())
        }
    }
}

pub fn set_transaction_categories(
    state: State<'_, DbState>,
    transaction_id: i64,
    items: Vec<CategoryItem>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    set_categories_internal(&conn, transaction_id, &items)
}

pub fn list_transactions_categories(
    state: State<'_, DbState>,
    account_ids: Option<Vec<i64>>,
) -> Result<Vec<TransactionCategoryView>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    list_categories_internal(&conn, account_ids.as_deref())
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
        debit_txn: i64,    // total = 1000 (debit)
        credit_txn: i64,   // total = 500 (credit)
        food_id: i64,      // expense root
        cafe_id: i64,      // expense, child of food
        salary_id: i64,    // income root
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
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 2, '+00:00') RETURNING id",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();

        let debit_txn: i64 = conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-01T10:00:00Z', 0, 1000, 9000) RETURNING id",
                params![account_id, batch_id],
                |r| r.get(0),
            )
            .unwrap();

        let credit_txn: i64 = conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-02T10:00:00Z', 500, 0, 9500) RETURNING id",
                params![account_id, batch_id],
                |r| r.get(0),
            )
            .unwrap();

        let food_id: i64 = conn
            .query_row(
                "INSERT INTO categories (name, color, kind) VALUES ('Food', '#ef4444', 'expense') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let cafe_id: i64 = conn
            .query_row(
                "INSERT INTO categories (name, color, kind, parent_id)
                 VALUES ('Cafe', '#fca5a5', 'expense', ?1) RETURNING id",
                [food_id],
                |r| r.get(0),
            )
            .unwrap();
        let salary_id: i64 = conn
            .query_row(
                "INSERT INTO categories (name, color, kind) VALUES ('Salary', '#22c55e', 'income') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();

        Fixture {
            _dir: dir,
            conn,
            account_id,
            debit_txn,
            credit_txn,
            food_id,
            cafe_id,
            salary_id,
        }
    }

    #[test]
    fn set_then_list_round_trip() {
        let f = fixture();
        let items = vec![
            CategoryItem { category_id: f.food_id, share_minor: 600, position: 0 },
            CategoryItem { category_id: f.cafe_id, share_minor: 400, position: 1 },
        ];
        set_categories_internal(&f.conn, f.debit_txn, &items).unwrap();

        let views = list_categories_internal(&f.conn, None).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].category_id, f.food_id);
        assert_eq!(views[0].share_minor, 600);
        assert_eq!(views[0].category_name, "Food");
        assert_eq!(views[0].category_color, "#ef4444");
        assert_eq!(views[1].category_id, f.cafe_id);
        assert_eq!(views[1].share_minor, 400);
    }

    #[test]
    fn set_rejects_kind_mismatch() {
        let f = fixture();
        let items = vec![CategoryItem {
            category_id: f.salary_id, // income
            share_minor: 1000,
            position: 0,
        }];
        let err = set_categories_internal(&f.conn, f.debit_txn, &items).unwrap_err();
        assert!(err.contains("kind"), "expected kind mismatch error, got: {err}");
    }

    #[test]
    fn set_rejects_share_sum_exceeding_total() {
        let f = fixture();
        let items = vec![
            CategoryItem { category_id: f.food_id, share_minor: 600, position: 0 },
            CategoryItem { category_id: f.cafe_id, share_minor: 600, position: 1 },
        ];
        let err = set_categories_internal(&f.conn, f.debit_txn, &items).unwrap_err();
        assert!(err.contains("exceeds"), "expected sum-exceeds error, got: {err}");
    }

    #[test]
    fn set_accepts_share_sum_below_total() {
        let f = fixture();
        let items = vec![CategoryItem {
            category_id: f.food_id,
            share_minor: 400,
            position: 0,
        }];
        set_categories_internal(&f.conn, f.debit_txn, &items).unwrap();

        let views = list_categories_internal(&f.conn, None).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].share_minor, 400);
    }

    #[test]
    fn set_replaces_existing_atomically() {
        let f = fixture();
        let first = vec![
            CategoryItem { category_id: f.food_id, share_minor: 700, position: 0 },
            CategoryItem { category_id: f.cafe_id, share_minor: 300, position: 1 },
        ];
        set_categories_internal(&f.conn, f.debit_txn, &first).unwrap();

        let second = vec![CategoryItem {
            category_id: f.food_id,
            share_minor: 1000,
            position: 0,
        }];
        set_categories_internal(&f.conn, f.debit_txn, &second).unwrap();

        let views = list_categories_internal(&f.conn, None).unwrap();
        assert_eq!(views.len(), 1, "old cafe row must be gone");
        assert_eq!(views[0].category_id, f.food_id);
        assert_eq!(views[0].share_minor, 1000);
    }

    #[test]
    fn empty_items_clears_all() {
        let f = fixture();
        set_categories_internal(
            &f.conn,
            f.debit_txn,
            &[CategoryItem { category_id: f.food_id, share_minor: 1000, position: 0 }],
        )
        .unwrap();

        set_categories_internal(&f.conn, f.debit_txn, &[]).unwrap();
        let views = list_categories_internal(&f.conn, None).unwrap();
        assert!(views.is_empty());
    }

    #[test]
    fn cascade_on_category_delete() {
        let f = fixture();
        set_categories_internal(
            &f.conn,
            f.debit_txn,
            &[CategoryItem { category_id: f.cafe_id, share_minor: 1000, position: 0 }],
        )
        .unwrap();

        f.conn
            .execute("DELETE FROM categories WHERE id = ?1", [f.cafe_id])
            .unwrap();

        let views = list_categories_internal(&f.conn, None).unwrap();
        assert!(views.is_empty(), "FK cascade should remove the link");
    }

    #[test]
    fn cascade_on_transaction_delete() {
        let f = fixture();
        set_categories_internal(
            &f.conn,
            f.debit_txn,
            &[CategoryItem { category_id: f.food_id, share_minor: 1000, position: 0 }],
        )
        .unwrap();

        // Find the batch and delete it — cascades to transactions, then to txn_categories.
        let batch_id: i64 = f
            .conn
            .query_row(
                "SELECT import_batch_id FROM transactions WHERE id = ?1",
                [f.debit_txn],
                |r| r.get(0),
            )
            .unwrap();
        f.conn
            .execute("DELETE FROM import_batches WHERE id = ?1", [batch_id])
            .unwrap();

        let views = list_categories_internal(&f.conn, None).unwrap();
        assert!(views.is_empty());
    }

    #[test]
    fn credit_transaction_accepts_income_category() {
        let f = fixture();
        let items = vec![CategoryItem {
            category_id: f.salary_id,
            share_minor: 500,
            position: 0,
        }];
        set_categories_internal(&f.conn, f.credit_txn, &items).unwrap();

        let views = list_categories_internal(&f.conn, None).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].category_kind, "income");
    }

    #[test]
    fn list_filters_by_account_ids() {
        let f = fixture();
        set_categories_internal(
            &f.conn,
            f.debit_txn,
            &[CategoryItem { category_id: f.food_id, share_minor: 500, position: 0 }],
        )
        .unwrap();

        // Same account → returns the row.
        let views = list_categories_internal(&f.conn, Some(&[f.account_id])).unwrap();
        assert_eq!(views.len(), 1);

        // Different account → empty.
        let views = list_categories_internal(&f.conn, Some(&[9999])).unwrap();
        assert!(views.is_empty());
    }
}
