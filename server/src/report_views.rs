use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use crate::host::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    pub id: i64,
    pub name: String,
    pub config: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT_COLUMNS: &str = "id, name, config, sort_order, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<ReportView> {
    Ok(ReportView {
        id: row.get(0)?,
        name: row.get(1)?,
        config: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn validate_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("report name is required".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_config(config: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(config)
        .map(|_| ())
        .map_err(|e| format!("config is not valid JSON: {e}"))
}

pub fn list_report_views(state: State<'_, DbState>) -> Result<Vec<ReportView>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM report_views
             ORDER BY sort_order ASC, id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], from_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn create_report_view(
    state: State<'_, DbState>,
    name: String,
    config: String,
) -> Result<ReportView, String> {
    let name = validate_name(&name)?;
    validate_config(&config)?;

    let conn = state.lock().map_err(|e| e.to_string())?;

    let next_sort: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM report_views",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let id: i64 = conn
        .query_row(
            "INSERT INTO report_views (name, config, sort_order)
             VALUES (?1, ?2, ?3)
             RETURNING id",
            params![name, config, next_sort],
            |row| row.get(0),
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!("report '{name}' already exists")
            }
            _ => e.to_string(),
        })?;

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM report_views WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

pub fn update_report_view(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    config: String,
) -> Result<ReportView, String> {
    let name = validate_name(&name)?;
    validate_config(&config)?;

    let conn = state.lock().map_err(|e| e.to_string())?;

    let updated = conn
        .execute(
            "UPDATE report_views
             SET name = ?1, config = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?3",
            params![name, config, id],
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!("report '{name}' already exists")
            }
            _ => e.to_string(),
        })?;

    if updated == 0 {
        return Err(format!("report view {id} does not exist"));
    }

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM report_views WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

pub fn delete_report_view(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM report_views WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("report view {id} does not exist"));
    }
    Ok(())
}

pub fn reorder_report_views(state: State<'_, DbState>, ids: Vec<i64>) -> Result<(), String> {
    let mut conn = state.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        let updated = tx
            .execute(
                "UPDATE report_views SET sort_order = ?1 WHERE id = ?2",
                params![index as i64, id],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err(format!("report view {id} does not exist"));
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
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
    fn migration_creates_table() {
        let (_dir, conn) = open_conn();
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='report_views'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
    }

    #[test]
    fn name_must_be_unique() {
        let (_dir, conn) = open_conn();
        conn.execute(
            "INSERT INTO report_views (name, config, sort_order)
             VALUES ('Budget 2026', '{}', 0)",
            [],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO report_views (name, config, sort_order)
             VALUES ('Budget 2026', '{}', 1)",
            [],
        );
        assert!(dup.is_err(), "duplicate report name must fail UNIQUE");
    }

    #[test]
    fn validate_config_accepts_valid_json() {
        assert!(validate_config(r#"{"version":1}"#).is_ok());
        assert!(validate_config("[]").is_ok());
        assert!(validate_config("null").is_ok());
        assert!(validate_config(r#""string-too""#).is_ok());
    }

    #[test]
    fn validate_config_rejects_garbage() {
        assert!(validate_config("").is_err());
        assert!(validate_config("not json").is_err());
        assert!(validate_config("{unterminated").is_err());
    }

    #[test]
    fn validate_name_trims_and_rejects_empty() {
        assert_eq!(validate_name("  Budget  ").unwrap(), "Budget");
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
    }
}
