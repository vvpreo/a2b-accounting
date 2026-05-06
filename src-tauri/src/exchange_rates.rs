use std::str::FromStr;

use rusqlite::{params, Connection, OptionalExtension, Row};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;
use crate::frankfurter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    pub id: i64,
    pub currency: String,
    pub rate_date: String,
    pub rate_to_base: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyRateSummary {
    pub code: String,
    pub name: String,
    pub symbol: String,
    pub rate_source: Option<String>,
    pub rate_count: i64,
    pub earliest_date: String,
    pub latest_date: String,
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

/// Bulk-insert (currency, date, rate) tuples in one transaction. Existing
/// (currency, rate_date) pairs are kept untouched (idempotent for refresh).
/// Returns the number of newly inserted rows.
pub(crate) fn upsert_many(
    conn: &mut Connection,
    currency: &str,
    rates: &[(String, String)],
) -> rusqlite::Result<usize> {
    let cur_upper = currency.to_ascii_uppercase();
    let tx = conn.transaction()?;
    let mut inserted = 0usize;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO exchange_rates (currency, rate_date, rate_to_base)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(currency, rate_date) DO NOTHING",
        )?;
        for (date, rate) in rates {
            let n = stmt.execute(params![cur_upper, date, rate])?;
            inserted += n;
        }
    }
    tx.commit()?;
    Ok(inserted)
}

/// Read the rate-source string from the `currencies` dictionary, if any.
fn rate_source_for(conn: &Connection, currency: &str) -> Result<Option<String>, String> {
    let cur_upper = currency.to_ascii_uppercase();
    conn.query_row(
        "SELECT rate_source FROM currencies WHERE code = ?1",
        params![cur_upper],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|opt| opt.flatten())
}

fn emit_event(app: &AppHandle, event: &str, currency: &str, extra: serde_json::Value) {
    let mut payload = serde_json::json!({ "currency": currency });
    if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit(event, payload);
}

/// Internal entry point used both by the Tauri command and by the background
/// task spawned from `accounts::create_account`. Owns its own access to the
/// shared DB state via `AppHandle::state()` — no `MutexGuard` is held across
/// `await` points.
pub(crate) async fn download_rates_for_currency_internal(
    app: AppHandle,
    currency: String,
) -> Result<usize, String> {
    let cur = currency.trim().to_ascii_uppercase();
    if cur.is_empty() {
        return Err("currency is required".to_string());
    }
    if cur == "EUR" {
        // EUR is the base — `rate_at` returns 1 by self-comparison; nothing to fetch.
        return Ok(0);
    }

    // 1. Read source from DB (lock released before we await the network).
    let source = {
        let state = app.state::<DbState>();
        let conn = state.lock().map_err(|e| e.to_string())?;
        rate_source_for(&conn, &cur)?
    };
    let Some(source) = source else {
        return Err(format!(
            "currency {cur} has no rate_source configured in the dictionary"
        ));
    };
    if source != "frankfurter" {
        return Err(format!(
            "rate_source '{source}' for {cur} is not supported yet"
        ));
    }

    emit_event(&app, "rates:download:started", &cur, serde_json::json!({}));

    // 2. HTTP fetch — pure async, no DB lock held.
    let resp = match frankfurter::fetch_history(&cur).await {
        Ok(r) => r,
        Err(e) => {
            emit_event(
                &app,
                "rates:download:failed",
                &cur,
                serde_json::json!({ "error": e }),
            );
            return Err(e);
        }
    };

    // 3. Pure CPU: pick the first available business day for each ISO week.
    let picks = frankfurter::pick_first_business_day_per_week(&resp, &cur);
    if picks.is_empty() {
        emit_event(
            &app,
            "rates:download:failed",
            &cur,
            serde_json::json!({ "error": "no usable data points returned" }),
        );
        return Err(format!("no rate data points for {cur}"));
    }

    // Convert f64 → Decimal-string via rust_decimal to keep precision in DB.
    let rate_rows: Vec<(String, String)> = picks
        .into_iter()
        .filter_map(|(date, rate)| {
            Decimal::from_f64_retain(rate)
                .map(|d| (date, d.normalize().to_string()))
        })
        .collect();

    // 4. Bulk-insert under one short DB lock.
    let inserted = {
        let state = app.state::<DbState>();
        let mut conn = state.lock().map_err(|e| e.to_string())?;
        upsert_many(&mut conn, &cur, &rate_rows).map_err(|e| e.to_string())?
    };

    emit_event(
        &app,
        "rates:download:completed",
        &cur,
        serde_json::json!({ "inserted": inserted, "totalPoints": rate_rows.len() }),
    );
    Ok(inserted)
}

#[tauri::command]
pub async fn download_rates_for_currency(
    app: AppHandle,
    currency: String,
) -> Result<usize, String> {
    download_rates_for_currency_internal(app, currency).await
}

