use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub kind: String,
    pub parent_id: Option<i64>,
    pub description: Option<String>,
    pub created_at: String,
}

fn from_row(row: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        kind: row.get(3)?,
        parent_id: row.get(4)?,
        description: row.get(5)?,
        created_at: row.get(6)?,
    })
}

const SELECT_COLUMNS: &str = "id, name, color, kind, parent_id, description, created_at";

fn normalize_description(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "income" | "expense" => Ok(()),
        _ => Err(format!("invalid category kind '{kind}'")),
    }
}

#[tauri::command]
pub fn create_category(
    state: State<'_, DbState>,
    name: String,
    color: String,
    kind: String,
    parent_id: Option<i64>,
    description: Option<String>,
) -> Result<Category, String> {
    let description = normalize_description(description);
    let conn = state.lock().map_err(|e| e.to_string())?;

    // Resolve effective kind: if parent is set, child must inherit parent's kind.
    let effective_kind = match parent_id {
        Some(pid) => {
            let parent_kind: String = conn
                .query_row(
                    "SELECT kind FROM categories WHERE id = ?1",
                    [pid],
                    |row| row.get(0),
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => {
                        format!("parent category {pid} does not exist")
                    }
                    _ => e.to_string(),
                })?;

            if parent_kind != kind {
                return Err(format!(
                    "child category kind '{kind}' must match parent kind '{parent_kind}'"
                ));
            }
            parent_kind
        }
        None => {
            validate_kind(&kind)?;
            kind.clone()
        }
    };

    // For root categories SQLite treats NULL as distinct, so UNIQUE(parent_id, name)
    // does not enforce uniqueness across NULL parents. We enforce uniqueness per (kind, name)
    // for roots in application code.
    if parent_id.is_none() {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM categories
                 WHERE parent_id IS NULL AND kind = ?1 AND name = ?2",
                params![effective_kind, name],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            return Err(format!(
                "category '{name}' already exists at the top level"
            ));
        }
    }

    let id: i64 = conn
        .query_row(
            "INSERT INTO categories (name, color, kind, parent_id, description)
             VALUES (?1, ?2, ?3, ?4, ?5)
             RETURNING id",
            params![name, color, effective_kind, parent_id, description],
            |row| row.get(0),
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!("category '{name}' already exists at this level")
            }
            _ => e.to_string(),
        })?;

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM categories WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_categories(state: State<'_, DbState>) -> Result<Vec<Category>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM categories
             ORDER BY (parent_id IS NULL) DESC, parent_id ASC, name COLLATE NOCASE ASC"
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], from_row)
        .map_err(|e| e.to_string())?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_category(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    color: String,
    description: Option<String>,
) -> Result<Category, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let description = normalize_description(description);

    let updated = conn
        .execute(
            "UPDATE categories SET name = ?1, color = ?2, description = ?3 WHERE id = ?4",
            params![name, color, description, id],
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!("category '{name}' already exists at this level")
            }
            _ => e.to_string(),
        })?;

    if updated == 0 {
        return Err(format!("category {id} does not exist"));
    }

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM categories WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_category(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM categories WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("category {id} does not exist"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    fn insert_root(conn: &rusqlite::Connection, name: &str, kind: &str) -> i64 {
        conn.query_row(
            "INSERT INTO categories (name, color, kind) VALUES (?1, '#ef4444', ?2) RETURNING id",
            params![name, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn insert_child(conn: &rusqlite::Connection, name: &str, parent_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "INSERT INTO categories (name, color, kind, parent_id)
             VALUES (?1, '#fca5a5', ?2, ?3) RETURNING id",
            params![name, kind, parent_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn migration_creates_categories_table() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='categories'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
    }

    #[test]
    fn check_constraint_blocks_invalid_kind() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let res = conn.execute(
            "INSERT INTO categories (name, color, kind) VALUES ('Bad', '#000000', 'transfer')",
            [],
        );
        assert!(res.is_err(), "kind must be 'income' or 'expense'");
    }

    #[test]
    fn unique_sibling_name_via_db_constraint() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let parent = insert_root(&conn, "Food", "expense");
        insert_child(&conn, "Cafe", parent, "expense");

        let res = conn.execute(
            "INSERT INTO categories (name, color, kind, parent_id)
             VALUES ('Cafe', '#fca5a5', 'expense', ?1)",
            [parent],
        );
        assert!(res.is_err(), "duplicate sibling name must violate UNIQUE");
    }

    #[test]
    fn delete_cascades_subtree() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let root = insert_root(&conn, "Food", "expense");
        let child = insert_child(&conn, "Cafe", root, "expense");
        let _grand = insert_child(&conn, "Morning coffee", child, "expense");

        conn.execute("DELETE FROM categories WHERE id = ?1", [root]).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "cascade delete should remove the entire subtree");
    }

    #[test]
    fn list_orders_by_name_case_insensitive_within_level() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        // SQLite's COLLATE NOCASE only folds ASCII letters, so the test uses Latin
        // names where the invariant holds. Cyrillic ordering follows codepoint order.
        insert_root(&conn, "bank", "income");
        insert_root(&conn, "Auto", "expense");
        insert_root(&conn, "salary", "income");

        let mut stmt = conn
            .prepare(
                "SELECT name FROM categories WHERE parent_id IS NULL
                 ORDER BY name COLLATE NOCASE ASC",
            )
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(names, vec!["Auto", "bank", "salary"]);
    }
}
