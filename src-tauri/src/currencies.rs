use rusqlite::Row;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Currency {
    pub code: String,
    pub name: String,
    pub symbol: String,
    /// Source of conversion rates for this currency (e.g. `"frankfurter"`).
    /// `None` means no automatic rate feed is wired up — the currency is
    /// listed in the dictionary but conversions against it must be entered
    /// manually.
    pub rate_source: Option<String>,
}

const SELECT_COLUMNS: &str = "code, name, symbol, rate_source";

fn from_row(row: &Row) -> rusqlite::Result<Currency> {
    Ok(Currency {
        code: row.get(0)?,
        name: row.get(1)?,
        symbol: row.get(2)?,
        rate_source: row.get(3)?,
    })
}

#[tauri::command]
pub fn list_currencies(state: State<'_, DbState>) -> Result<Vec<Currency>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM currencies ORDER BY code ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], from_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    fn open_conn() -> (TempDir, rusqlite::Connection) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        (dir, conn)
    }

    #[test]
    fn migration_seeds_full_frankfurter_snapshot() {
        let (_dir, conn) = open_conn();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM currencies", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 165, "Frankfurter snapshot should seed 165 currencies");

        let frankfurter_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM currencies WHERE rate_source = 'frankfurter'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(frankfurter_count, 165, "all seeded rows should mark frankfurter as source");
    }

    #[test]
    fn well_known_codes_are_present() {
        let (_dir, conn) = open_conn();
        for code in ["USD", "EUR", "RUB", "THB", "CHF"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM currencies WHERE code = ?1",
                    [code],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{code} must be in seeded dictionary");
        }
    }

    #[test]
    fn currency_code_is_primary_key() {
        let (_dir, conn) = open_conn();
        let dup = conn.execute(
            "INSERT INTO currencies (code, name, symbol, rate_source)
             VALUES ('USD', 'Duplicate', '$', 'frankfurter')",
            [],
        );
        assert!(dup.is_err(), "code must be unique");
    }

    #[test]
    fn rate_source_can_be_null() {
        let (_dir, conn) = open_conn();
        conn.execute(
            "INSERT INTO currencies (code, name, symbol, rate_source)
             VALUES ('XYZ', 'Test', 'X', NULL)",
            [],
        )
        .unwrap();
        let src: Option<String> = conn
            .query_row(
                "SELECT rate_source FROM currencies WHERE code = 'XYZ'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(src.is_none());
    }
}
