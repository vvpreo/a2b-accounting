use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

pub type DbState = Mutex<Connection>;

const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "001_init", include_str!("../migrations/001_init.sql")),
    (
        2,
        "002_add_account_name",
        include_str!("../migrations/002_add_account_name.sql"),
    ),
    (
        3,
        "003_add_transaction_peer",
        include_str!("../migrations/003_add_transaction_peer.sql"),
    ),
    (
        4,
        "004_move_timezone_to_import_batch",
        include_str!("../migrations/004_move_timezone_to_import_batch.sql"),
    ),
    (
        5,
        "005_add_app_settings",
        include_str!("../migrations/005_add_app_settings.sql"),
    ),
    (
        6,
        "006_replace_description_columns",
        include_str!("../migrations/006_replace_description_columns.sql"),
    ),
    (
        7,
        "007_add_transaction_is_correcting",
        include_str!("../migrations/007_add_transaction_is_correcting.sql"),
    ),
    (
        8,
        "008_add_categories",
        include_str!("../migrations/008_add_categories.sql"),
    ),
    (
        9,
        "009_add_transaction_categories",
        include_str!("../migrations/009_add_transaction_categories.sql"),
    ),
    (
        10,
        "010_add_exchange_rates",
        include_str!("../migrations/010_add_exchange_rates.sql"),
    ),
    (
        11,
        "011_add_report_views",
        include_str!("../migrations/011_add_report_views.sql"),
    ),
    (
        12,
        "012_add_transaction_links",
        include_str!("../migrations/012_add_transaction_links.sql"),
    ),
    (
        13,
        "013_add_currencies",
        include_str!("../migrations/013_add_currencies.sql"),
    ),
    (
        14,
        "014_add_account_kind_and_cash_support",
        include_str!("../migrations/014_add_account_kind_and_cash_support.sql"),
    ),
    (
        15,
        "015_add_category_description",
        include_str!("../migrations/015_add_category_description.sql"),
    ),
];

pub fn open(data_dir: &Path) -> rusqlite::Result<Connection> {
    let db_path = data_dir.join("finances.db");
    let conn = Connection::open(&db_path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    apply_migrations(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub(crate) fn apply_migrations_for_tests(conn: &Connection) -> rusqlite::Result<()> {
    apply_migrations(conn)
}

fn apply_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT    NOT NULL,
            applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );",
    )?;

    for &(version, name, sql) in MIGRATIONS {
        let already_applied: bool = conn.query_row(
            "SELECT 1 FROM schema_migrations WHERE version = ?1",
            [version],
            |_| Ok(true),
        ).unwrap_or(false);

        if already_applied {
            continue;
        }

        let tx_conn = conn.unchecked_transaction()?;
        tx_conn.execute_batch(sql)?;
        tx_conn.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
            rusqlite::params![version, name],
        )?;
        tx_conn.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    #[test]
    fn migrations_create_expected_tables() {
        let dir = TempDir::new().unwrap();
        let conn = open(dir.path()).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(tables.contains(&"accounts".to_string()));
        assert!(tables.contains(&"import_batches".to_string()));
        assert!(tables.contains(&"transactions".to_string()));
        assert!(tables.contains(&"schema_migrations".to_string()));
    }

    #[test]
    fn migrations_are_idempotent() {
        let dir = TempDir::new().unwrap();
        // Opening twice must not fail or re-apply migrations.
        let _c1 = open(dir.path()).unwrap();
        drop(_c1);
        let conn = open(dir.path()).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn cascade_delete_batch_removes_transactions_but_keeps_account() {
        let dir = TempDir::new().unwrap();
        let conn = open(dir.path()).unwrap();

        let account_id: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('TestBank', 'RUB', '12345', 'Alice') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let batch_id: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-24T10:00:00Z', 'test.csv', 2, '+00:00') RETURNING id",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();

        conn.execute(
            "INSERT INTO transactions
             (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, bank_description)
             VALUES
             (?1, ?2, '2026-04-01T10:00:00Z', 0,    500, 9500, 'coffee'),
             (?1, ?2, '2026-04-01T18:00:00Z', 1000, 0,   10500, 'salary')",
            params![account_id, batch_id],
        )
        .unwrap();

        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE account_id = ?1",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 2);

        conn.execute("DELETE FROM import_batches WHERE id = ?1", [batch_id])
            .unwrap();

        let after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE account_id = ?1",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 0, "cascade delete should remove transactions");

        let account_kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM accounts WHERE id = ?1",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(account_kept, 1);
    }

    #[test]
    fn check_constraint_blocks_both_credit_and_debit() {
        let dir = TempDir::new().unwrap();
        let conn = open(dir.path()).unwrap();

        let account_id: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('TestBank', 'RUB', '12345', 'Alice') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch_id: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-24T10:00:00Z', NULL, 1, '+00:00') RETURNING id",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();

        let res = conn.execute(
            "INSERT INTO transactions
             (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, bank_description)
             VALUES (?1, ?2, '2026-04-01T10:00:00Z', 100, 100, 0, 'bad')",
            params![account_id, batch_id],
        );
        assert!(res.is_err(), "both credit and debit set should fail CHECK");
    }
}