/// Scan the accounts table for any currency that:
///   - is not the EUR base,
///   - is backed by a supported `rate_source` in the `currencies` dictionary,
///   - has no rows yet in `exchange_rates`,
/// and spawn a background download for each one. Used after demo-data seeding
/// and on first launch to lazily prefill rates for whatever currencies the
/// initial state happens to contain.
pub(crate) fn spawn_missing_rate_downloads(app: AppHandle) -> Result<(), String> {
    let currencies: Vec<String> = {
        let state = app.state::<DbState>();
        let conn = state.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT a.currency
                 FROM accounts a
                 JOIN currencies c ON c.code = a.currency
                 WHERE a.currency != 'EUR'
                   AND c.rate_source = 'frankfurter'
                   AND NOT EXISTS (
                     SELECT 1 FROM exchange_rates r WHERE r.currency = a.currency
                   )",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };

    for cur in currencies {
        let app_clone = app.clone();
        let cur_clone = cur.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) =
                download_rates_for_currency_internal(app_clone, cur_clone.clone()).await
            {
                eprintln!("rate download for {cur_clone} failed: {err}");
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn list_currency_rate_summaries(
    state: State<'_, DbState>,
) -> Result<Vec<CurrencyRateSummary>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.code, c.name, c.symbol, c.rate_source,
                    COUNT(r.id), MIN(r.rate_date), MAX(r.rate_date)
             FROM currencies c
             INNER JOIN exchange_rates r ON r.currency = c.code
             GROUP BY c.code
             ORDER BY c.code ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CurrencyRateSummary {
                code: row.get(0)?,
                name: row.get(1)?,
                symbol: row.get(2)?,
                rate_source: row.get(3)?,
                rate_count: row.get(4)?,
                earliest_date: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                latest_date: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateEntry {
    pub rate_date: String,
    pub rate_to_base: String,
}

#[tauri::command]
pub fn list_rate_entries_for_currency(
    state: State<'_, DbState>,
    currency: String,
) -> Result<Vec<RateEntry>, String> {
    let cur_upper = validate_currency(&currency)?;
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT rate_date, rate_to_base FROM exchange_rates
             WHERE currency = ?1
             ORDER BY rate_date ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![cur_upper], |row| {
            Ok(RateEntry {
                rate_date: row.get(0)?,
                rate_to_base: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Look up the EUR-base rate for `currency` plus the actual `rate_date` row
/// that backed the answer. Same fallback strategy as [`rate_at`]:
/// most recent ≤ requested, then earliest ≥ requested. Returns `None` when no
/// row matches (e.g. the currency hasn't been downloaded yet). For the EUR
/// base itself the rate is `1` and the date is `None` — there is no row to
/// point at; callers that need a tooltip date should pick the other side's
/// date or fall back to the requested one.
pub(crate) fn lookup_rate_at(
    conn: &Connection,
    currency: &str,
    date_yyyy_mm_dd: &str,
) -> Option<(Decimal, Option<String>)> {
    if currency.eq_ignore_ascii_case("EUR") {
        return Some((Decimal::ONE, None));
    }
    let cur_upper = currency.to_ascii_uppercase();
    let before: Option<(String, String)> = conn
        .query_row(
            "SELECT rate_date, rate_to_base FROM exchange_rates
             WHERE currency = ?1 AND rate_date <= ?2
             ORDER BY rate_date DESC LIMIT 1",
            params![cur_upper, date_yyyy_mm_dd],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (rate_date, raw) = match before {
        Some(v) => v,
        None => conn
            .query_row(
                "SELECT rate_date, rate_to_base FROM exchange_rates
                 WHERE currency = ?1 AND rate_date >= ?2
                 ORDER BY rate_date ASC LIMIT 1",
                params![cur_upper, date_yyyy_mm_dd],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten()?,
    };
    let val = Decimal::from_str(&raw).ok()?;
    Some((val, Some(rate_date)))
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

    #[test]
    fn upsert_many_is_idempotent_for_existing_pairs() {
        let (_dir, mut conn) = open_conn();
        let rates = vec![
            ("2024-01-02".to_string(), "1.04".to_string()),
            ("2024-02-01".to_string(), "1.05".to_string()),
            ("2024-03-01".to_string(), "1.06".to_string()),
        ];
        let first = upsert_many(&mut conn, "USD", &rates).unwrap();
        assert_eq!(first, 3);
        // Re-inserting the same set must skip all (DO NOTHING).
        let second = upsert_many(&mut conn, "USD", &rates).unwrap();
        assert_eq!(second, 0, "duplicate (currency, rate_date) must be skipped");
        // Adding one new date alongside duplicates inserts only the new one.
        let mixed = vec![
            ("2024-03-01".to_string(), "9.99".to_string()), // duplicate, skipped
            ("2024-04-01".to_string(), "1.07".to_string()), // new
        ];
        let third = upsert_many(&mut conn, "USD", &mixed).unwrap();
        assert_eq!(third, 1);
        // Original value for 2024-03-01 must be preserved (DO NOTHING — not UPDATE).
        let kept: String = conn
            .query_row(
                "SELECT rate_to_base FROM exchange_rates
                 WHERE currency='USD' AND rate_date='2024-03-01'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, "1.06");
    }

    #[test]
    fn upsert_many_normalizes_currency_to_uppercase() {
        let (_dir, mut conn) = open_conn();
        let rates = vec![("2024-01-02".to_string(), "1.04".to_string())];
        upsert_many(&mut conn, "usd", &rates).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT currency FROM exchange_rates WHERE rate_date='2024-01-02'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "USD");
    }
}
