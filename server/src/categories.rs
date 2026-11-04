use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use crate::host::State;

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
    /// Set for the app's own categories (`transfer_income` /
    /// `transfer_expense`, see `transfer_categories.rs`): they cannot be
    /// deleted or moved.
    #[serde(default)]
    pub system_key: Option<String>,
    /// A subcategory whose colour follows its parent (`category_colors.rs`);
    /// false for a colour set by hand. Always false for a root.
    #[serde(default)]
    pub color_auto: bool,
}

/// A system category cannot be deleted or moved under another one.
pub(crate) const ERR_SYSTEM: &str = "category.system";

fn from_row(row: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        kind: row.get(3)?,
        parent_id: row.get(4)?,
        description: row.get(5)?,
        created_at: row.get(6)?,
        system_key: row.get(7)?,
        color_auto: row.get::<_, bool>(8)? && row.get::<_, Option<i64>>(4)?.is_some(),
    })
}

const SELECT_COLUMNS: &str =
    "id, name, color, kind, parent_id, description, created_at, system_key, color_auto";

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

pub fn create_category(
    state: State<'_, DbState>,
    name: String,
    color: String,
    kind: String,
    parent_id: Option<i64>,
    description: Option<String>,
    color_auto: Option<bool>,
) -> Result<Category, String> {
    let description = normalize_description(description);
    let conn = state.lock().map_err(|e| e.to_string())?;
    // A subcategory follows its parent's colour unless told otherwise.
    let color_auto = parent_id.is_some() && color_auto.unwrap_or(true);

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
            "INSERT INTO categories (name, color, kind, parent_id, description, color_auto)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             RETURNING id",
            params![name, color, effective_kind, parent_id, description, color_auto],
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
    crate::category_colors::recolor(&conn).map_err(|e| e.to_string())?;

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM categories WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

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

pub fn update_category(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    color: String,
    description: Option<String>,
    parent_id: Option<i64>,
    color_auto: Option<bool>,
) -> Result<Category, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let description = normalize_description(description);

    // Load the current row so we can validate the requested parent change
    // against the category's kind and existing ancestry.
    let (current_kind, _current_parent, system_key, current_auto): (String, Option<i64>, Option<String>, bool) = conn
        .query_row(
            "SELECT kind, parent_id, system_key, color_auto FROM categories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("category {id} does not exist"),
            _ => e.to_string(),
        })?;
    // A system category stays at the top level (it may be renamed).
    if system_key.is_some() && parent_id.is_some() {
        return Err(ERR_SYSTEM.to_string());
    }
    // A root always keeps the colour picked for it.
    let color_auto = parent_id.is_some() && color_auto.unwrap_or(current_auto);

    if let Some(new_parent_id) = parent_id {
        if new_parent_id == id {
            return Err("category cannot be its own parent".to_string());
        }

        let new_parent_kind: String = conn
            .query_row(
                "SELECT kind FROM categories WHERE id = ?1",
                [new_parent_id],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("parent category {new_parent_id} does not exist")
                }
                _ => e.to_string(),
            })?;

        if new_parent_kind != current_kind {
            return Err(format!(
                "parent kind '{new_parent_kind}' must match category kind '{current_kind}'"
            ));
        }

        if is_descendant_of(&conn, new_parent_id, id)? {
            return Err("cannot move category under one of its own descendants".to_string());
        }
    } else {
        // Moving to top level: enforce the same (kind, name) uniqueness at
        // the root that create_category uses, since SQLite's UNIQUE treats
        // NULL parents as distinct and the DB constraint won't catch it.
        let collision: bool = conn
            .query_row(
                "SELECT 1 FROM categories
                 WHERE parent_id IS NULL AND kind = ?1 AND name = ?2 AND id <> ?3",
                params![current_kind, name, id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if collision {
            return Err(format!(
                "category '{name}' already exists at the top level"
            ));
        }
    }

    let updated = conn
        .execute(
            "UPDATE categories SET name = ?1, color = ?2, description = ?3, parent_id = ?4, color_auto = ?5
             WHERE id = ?6",
            params![name, color, description, parent_id, color_auto, id],
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
    crate::category_colors::recolor(&conn).map_err(|e| e.to_string())?;

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM categories WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

/// Walks ancestry of `candidate` upward and returns true if `ancestor`
/// appears along the way. Used to block moves that would create a cycle
/// (e.g. making a node a child of its own descendant).
fn is_descendant_of(
    conn: &rusqlite::Connection,
    candidate: i64,
    ancestor: i64,
) -> Result<bool, String> {
    let mut current = Some(candidate);
    while let Some(node) = current {
        if node == ancestor {
            return Ok(true);
        }
        current = conn
            .query_row(
                "SELECT parent_id FROM categories WHERE id = ?1",
                [node],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(false)
}

pub fn delete_category(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let system: bool = conn
        .query_row(
            "SELECT system_key IS NOT NULL FROM categories WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if system {
        return Err(ERR_SYSTEM.to_string());
    }
    let deleted = conn
        .execute("DELETE FROM categories WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("category {id} does not exist"));
    }
    // Siblings after the deleted one move up a place in the shade order.
    crate::category_colors::recolor(&conn).map_err(|e| e.to_string())?;
    Ok(())
}

/// The UI keeps the category tree within six levels (depth 0..=5).
const MAX_DEPTH: usize = 6;

pub(crate) const ERR_MERGE_SAME: &str = "category.merge_same";
pub(crate) const ERR_MERGE_KIND: &str = "category.merge_kind";
pub(crate) const ERR_MERGE_DESCENDANT: &str = "category.merge_descendant";
pub(crate) const ERR_MERGE_TOO_DEEP: &str = "category.merge_too_deep";

/// What a merge did (or, for a dry run, would do).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// Transactions whose category shares were moved to the target.
    pub transactions: usize,
    /// Subcategories moved under the target as they are.
    pub moved_subcategories: usize,
    /// Subcategories folded into a same-named subcategory of the target.
    pub merged_subcategories: usize,
}

/// Fold category `source_id` into `target_id` and delete it: its transaction
/// shares, pending suggestions and places in saved report views go to the
/// target; its subcategories move under the target (a subcategory whose name
/// the target already has is merged into that one, recursively). A
/// transaction that already carries both keeps one share with the sum.
/// `dry_run` runs everything and rolls back — the UI shows the counts before
/// the user confirms.
pub fn merge_category(
    state: State<'_, DbState>,
    source_id: i64,
    target_id: i64,
    dry_run: bool,
) -> Result<MergeResult, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let tx = guard.transaction().map_err(|e| e.to_string())?;

    if source_id == target_id {
        return Err(ERR_MERGE_SAME.to_string());
    }
    let load = |id: i64| -> Result<(String, bool), String> {
        tx.query_row(
            "SELECT kind, system_key IS NOT NULL FROM categories WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("category {id} does not exist"),
            _ => e.to_string(),
        })
    };
    let (source_kind, source_system) = load(source_id)?;
    let (target_kind, target_system) = load(target_id)?;
    if source_system || target_system {
        return Err(ERR_SYSTEM.to_string());
    }
    if source_kind != target_kind {
        return Err(ERR_MERGE_KIND.to_string());
    }
    if is_descendant_of(&tx, target_id, source_id)? {
        return Err(ERR_MERGE_DESCENDANT.to_string());
    }

    let mut result = MergeResult::default();
    let mut touched = std::collections::HashSet::new();
    merge_into(&tx, source_id, target_id, &mut result, &mut touched)?;
    result.transactions = touched.len();

    if tree_depth(&tx, &target_kind)? > MAX_DEPTH {
        return Err(ERR_MERGE_TOO_DEEP.to_string());
    }
    crate::category_colors::recolor(&tx).map_err(|e| e.to_string())?;
    if !dry_run {
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(result)
}

fn merge_into(
    conn: &rusqlite::Connection,
    source: i64,
    target: i64,
    result: &mut MergeResult,
    touched: &mut std::collections::HashSet<i64>,
) -> Result<(), String> {
    let children: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, name FROM categories WHERE parent_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([source], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    for (child, name) in children {
        let twin: Option<i64> = conn
            .query_row(
                "SELECT id FROM categories WHERE parent_id = ?1 AND name = ?2",
                params![target, name],
                |r| r.get(0),
            )
            .ok();
        match twin {
            Some(twin) => {
                merge_into(conn, child, twin, result, touched)?;
                result.merged_subcategories += 1;
            }
            None => {
                conn.execute("UPDATE categories SET parent_id = ?1 WHERE id = ?2", params![target, child])
                    .map_err(|e| e.to_string())?;
                result.moved_subcategories += 1;
            }
        }
    }

    let shares: Vec<(i64, i64)> = {
        let mut stmt = conn
            .prepare("SELECT transaction_id, share_minor FROM transaction_categories WHERE category_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([source], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    for (txn, share) in shares {
        touched.insert(txn);
        let summed = conn
            .execute(
                "UPDATE transaction_categories SET share_minor = share_minor + ?1
                 WHERE transaction_id = ?2 AND category_id = ?3",
                params![share, txn, target],
            )
            .map_err(|e| e.to_string())?;
        if summed == 0 {
            conn.execute(
                "UPDATE transaction_categories SET category_id = ?1
                 WHERE transaction_id = ?2 AND category_id = ?3",
                params![target, txn, source],
            )
            .map_err(|e| e.to_string())?;
            continue;
        }
        conn.execute(
            "DELETE FROM transaction_categories WHERE transaction_id = ?1 AND category_id = ?2",
            params![txn, source],
        )
        .map_err(|e| e.to_string())?;
        // Close the gap the removed share left in the order.
        let order: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT category_id FROM transaction_categories WHERE transaction_id = ?1 ORDER BY position")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([txn], |r| r.get(0)).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
        };
        for (position, category) in order.into_iter().enumerate() {
            conn.execute(
                "UPDATE transaction_categories SET position = ?1 WHERE transaction_id = ?2 AND category_id = ?3",
                params![position as i64, txn, category],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    conn.execute(
        "UPDATE transaction_suggestions SET category_id = ?1 WHERE category_id = ?2",
        params![target, source],
    )
    .map_err(|e| e.to_string())?;
    remap_report_views(conn, source, target)?;
    conn.execute("DELETE FROM categories WHERE id = ?1", [source])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Saved report views list the categories they show (and their order). The
/// source's place goes to the target, so its money does not drop out of a
/// report that showed the source but not the target.
fn remap_report_views(conn: &rusqlite::Connection, source: i64, target: i64) -> Result<(), String> {
    const KEYS: [&str; 6] = [
        "steps",
        "expenseCategoryIds",
        "incomeCategoryIds",
        "expenseCategoryOrder",
        "incomeCategoryOrder",
        "expandedCategoryIds",
    ];
    let views: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, config FROM report_views").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    for (id, config) in views {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&config) else { continue };
        let mut changed = false;
        for key in KEYS {
            let Some(list) = value.get_mut(key).and_then(|v| v.as_array_mut()) else { continue };
            let is = |v: &serde_json::Value, id: i64| v.as_i64() == Some(id);
            if !list.iter().any(|v| is(v, source)) {
                continue;
            }
            if list.iter().any(|v| is(v, target)) {
                list.retain(|v| !is(v, source));
            } else {
                for v in list.iter_mut() {
                    if is(v, source) {
                        *v = serde_json::Value::from(target);
                    }
                }
            }
            changed = true;
        }
        if changed {
            conn.execute(
                "UPDATE report_views SET config = ?1 WHERE id = ?2",
                params![value.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Number of levels in the `kind` tree (a lone root is 1).
fn tree_depth(conn: &rusqlite::Connection, kind: &str) -> Result<usize, String> {
    let parents: std::collections::HashMap<i64, Option<i64>> = {
        let mut stmt = conn
            .prepare("SELECT id, parent_id FROM categories WHERE kind = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([kind], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    let mut deepest = 0;
    for &id in parents.keys() {
        let mut levels = 0;
        let mut cur = Some(id);
        // Bounded: a corrupted cycle must not hang the merge.
        while let (Some(c), true) = (cur, levels <= MAX_DEPTH * 4) {
            levels += 1;
            cur = parents.get(&c).copied().flatten();
        }
        deepest = deepest.max(levels);
    }
    Ok(deepest)
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

    #[test]
    fn is_descendant_of_walks_full_ancestry_chain() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let root = insert_root(&conn, "Food", "expense");
        let child = insert_child(&conn, "Shops", root, "expense");
        let grand = insert_child(&conn, "Market", child, "expense");

        // A node is its own descendant in the cycle-detection sense — the
        // check is used to forbid making a category its own parent.
        assert!(super::is_descendant_of(&conn, root, root).unwrap());
        // Direct and transitive descendants.
        assert!(super::is_descendant_of(&conn, child, root).unwrap());
        assert!(super::is_descendant_of(&conn, grand, root).unwrap());
        // Unrelated and reverse-direction lookups must be false.
        let other_root = insert_root(&conn, "Travel", "expense");
        assert!(!super::is_descendant_of(&conn, other_root, root).unwrap());
        assert!(!super::is_descendant_of(&conn, root, child).unwrap());
    }

    fn merge_fixture() -> (TempDir, crate::db::DbState, i64) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let account: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency) VALUES ('Cash', 'cash', 'Cash', 'THB') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (dir, std::sync::Mutex::new(conn), account)
    }

    fn txn(conn: &rusqlite::Connection, account: i64, debit: i64, shares: &[(i64, i64)]) -> i64 {
        let id: i64 = conn
            .query_row(
                "INSERT INTO transactions (account_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, '2026-05-01T05:00:00Z', 0, ?2, 0) RETURNING id",
                params![account, debit],
                |r| r.get(0),
            )
            .unwrap();
        for (position, (category, share)) in shares.iter().enumerate() {
            conn.execute(
                "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, category, share, position as i64],
            )
            .unwrap();
        }
        id
    }

    fn shares_of(conn: &rusqlite::Connection, txn: i64) -> Vec<(i64, i64, i64)> {
        let mut stmt = conn
            .prepare("SELECT category_id, share_minor, position FROM transaction_categories WHERE transaction_id = ?1 ORDER BY position")
            .unwrap();
        stmt.query_map([txn], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn merge_moves_shares_sums_overlaps_and_deletes_the_source() {
        let (_dir, state, account) = merge_fixture();
        let (food, cafe, cafes, other, a, b) = {
            let conn = state.lock().unwrap();
            let food = insert_root(&conn, "Food", "expense");
            let cafe = insert_child(&conn, "Cafe", food, "expense");
            let cafes = insert_child(&conn, "Cafes", food, "expense");
            let other = insert_root(&conn, "Other", "expense");
            let a = txn(&conn, account, 1000, &[(cafes, 1000)]);
            let b = txn(&conn, account, 1000, &[(cafe, 300), (other, 200), (cafes, 500)]);
            conn.execute(
                "INSERT INTO report_views (name, config) VALUES ('R', ?1)",
                [format!(r#"{{"expenseCategoryIds":[{food},{cafes}],"expenseCategoryOrder":[{cafes},{other}],"steps":[{other},{cafes}]}}"#)],
            )
            .unwrap();
            (food, cafe, cafes, other, a, b)
        };

        let preview = super::merge_category(&state, cafes, cafe, true).unwrap();
        assert_eq!(preview.transactions, 2);
        {
            let conn = state.lock().unwrap();
            assert_eq!(shares_of(&conn, a), vec![(cafes, 1000, 0)], "a dry run changes nothing");
        }

        super::merge_category(&state, cafes, cafe, false).unwrap();
        let conn = state.lock().unwrap();
        assert_eq!(shares_of(&conn, a), vec![(cafe, 1000, 0)]);
        assert_eq!(shares_of(&conn, b), vec![(cafe, 800, 0), (other, 200, 1)]);
        let gone: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories WHERE id = ?1", [cafes], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 0);
        let config: String = conn.query_row("SELECT config FROM report_views", [], |r| r.get(0)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(value["expenseCategoryIds"], serde_json::json!([food, cafe]));
        assert_eq!(value["expenseCategoryOrder"], serde_json::json!([cafe, other]));
        assert_eq!(value["steps"], serde_json::json!([other, cafe]));
    }

    #[test]
    fn merge_moves_subcategories_and_folds_same_named_ones() {
        let (_dir, state, account) = merge_fixture();
        let conn = state.lock().unwrap();
        let fun = insert_root(&conn, "Fun", "expense");
        let fun_subs = insert_child(&conn, "Subscriptions", fun, "expense");
        let leisure = insert_root(&conn, "Leisure", "expense");
        let leisure_subs = insert_child(&conn, "Subscriptions", leisure, "expense");
        let games = insert_child(&conn, "Games", leisure, "expense");
        let t = txn(&conn, account, 500, &[(leisure_subs, 500)]);
        drop(conn);

        let result = super::merge_category(&state, leisure, fun, false).unwrap();
        assert_eq!(result.moved_subcategories, 1);
        assert_eq!(result.merged_subcategories, 1);
        assert_eq!(result.transactions, 1);
        let conn = state.lock().unwrap();
        assert_eq!(shares_of(&conn, t), vec![(fun_subs, 500, 0)]);
        let games_parent: Option<i64> = conn
            .query_row("SELECT parent_id FROM categories WHERE id = ?1", [games], |r| r.get(0))
            .unwrap();
        assert_eq!(games_parent, Some(fun));
    }

    #[test]
    fn merge_refuses_bad_targets() {
        let (_dir, state, _account) = merge_fixture();
        let conn = state.lock().unwrap();
        let food = insert_root(&conn, "Food", "expense");
        let cafe = insert_child(&conn, "Cafe", food, "expense");
        let salary = insert_root(&conn, "Salary", "income");
        // A chain of six levels: merging a two-level branch under its leaf
        // would make seven.
        let mut leaf = insert_root(&conn, "L1", "expense");
        for n in 2..=6 {
            leaf = insert_child(&conn, &format!("L{n}"), leaf, "expense");
        }
        let branch = insert_root(&conn, "Branch", "expense");
        insert_child(&conn, "Twig", branch, "expense");
        drop(conn);

        assert_eq!(super::merge_category(&state, food, food, true).unwrap_err(), super::ERR_MERGE_SAME);
        assert_eq!(super::merge_category(&state, food, salary, true).unwrap_err(), super::ERR_MERGE_KIND);
        assert_eq!(super::merge_category(&state, food, cafe, true).unwrap_err(), super::ERR_MERGE_DESCENDANT);
        assert_eq!(super::merge_category(&state, branch, leaf, true).unwrap_err(), super::ERR_MERGE_TOO_DEEP);
        // Merging a child into its parent is fine.
        assert!(super::merge_category(&state, cafe, food, false).is_ok());
    }

    #[test]
    fn auto_colours_cascade_and_manual_ones_stay() {
        let (_dir, state, _account) = merge_fixture();
        let color = |id: i64| -> String {
            state.lock().unwrap().query_row("SELECT color FROM categories WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        let root = super::create_category(&state, "Fun".into(), "#e05757".into(), "expense".into(), None, None, None)
            .unwrap();
        assert!(!root.color_auto);
        let auto = super::create_category(&state, "Games".into(), "#000000".into(), "expense".into(), Some(root.id), None, None)
            .unwrap();
        assert!(auto.color_auto);
        assert_eq!(auto.color, crate::category_colors::auto_child_color("#e05757", 0));
        let manual = super::create_category(
            &state, "Books".into(), "#123456".into(), "expense".into(), Some(root.id), None, Some(false),
        )
        .unwrap();
        let grand = super::create_category(&state, "Comics".into(), "#000000".into(), "expense".into(), Some(manual.id), None, None)
            .unwrap();
        assert_eq!(manual.color, "#123456");
        assert_eq!(grand.color, crate::category_colors::auto_child_color("#123456", 0));

        // Recolouring the root repaints its auto child, not the manual one.
        super::update_category(&state, root.id, "Fun".into(), "#5793e0".into(), None, None, None).unwrap();
        assert_eq!(color(auto.id), crate::category_colors::auto_child_color("#5793e0", 0));
        assert_eq!(color(manual.id), "#123456");
        assert_eq!(color(grand.id), crate::category_colors::auto_child_color("#123456", 0));

        // Back to automatic: the manual child and its auto child follow the root.
        super::update_category(&state, manual.id, "Books".into(), "#123456".into(), None, Some(root.id), Some(true)).unwrap();
        let books = crate::category_colors::auto_child_color("#5793e0", 1);
        assert_eq!(color(manual.id), books);
        assert_eq!(color(grand.id), crate::category_colors::auto_child_color(&books, 0));
    }
}
