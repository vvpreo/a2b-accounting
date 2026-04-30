use std::str::FromStr;

use rusqlite::{params, OptionalExtension, Row};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    pub id: i64,
    pub currency: String,
    pub rate_date: String,
    pub rate_to_base: String,
    pub created_at: String,
}

const SELECT_COLUMNS: &str = "id, currency, rate_date, rate_to_base, created_at";

fn from_row(row: &Row) -> rusqlite::Result<ExchangeRate> {
    Ok(ExchangeRate {
        id: row.get(0)?,
        currency: row.get(1)?,
        rate_date: row.get(2)?,
        rate_to_base: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn validate_currency(code: &str) -> Result<String, String> {
    let trimmed = code.trim();
    if trimmed.is_empty() {
        return Err("currency code is required".to_string());
    }
    let upper = trimmed.to_ascii_uppercase();
    if !upper.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("invalid currency code '{code}'"));
    }
    Ok(upper)
}

fn validate_date(date: &str) -> Result<String, String> {
    let trimmed = date.trim();
    if trimmed.len() != 10 {
        return Err(format!("date must be in YYYY-MM-DD format: '{date}'"));
    }
    let bytes = trimmed.as_bytes();
    let ok = bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|b| b.is_ascii_digit());
    if !ok {
        return Err(format!("date must be in YYYY-MM-DD format: '{date}'"));
    }
    Ok(trimmed.to_string())
}

fn validate_rate(rate: &str) -> Result<Decimal, String> {
    let trimmed = rate.trim();
    let value = Decimal::from_str(trimmed)
        .map_err(|_| format!("invalid rate '{rate}', expected decimal string"))?;
    if !value.is_sign_positive() || value.is_zero() {
        return Err(format!("rate must be positive: '{rate}'"));
    }
    Ok(value)
}

#[tauri::command]
pub fn list_exchange_rates(state: State<'_, DbState>) -> Result<Vec<ExchangeRate>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM exchange_rates
             ORDER BY currency ASC, rate_date DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], from_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_exchange_rate(
    state: State<'_, DbState>,
    currency: String,
    rate_date: String,
    rate_to_base: String,
) -> Result<ExchangeRate, String> {
    let currency = validate_currency(&currency)?;
    let rate_date = validate_date(&rate_date)?;
    let rate = validate_rate(&rate_to_base)?;
    let normalized_rate = rate.normalize().to_string();

    let conn = state.lock().map_err(|e| e.to_string())?;

    let id: i64 = conn
        .query_row(
            "INSERT INTO exchange_rates (currency, rate_date, rate_to_base)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(currency, rate_date)
             DO UPDATE SET rate_to_base = excluded.rate_to_base
             RETURNING id",
            params![currency, rate_date, normalized_rate],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM exchange_rates WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_exchange_rate(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM exchange_rates WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("exchange rate {id} does not exist"));
    }
    Ok(())
}

