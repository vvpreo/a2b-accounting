use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{Datelike, NaiveDate};
use serde::Deserialize;

/// Frankfurter API base. EUR is the native base — historical depth on the Euro
/// reference rates published by the European Central Bank goes back to 1999-01-04.
pub const EUR_EARLIEST: &str = "1999-01-04";
const API_BASE: &str = "https://api.frankfurter.dev/v1";

/// Range-response shape: `/v1/{from}..` or `/v1/{from}..{to}`.
///
/// Example for `?symbols=USD`:
/// ```json
/// {
///   "amount": 1, "base": "EUR",
///   "start_date": "1999-01-04", "end_date": "2026-05-06",
///   "rates": { "1999-01-04": {"USD": 1.1789}, "1999-01-05": {"USD": 1.179}, ... }
/// }
/// ```
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct HistoryResponse {
    pub base: String,
    pub start_date: String,
    pub end_date: String,
    /// Map<date YYYY-MM-DD, Map<currency, rate>>. BTreeMap keeps dates sorted ASC.
    pub rates: BTreeMap<String, BTreeMap<String, f64>>,
}

/// One HTTP call: fetch full history for a single quote currency vs. EUR base.
///
/// `currency` must be a 3-letter ISO code; the caller is responsible for validation.
pub async fn fetch_history(currency: &str) -> Result<HistoryResponse, String> {
    let url = format!("{API_BASE}/{EUR_EARLIEST}..?symbols={currency}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent("a2b-finances/0.1 (+https://github.com/vvpreo)")
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("frankfurter request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "frankfurter returned {status} for {url}: {body}"
        ));
    }

    let parsed = resp
        .json::<HistoryResponse>()
        .await
        .map_err(|e| format!("frankfurter response parse failed: {e}"))?;

    if parsed.rates.is_empty() {
        return Err(format!("frankfurter returned empty rate set for {currency}"));
    }
    Ok(parsed)
}

/// Reduce a full history response to one rate per ISO week — the first
/// available business day of each week (Mon, or the next trading day if the
/// Mon is missing because of a holiday).
///
/// Frankfurter only publishes business days; weeks where the entire Mon→Fri
/// stretch is missing are simply skipped.
///
/// Returns `(YYYY-MM-DD, rate)` pairs sorted by date ASC, one per ISO week.
pub fn pick_first_business_day_per_week(
    resp: &HistoryResponse,
    currency: &str,
) -> Vec<(String, f64)> {
    let mut picked: Vec<(String, f64)> = Vec::new();
    let mut current_week: Option<(i32, u32)> = None; // (iso_year, iso_week)
    for (date, quotes) in &resp.rates {
        let Some(rate) = quotes.get(currency).copied() else {
            continue;
        };
        let Ok(parsed) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
            continue;
        };
        let iso = parsed.iso_week();
        let week_key = (iso.year(), iso.week());
        if Some(week_key) != current_week {
            picked.push((date.clone(), rate));
            current_week = Some(week_key);
        }
    }
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_response(entries: &[(&str, f64)]) -> HistoryResponse {
        let mut rates: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
        for (date, rate) in entries {
            let mut inner = BTreeMap::new();
            inner.insert("USD".to_string(), *rate);
            rates.insert((*date).to_string(), inner);
        }
        let start = entries.first().map(|(d, _)| d.to_string()).unwrap_or_default();
        let end = entries.last().map(|(d, _)| d.to_string()).unwrap_or_default();
        HistoryResponse {
            base: "EUR".to_string(),
            start_date: start,
            end_date: end,
            rates,
        }
    }

    #[test]
    fn picks_monday_or_next_business_day_per_week() {
        // 2024-01-01 is Mon (holiday in many regions). 2024-01-02 is Tue.
        // 2024-01-08 is Mon. 2024-01-15 is Mon. 2024-01-22 is Mon.
        let resp = mk_response(&[
            ("2024-01-02", 1.10), // Tue — Mon was a holiday → first available of week
            ("2024-01-03", 1.11),
            ("2024-01-08", 1.12), // Mon — picked
            ("2024-01-09", 1.13),
            ("2024-01-15", 1.14), // Mon
            // No data Mon 2024-01-22..Wed; first available is Thu 2024-01-25.
            ("2024-01-25", 1.15),
            ("2024-01-29", 1.16), // next Mon
        ]);
        let out = pick_first_business_day_per_week(&resp, "USD");
        let dates: Vec<&str> = out.iter().map(|(d, _)| d.as_str()).collect();
        assert_eq!(
            dates,
            vec![
                "2024-01-02",
                "2024-01-08",
                "2024-01-15",
                "2024-01-25",
                "2024-01-29",
            ],
            "one entry per ISO week, earliest available business day"
        );
    }

    #[test]
    fn iso_week_boundary_handles_year_change() {
        // 2024-12-30 (Mon) belongs to ISO week 1 of 2025; 2024-12-23 (Mon)
        // belongs to ISO week 52 of 2024. Picks should treat them as separate
        // weeks despite straddling the calendar year.
        let resp = mk_response(&[
            ("2024-12-23", 1.05), // ISO 2024-W52
            ("2024-12-30", 1.06), // ISO 2025-W01 (per ISO-8601)
            ("2025-01-06", 1.07), // ISO 2025-W02
        ]);
        let out = pick_first_business_day_per_week(&resp, "USD");
        let dates: Vec<&str> = out.iter().map(|(d, _)| d.as_str()).collect();
        assert_eq!(dates, vec!["2024-12-23", "2024-12-30", "2025-01-06"]);
    }

    #[test]
    fn skips_dates_missing_the_requested_currency() {
        let mut rates: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
        let mut wk1 = BTreeMap::new();
        wk1.insert("USD".to_string(), 1.10);
        rates.insert("2024-01-08".to_string(), wk1); // Mon, ISO 2024-W02 — kept
        let mut wk2_no_usd = BTreeMap::new();
        wk2_no_usd.insert("GBP".to_string(), 0.85);
        rates.insert("2024-01-15".to_string(), wk2_no_usd); // skipped, no USD
        let mut wk3 = BTreeMap::new();
        wk3.insert("USD".to_string(), 1.11);
        rates.insert("2024-01-22".to_string(), wk3); // Mon, ISO 2024-W04
        let resp = HistoryResponse {
            base: "EUR".into(),
            start_date: "2024-01-08".into(),
            end_date: "2024-01-22".into(),
            rates,
        };
        let out = pick_first_business_day_per_week(&resp, "USD");
        let dates: Vec<&str> = out.iter().map(|(d, _)| d.as_str()).collect();
        assert_eq!(dates, vec!["2024-01-08", "2024-01-22"]);
    }

    #[test]
    fn empty_response_yields_empty_picks() {
        let resp = HistoryResponse {
            base: "EUR".into(),
            start_date: String::new(),
            end_date: String::new(),
            rates: BTreeMap::new(),
        };
        assert!(pick_first_business_day_per_week(&resp, "USD").is_empty());
    }
}
