use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::db::DbState;

#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    #[test]
    fn missing_key_returns_none() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params!["nope"],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert!(value.is_none());
    }

    #[test]
    fn set_then_get_roundtrip() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params!["locale", "en"],
        )
        .unwrap();

        let value: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params!["locale"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "en");
    }

    #[test]
    fn set_overwrites_existing_value() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        for v in ["en", "ru", "de"] {
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["locale", v],
            )
            .unwrap();
        }

        let value: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params!["locale"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "de");
    }
}
