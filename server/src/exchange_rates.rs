use std::str::FromStr;
use std::time::Duration;

use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use crate::host::{AppHandle, State};

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
    download_rates_from(app, currency, frankfurter::EUR_EARLIEST).await
}

/// Download the rates from `start` on. Starting at an already stored weekly
/// quote keeps that week's pick the same, so re-reading it inserts nothing.
async fn download_rates_from(
    app: AppHandle,
    currency: String,
    start: &str,
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
        let state = app.db();
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
    let resp = match frankfurter::fetch_history(&cur, start).await {
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
        let state = app.db();
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
        let state = app.db();
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
        tokio::spawn(async move {
            if let Err(err) =
                download_rates_for_currency_internal(app_clone, cur_clone.clone()).await
            {
                eprintln!("rate download for {cur_clone} failed: {err}");
            }
        });
    }
    Ok(())
}

/// How often the running server looks for a new weekly quote. Most checks need
/// no request at all; one that failed is simply tried again at the next.
const RATE_REFRESH_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Stored quotes are one per ISO week, so there is nothing new to fetch until
/// the week after the latest one has begun.
fn week_has_passed(latest: NaiveDate, today: NaiveDate) -> bool {
    let (l, t) = (latest.iso_week(), today.iso_week());
    (t.year(), t.week()) > (l.year(), l.week())
}

/// Currencies of the user's accounts whose quotes are behind, each with the date
/// of its latest quote. Those without any are `spawn_missing_rate_downloads`'s.
fn currencies_behind(conn: &Connection, today: NaiveDate) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.currency, MAX(r.rate_date)
             FROM accounts a
             JOIN currencies c ON c.code = a.currency
             JOIN exchange_rates r ON r.currency = a.currency
             WHERE a.currency != 'EUR' AND c.rate_source = 'frankfurter'
             GROUP BY a.currency",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|(_, latest)| {
            NaiveDate::parse_from_str(latest, "%Y-%m-%d")
                .is_ok_and(|latest| week_has_passed(latest, today))
        })
        .collect())
}

fn read_currencies_behind(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let state = app.db();
    let conn = state.lock().map_err(|e| e.to_string())?;
    currencies_behind(&conn, chrono::Local::now().date_naive())
}

/// Keep the rates current on their own while the server runs: at startup and
/// then every `RATE_REFRESH_EVERY`. Failures (no network, the service is down)
/// only get logged.
pub(crate) fn spawn_rate_refresh(app: AppHandle) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RATE_REFRESH_EVERY);
        loop {
            tick.tick().await;
            let behind = match read_currencies_behind(&app) {
                Ok(behind) => behind,
                Err(err) => {
                    eprintln!("rate refresh failed: {err}");
                    continue;
                }
            };
            for (currency, latest) in behind {
                if let Err(err) = download_rates_from(app.clone(), currency.clone(), &latest).await {
                    eprintln!("rate refresh for {currency} failed: {err}");
                }
            }
        }
    });
}

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

/// Convert `amount` from `from_currency` into `to_currency` using rates
/// available on `date_yyyy_mm_dd`. Same-currency conversions short-circuit
/// to the input amount. Returned value has 2 decimal places (matches the
/// money minor-unit scale used elsewhere in the project) so the result is
/// directly usable by `create_cash_withdrawal` and similar callers.
///
/// Stable error code `withdrawal.rate_unavailable` is returned when a rate
/// can't be located for either currency, so the frontend can localise.
pub fn convert_amount(
    state: State<'_, DbState>,
    amount: String,
    from_currency: String,
    to_currency: String,
    date_yyyy_mm_dd: String,
) -> Result<String, String> {
    let from = validate_currency(&from_currency)?;
    let to = validate_currency(&to_currency)?;
    let date = validate_date(&date_yyyy_mm_dd)?;
    let amount_decimal = Decimal::from_str(amount.trim())
        .map_err(|_| format!("invalid amount '{amount}', expected decimal string"))?;

    if from == to {
        return Ok(amount_decimal.round_dp(2).to_string());
    }

    let conn = state.lock().map_err(|e| e.to_string())?;
    convert_at(&conn, amount_decimal, &from, &to, &date)
}

fn convert_at(
    conn: &Connection,
    amount: Decimal,
    from: &str,
    to: &str,
    date: &str,
) -> Result<String, String> {
    let rate_from = rate_at(conn, from, date, "EUR")
        .map_err(|_| "withdrawal.rate_unavailable".to_string())?;
    let rate_to = rate_at(conn, to, date, "EUR")
        .map_err(|_| "withdrawal.rate_unavailable".to_string())?;
    if rate_from.is_zero() {
        return Err("withdrawal.rate_unavailable".to_string());
    }

    // rate_to_base is how many units of X one EUR buys (1 EUR = rate_X X), so
    // amount_X in EUR = amount_X / rate_X. Convert across via the base:
    //   amount_to = amount_from / rate_from * rate_to
    let converted = (amount * rate_to / rate_from).round_dp(2);
    Ok(converted.to_string())
}

