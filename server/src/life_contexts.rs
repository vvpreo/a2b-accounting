//! Life context — the "Life context" screen:
//! - **Context**: a free-text description of the user's life (where they
//!   live, what they do, the family and their names, hobbies). One text in
//!   `app_settings`; the category agent gets it in its system prompt.
//! - **Events**: date intervals of what was going on (a trip with the kids,
//!   an illness, …). Intervals may overlap. The Transactions screen shows the
//!   events of each transaction's day, and the category model gets them in its
//!   context (`suggestions::SuggestionContext`). Dates are calendar days
//!   (`YYYY-MM-DD`), both bounds inclusive.

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::db::DbState;
use crate::host::State;

/// The life description (`app_settings`); the UI writes it via `set_setting`.
pub(crate) const DESCRIPTION_KEY: &str = "life.description";

const ERR_EMPTY_TITLE: &str = "context.empty_title";
const ERR_BAD_DATE: &str = "context.bad_date";
const ERR_ENDS_BEFORE_STARTS: &str = "context.ends_before_starts";
const ERR_NOT_FOUND: &str = "context.not_found";

/// The user's description of their life, trimmed; `None` when empty.
pub(crate) fn description(conn: &Connection) -> Result<Option<String>, String> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", [DESCRIPTION_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeContext {
    pub id: i64,
    pub title: String,
    pub starts_on: String,
    pub ends_on: String,
    pub color: String,
    pub note: Option<String>,
    pub created_at: String,
}

const SELECT_COLUMNS: &str = "id, title, starts_on, ends_on, color, note, created_at";

fn from_row(r: &Row) -> rusqlite::Result<LifeContext> {
    Ok(LifeContext {
        id: r.get(0)?,
        title: r.get(1)?,
        starts_on: r.get(2)?,
        ends_on: r.get(3)?,
        color: r.get(4)?,
        note: r.get(5)?,
        created_at: r.get(6)?,
    })
}

struct Validated {
    title: String,
    starts_on: String,
    ends_on: String,
    note: Option<String>,
}

fn validate(title: &str, starts_on: &str, ends_on: &str, note: Option<String>) -> Result<Validated, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ERR_EMPTY_TITLE.to_string());
    }
    let day = |s: &str| {
        NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map(|d| d.format("%Y-%m-%d").to_string())
            .map_err(|_| ERR_BAD_DATE.to_string())
    };
    let (starts_on, ends_on) = (day(starts_on)?, day(ends_on)?);
    if ends_on < starts_on {
        return Err(ERR_ENDS_BEFORE_STARTS.to_string());
    }
    Ok(Validated {
        title: title.to_string(),
        starts_on,
        ends_on,
        note: note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
    })
}

fn get(conn: &Connection, id: i64) -> Result<LifeContext, String> {
    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM life_contexts WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|_| ERR_NOT_FOUND.to_string())
}

/// Newest first; overlapping intervals by start, then by end.
pub fn list_life_contexts(state: State<'_, DbState>) -> Result<Vec<LifeContext>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM life_contexts ORDER BY starts_on DESC, ends_on DESC, id DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn create_life_context(
    state: State<'_, DbState>,
    title: String,
    starts_on: String,
    ends_on: String,
    color: String,
    note: Option<String>,
) -> Result<LifeContext, String> {
    let v = validate(&title, &starts_on, &ends_on, note)?;
    let conn = state.lock().map_err(|e| e.to_string())?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO life_contexts (title, starts_on, ends_on, color, note)
             VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
            params![v.title, v.starts_on, v.ends_on, color, v.note],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    get(&conn, id)
}

pub fn update_life_context(
    state: State<'_, DbState>,
    id: i64,
    title: String,
    starts_on: String,
    ends_on: String,
    color: String,
    note: Option<String>,
) -> Result<LifeContext, String> {
    let v = validate(&title, &starts_on, &ends_on, note)?;
    let conn = state.lock().map_err(|e| e.to_string())?;
    let updated = conn
        .execute(
            "UPDATE life_contexts SET title = ?1, starts_on = ?2, ends_on = ?3, color = ?4, note = ?5
             WHERE id = ?6",
            params![v.title, v.starts_on, v.ends_on, color, v.note, id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err(ERR_NOT_FOUND.to_string());
    }
    get(&conn, id)
}

pub fn delete_life_context(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM life_contexts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(ERR_NOT_FOUND.to_string());
    }
    Ok(())
}

/// The contexts of one day, as "Title — note" lines (for the model).
pub(crate) fn describe_day(conn: &Connection, day: NaiveDate) -> Result<Vec<String>, String> {
    let day = day.format("%Y-%m-%d").to_string();
    let mut stmt = conn
        .prepare(
            "SELECT title, note FROM life_contexts
             WHERE starts_on <= ?1 AND ends_on >= ?1
             ORDER BY starts_on, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&day], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(title, note)| match note {
            Some(n) => format!("{title} — {n}"),
            None => title,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn state() -> (TempDir, DbState) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        (dir, Mutex::new(conn))
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn overlapping_intervals_and_inclusive_bounds() {
        let (_d, st) = state();
        create_life_context(&st, "Trip with the kids".into(), "2026-05-10".into(), "2026-05-20".into(),
            "#57c8e0".into(), Some("Phuket".into())).unwrap();
        create_life_context(&st, "Flu".into(), "2026-05-18".into(), "2026-05-25".into(),
            "#e05757".into(), None).unwrap();
        let conn = st.lock().unwrap();
        assert_eq!(describe_day(&conn, day("2026-05-09")).unwrap(), Vec::<String>::new());
        assert_eq!(describe_day(&conn, day("2026-05-10")).unwrap(), ["Trip with the kids — Phuket"]);
        assert_eq!(describe_day(&conn, day("2026-05-19")).unwrap(), ["Trip with the kids — Phuket", "Flu"]);
        assert_eq!(describe_day(&conn, day("2026-05-25")).unwrap(), ["Flu"]);
    }

    #[test]
    fn validation() {
        let (_d, st) = state();
        let c = |t: &str, a: &str, b: &str| create_life_context(&st, t.into(), a.into(), b.into(), "#000000".into(), None);
        assert_eq!(c(" ", "2026-01-01", "2026-01-02").unwrap_err(), ERR_EMPTY_TITLE);
        assert_eq!(c("X", "2026-13-01", "2026-01-02").unwrap_err(), ERR_BAD_DATE);
        assert_eq!(c("X", "2026-01-03", "2026-01-02").unwrap_err(), ERR_ENDS_BEFORE_STARTS);
        let one_day = c("X", "2026-01-02", "2026-01-02").unwrap();
        let edited = update_life_context(&st, one_day.id, "Y".into(), "2026-01-01".into(), "2026-01-05".into(),
            "#111111".into(), Some("  ".into())).unwrap();
        assert_eq!((edited.title.as_str(), edited.note), ("Y", None));
        delete_life_context(&st, one_day.id).unwrap();
        assert_eq!(delete_life_context(&st, one_day.id).unwrap_err(), ERR_NOT_FOUND);
    }
}