/// Look up a conversion rate from `currency` into `base_currency` for a given calendar date.
///
/// Strategy:
/// 1. If `currency == base_currency` → 1.
/// 2. Most recent rate with `rate_date <= date_yyyy_mm_dd`.
/// 3. Fallback: earliest rate with `rate_date >= date_yyyy_mm_dd` (so a single future quote still works).
/// 4. Otherwise — `Err` describing the missing pair.
#[allow(dead_code)]
pub(crate) fn rate_at(
    conn: &rusqlite::Connection,
    currency: &str,
    date_yyyy_mm_dd: &str,
    base_currency: &str,
) -> Result<Decimal, String> {
    if currency.eq_ignore_ascii_case(base_currency) {
        return Ok(Decimal::ONE);
    }

    let cur_upper = currency.to_ascii_uppercase();

    let before: Option<String> = conn
        .query_row(
            "SELECT rate_to_base FROM exchange_rates
             WHERE currency = ?1 AND rate_date <= ?2
             ORDER BY rate_date DESC
             LIMIT 1",
            params![cur_upper, date_yyyy_mm_dd],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let raw = match before {
        Some(v) => v,
        None => conn
            .query_row(
                "SELECT rate_to_base FROM exchange_rates
                 WHERE currency = ?1 AND rate_date >= ?2
                 ORDER BY rate_date ASC
                 LIMIT 1",
                params![cur_upper, date_yyyy_mm_dd],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("no exchange rate for {currency} on or near {date_yyyy_mm_dd}")
            })?,
    };

    Decimal::from_str(&raw).map_err(|_| format!("corrupt rate value '{raw}' for {currency}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    fn open_conn() -> (TempDir, rusqlite::Connection) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        (dir, conn)
    }

    fn insert(conn: &rusqlite::Connection, currency: &str, date: &str, rate: &str) {
        conn.execute(
            "INSERT INTO exchange_rates (currency, rate_date, rate_to_base)
             VALUES (?1, ?2, ?3)",
            params![currency, date, rate],
        )
        .unwrap();
    }

    #[test]
    fn migration_creates_table_with_unique_index() {
        let (_dir, conn) = open_conn();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='exchange_rates'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);

        insert(&conn, "USD", "2026-01-10", "90.5");
        let dup = conn.execute(
            "INSERT INTO exchange_rates (currency, rate_date, rate_to_base)
             VALUES ('USD', '2026-01-10', '91.0')",
            [],
        );
        assert!(dup.is_err(), "(currency, rate_date) must be UNIQUE");
    }

    #[test]
    fn rate_at_returns_one_for_base_currency() {
        let (_dir, conn) = open_conn();
        let rate = rate_at(&conn, "RUB", "2026-04-30", "RUB").unwrap();
        assert_eq!(rate, Decimal::ONE);

        // Case-insensitive match.
        let rate = rate_at(&conn, "usd", "2026-04-30", "USD").unwrap();
        assert_eq!(rate, Decimal::ONE);
    }

    #[test]
    fn rate_at_picks_exact_date_when_present() {
        let (_dir, conn) = open_conn();
        insert(&conn, "USD", "2026-04-01", "85.00");
        insert(&conn, "USD", "2026-04-15", "90.00");
        insert(&conn, "USD", "2026-05-01", "95.00");

        let rate = rate_at(&conn, "USD", "2026-04-15", "RUB").unwrap();
        assert_eq!(rate, Decimal::from_str("90.00").unwrap());
    }

    #[test]
    fn rate_at_picks_most_recent_before_date() {
        let (_dir, conn) = open_conn();
        insert(&conn, "USD", "2026-04-01", "85.00");
        insert(&conn, "USD", "2026-04-15", "90.00");

        let rate = rate_at(&conn, "USD", "2026-04-20", "RUB").unwrap();
        assert_eq!(rate, Decimal::from_str("90.00").unwrap());

        let rate = rate_at(&conn, "USD", "2026-04-10", "RUB").unwrap();
        assert_eq!(rate, Decimal::from_str("85.00").unwrap());
    }

    #[test]
    fn rate_at_falls_back_to_earliest_future_when_no_history() {
        let (_dir, conn) = open_conn();
        insert(&conn, "USD", "2026-04-15", "90.00");
        insert(&conn, "USD", "2026-05-01", "95.00");

        let rate = rate_at(&conn, "USD", "2026-04-01", "RUB").unwrap();
        assert_eq!(
            rate,
            Decimal::from_str("90.00").unwrap(),
            "should pick earliest future quote"
        );
    }

    #[test]
    fn rate_at_returns_err_when_currency_has_no_rates() {
        let (_dir, conn) = open_conn();
        insert(&conn, "USD", "2026-04-15", "90.00");

        let err = rate_at(&conn, "EUR", "2026-04-15", "RUB").unwrap_err();
        assert!(err.contains("EUR"), "error should mention missing currency: {err}");
    }

    #[test]
    fn validate_currency_normalizes_and_rejects_garbage() {
        assert_eq!(validate_currency("usd").unwrap(), "USD");
        assert_eq!(validate_currency("  RUB  ").unwrap(), "RUB");
        assert!(validate_currency("").is_err());
        assert!(validate_currency("US$").is_err());
    }

    #[test]
    fn validate_date_accepts_iso_only() {
        assert!(validate_date("2026-04-30").is_ok());
        assert!(validate_date("26-04-30").is_err());
        assert!(validate_date("2026/04/30").is_err());
        assert!(validate_date("2026-4-30").is_err());
        assert!(validate_date("2026-04-30T10:00:00Z").is_err());
    }

    #[test]
    fn validate_rate_requires_positive_decimal() {
        assert!(validate_rate("90.5").is_ok());
        assert!(validate_rate("0.0001").is_ok());
        assert!(validate_rate("0").is_err());
        assert!(validate_rate("-1").is_err());
        assert!(validate_rate("abc").is_err());
    }
}