/// Look up a conversion rate from `currency` into `base_currency` for a given calendar date.
///
/// Strategy:
/// 1. If `currency == base_currency` → 1.
/// 2. Most recent rate with `rate_date <= date_yyyy_mm_dd`.
/// 3. Fallback: earliest rate with `rate_date >= date_yyyy_mm_dd` (so a single future quote still works).
/// 4. Otherwise — `Err` describing the missing pair.
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

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn converts_the_right_way_round() {
        let (_dir, conn) = open_conn();
        insert(&conn, "THB", "2026-08-24", "38");
        insert(&conn, "USD", "2026-08-24", "1.2");
        let at = |amount: i64, from: &str, to: &str| {
            let converted = convert_at(&conn, Decimal::from(amount), from, to, "2026-08-24").unwrap();
            converted.parse::<Decimal>().unwrap().normalize().to_string()
        };

        // 1 EUR = 38 THB = 1.2 USD, so a baht is worth far less than a dollar.
        assert_eq!(at(3800, "THB", "USD"), "120");
        assert_eq!(at(120, "USD", "THB"), "3800");
        assert_eq!(at(3800, "THB", "EUR"), "100");
        assert_eq!(at(100, "EUR", "THB"), "3800");
    }

    #[test]
    fn conversion_without_a_rate_gives_the_stable_error() {
        let (_dir, conn) = open_conn();
        insert(&conn, "THB", "2026-08-24", "38");
        let result = convert_at(&conn, Decimal::from(100), "THB", "USD", "2026-08-24");
        assert_eq!(result.unwrap_err(), "withdrawal.rate_unavailable");
    }

    #[test]
    fn nothing_to_fetch_until_the_next_iso_week() {
        // 2026-08-24 is a Monday.
        assert!(!week_has_passed(day("2026-08-24"), day("2026-08-24")));
        assert!(!week_has_passed(day("2026-08-24"), day("2026-08-30")));
        assert!(week_has_passed(day("2026-08-24"), day("2026-08-31")));
        // Across a new year, where the week number starts over.
        assert!(week_has_passed(day("2026-12-21"), day("2027-01-04")));
        assert!(!week_has_passed(day("2026-12-28"), day("2027-01-01")));
    }

    #[test]
    fn fetching_from_the_latest_quote_adds_only_the_new_weeks() {
        let (_dir, mut conn) = open_conn();
        insert(&conn, "THB", "2026-08-24", "38");
        // The latest quote's week read again from its first day, then two more weeks.
        let resp: frankfurter::HistoryResponse = serde_json::from_str(
            r#"{"base":"EUR","start_date":"2026-08-24","end_date":"2026-09-08","rates":{
                "2026-08-24":{"THB":38.0},"2026-08-25":{"THB":38.5},
                "2026-08-31":{"THB":39.0},"2026-09-01":{"THB":39.5},
                "2026-09-08":{"THB":40.0}}}"#,
        )
        .unwrap();
        let rows: Vec<(String, String)> = frankfurter::pick_first_business_day_per_week(&resp, "THB")
            .into_iter()
            .map(|(date, rate)| (date, rate.to_string()))
            .collect();

        assert_eq!(upsert_many(&mut conn, "THB", &rows).unwrap(), 2);
        let dates: Vec<String> = conn
            .prepare("SELECT rate_date FROM exchange_rates WHERE currency = 'THB' ORDER BY rate_date")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(dates, ["2026-08-24", "2026-08-31", "2026-09-08"]);
    }

    #[test]
    fn only_account_currencies_that_are_behind_get_refreshed() {
        let (_dir, conn) = open_conn();
        for (currency, number) in [("THB", "1"), ("USD", "2"), ("EUR", "3"), ("GBP", "4")] {
            conn.execute(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', ?1, ?2, 'A')",
                params![currency, number],
            )
            .unwrap();
        }
        insert(&conn, "THB", "2026-08-10", "37");
        insert(&conn, "THB", "2026-08-24", "38");
        insert(&conn, "USD", "2026-08-31", "1.1");
        // No account in yen; GBP has no quotes yet, so it isn't this job's.
        insert(&conn, "JPY", "2020-01-06", "120");

        let behind = currencies_behind(&conn, day("2026-09-02")).unwrap();
        assert_eq!(behind, vec![("THB".to_string(), "2026-08-24".to_string())]);
    }

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
