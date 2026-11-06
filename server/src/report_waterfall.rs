//! The waterfall report: how the balance at the start of a period turns into
//! the balance at its end, in one currency of the user's choice.
//!
//! The server hands over the two balances and the period's money by category;
//! which categories become steps, and in what order, is the screen's business
//! (`src/lib/report-waterfall.ts`), so clicking through them needs no request.
//!
//! The bridge always closes: whatever categories don't explain lands in one of
//! two lines. `adjustments` is what the accounts' own balances say moved beyond
//! their transactions (correcting rows, gaps between statements), `fx_difference`
//! is what is left once amounts are converted: rates moving between the dates of
//! the balances and of the operations, and the spread of transfers between
//! accounts in different currencies.
//!
//! The report can instead use one fixed rate per currency for the whole period:
//! `suggested_rates` offers them and `fixed_rates` carries the user's corrections.
//! Rates then don't move, so only the transfers' spread is left in `fx_difference`.

use std::collections::{BTreeSet, HashMap};
use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::DbState;
use crate::exchange_rates::rate_at;
use crate::host::State;
use crate::money::format_minor;
use crate::reports::{
    excluded_by_paired_link, load_balance_history, load_categories, load_shares,
    load_transactions, local_date, parse_iso_date, ShareRow,
};

/// `exchange_rates.rate_to_base` holds how many units of the currency one of
/// this buys (the Frankfurter quote: 1 EUR = 37.8 THB).
const RATE_BASE: &str = "EUR";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallRequest {
    pub account_ids: Vec<i64>,
    pub from: String,
    pub to: String,
    pub currency: String,
    /// `Some` means one fixed rate per currency for the whole period: these
    /// where given, the suggested one for the rest.
    #[serde(default)]
    pub fixed_rates: Option<Vec<WaterfallFixedRate>>,
}

/// One rate for a whole period, as the user reads it, so that it is never a
/// tiny fraction: `1 currency = rate report-currency`, or with `per_report`,
/// `1 report-currency = rate currency`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallFixedRate {
    pub currency: String,
    pub rate: String,
    pub per_report: bool,
}

impl WaterfallFixedRate {
    /// Report-currency units per one unit of `currency`.
    fn factor(&self) -> Result<Decimal, String> {
        let rate = Decimal::from_str(self.rate.trim())
            .ok()
            .filter(|r| *r > Decimal::ZERO)
            .ok_or_else(|| format!("invalid rate '{}' for {}", self.rate, self.currency))?;
        if self.per_report {
            Decimal::ONE
                .checked_div(rate)
                .ok_or_else(|| format!("invalid rate '{}' for {}", self.rate, self.currency))
        } else {
            Ok(rate)
        }
    }

    fn suggest(currency: &str, factor: Decimal) -> Option<Self> {
        let per_report = factor < Decimal::ONE;
        let shown = if per_report { Decimal::ONE.checked_div(factor)? } else { factor };
        Some(Self {
            currency: currency.to_string(),
            rate: shown.round_dp(4).normalize().to_string(),
            per_report,
        })
    }
}

/// Money of one category, its own shares only: subcategories come separately.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallCategoryAmount {
    pub category_id: i64,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallAccount {
    pub account_id: i64,
    /// The account's own currency, which the `*_native` amounts are in.
    pub currency: String,
    pub opening_native: String,
    pub closing_native: String,
    /// In the report's currency.
    pub opening: String,
    pub closing: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallResponse {
    pub currency: String,
    pub opening: String,
    pub closing: String,
    pub categories: Vec<WaterfallCategoryAmount>,
    pub uncategorized_income: String,
    pub uncategorized_expense: String,
    pub adjustments: String,
    pub fx_difference: String,
    pub accounts: Vec<WaterfallAccount>,
    /// Currencies with no rate at all: their accounts are left out of every
    /// number, so the bridge still closes on what remains.
    pub missing_rates: Vec<String>,
    /// Rates that stop well before the period's end: everything later is
    /// converted at the last one known.
    pub stale_rates: Vec<WaterfallStaleRate>,
    /// The last rate known on the period's end, for each currency to convert
    /// that has one: what a fixed rate starts from.
    pub suggested_rates: Vec<WaterfallFixedRate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallStaleRate {
    pub currency: String,
    pub latest_date: String,
}

/// Rates into the report's currency, by currency and day. Operations are
/// converted at the last rate known on their day, balances at the last one known
/// on their edge of the period. Stored quotes are about weekly.
struct Converter<'a> {
    conn: &'a Connection,
    target: String,
    factors: HashMap<(String, NaiveDate), Option<Decimal>>,
    /// When set, these replace the stored rates on every day.
    fixed: Option<HashMap<String, Decimal>>,
}

impl<'a> Converter<'a> {
    fn new(conn: &'a Connection, target: String) -> Self {
        Self { conn, target, factors: HashMap::new(), fixed: None }
    }

    fn factor(&mut self, currency: &str, date: NaiveDate) -> Option<Decimal> {
        if currency == self.target {
            return Some(Decimal::ONE);
        }
        if let Some(fixed) = &self.fixed {
            return fixed.get(currency).copied();
        }
        let (conn, target) = (self.conn, &self.target);
        *self
            .factors
            .entry((currency.to_string(), date))
            .or_insert_with(|| {
                let day = date.to_string();
                let from = rate_at(conn, currency, &day, RATE_BASE).ok()?;
                let to = rate_at(conn, target, &day, RATE_BASE).ok()?;
                to.checked_div(from)
            })
    }
}

/// Quotes are about weekly, so a gap up to this long is normal.
const RATE_STALE_AFTER_DAYS: i64 = 14;

/// The rates a conversion into `target` relies on that end too early for the
/// period. A period running into the future is measured against `today`: no
/// quote can be newer than that, so the latest one is then as good as it gets.
fn stale_rates(
    conn: &Connection,
    target: &str,
    account_currencies: &BTreeSet<String>,
    to: NaiveDate,
    today: NaiveDate,
) -> Result<Vec<WaterfallStaleRate>, String> {
    let to = to.min(today);
    let mut involved: BTreeSet<&str> = account_currencies
        .iter()
        .map(String::as_str)
        .filter(|c| *c != target)
        .collect();
    if involved.is_empty() {
        return Ok(Vec::new());
    }
    involved.insert(target);
    involved.remove(RATE_BASE);
    let mut out = Vec::new();
    for currency in involved {
        let latest: Option<String> = conn
            .query_row(
                "SELECT MAX(rate_date) FROM exchange_rates WHERE currency = ?1",
                [currency],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let Some(latest) = latest else { continue };
        let is_stale = parse_iso_date(&latest)
            .is_ok_and(|d| (to - d).num_days() > RATE_STALE_AFTER_DAYS);
        if is_stale {
            out.push(WaterfallStaleRate { currency: currency.to_string(), latest_date: latest });
        }
    }
    Ok(out)
}

fn convert(minor: i64, factor: Decimal) -> i64 {
    (Decimal::from(minor) * factor).round().to_i64().unwrap_or(0)
}

fn load_account_currencies(
    conn: &Connection,
    account_ids: &[i64],
) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, currency FROM accounts ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, currency) = row.map_err(|e| e.to_string())?;
        if account_ids.contains(&id) {
            out.push((id, currency.to_ascii_uppercase()));
        }
    }
    Ok(out)
}

pub fn compute_waterfall(
    state: State<'_, DbState>,
    request: WaterfallRequest,
) -> Result<WaterfallResponse, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    compute_waterfall_inner(&conn, &request)
}

pub(crate) fn compute_waterfall_inner(
    conn: &Connection,
    req: &WaterfallRequest,
) -> Result<WaterfallResponse, String> {
    let from = parse_iso_date(&req.from)?;
    let to = parse_iso_date(&req.to)?;
    if to < from {
        return Err("`to` must be on or after `from`".to_string());
    }
    let currency = req.currency.trim().to_ascii_uppercase();
    let mut converter = Converter::new(conn, currency.clone());

    let selected = load_account_currencies(conn, &req.account_ids)?;
    let to_convert: BTreeSet<&str> = selected
        .iter()
        .map(|(_, c)| c.as_str())
        .filter(|c| *c != currency)
        .collect();
    let mut suggested_rates = Vec::new();
    for c in &to_convert {
        if let Some(rate) = converter.factor(c, to).and_then(|f| WaterfallFixedRate::suggest(c, f)) {
            suggested_rates.push(rate);
        }
    }
    let mut fixed_currencies: BTreeSet<String> = BTreeSet::new();
    if let Some(given) = &req.fixed_rates {
        let mut fixed = HashMap::new();
        // The rate on screen, rounded as shown, is the one that counts.
        for rate in suggested_rates.iter() {
            fixed.insert(rate.currency.clone(), rate.factor()?);
        }
        for rate in given {
            let code = rate.currency.trim().to_ascii_uppercase();
            fixed.insert(code.clone(), rate.factor()?);
            fixed_currencies.insert(code);
        }
        converter.fixed = Some(fixed);
    }

    // `rate_at` looks both ways in time, so a currency without a rate on one
    // day has none on any day: one check is enough.
    let mut accounts: HashMap<i64, String> = HashMap::new();
    let mut account_ids: Vec<i64> = Vec::new();
    let mut missing_rates: BTreeSet<String> = BTreeSet::new();
    for (id, account_currency) in selected.iter().cloned() {
        if converter.factor(&account_currency, to).is_some() {
            accounts.insert(id, account_currency);
            account_ids.push(id);
        } else {
            missing_rates.insert(account_currency);
        }
    }

    let cats = load_categories(conn)?;
    let txns = load_transactions(conn, &account_ids, from, to)?;
    let txn_ids: Vec<i64> = txns.iter().map(|t| t.id).collect();
    let shares = load_shares(conn, &txn_ids)?;
    let excluded_by_link = excluded_by_paired_link(conn, &txn_ids)?;
    let mut shares_by_txn: HashMap<i64, Vec<&ShareRow>> = HashMap::new();
    for s in &shares {
        shares_by_txn.entry(s.transaction_id).or_default().push(s);
    }

    let mut by_category: HashMap<i64, i64> = HashMap::new();
    let (mut income, mut expense) = (0_i64, 0_i64);
    let (mut uncategorized_income, mut uncategorized_expense) = (0_i64, 0_i64);
    // Net of every operation by account, in the account's currency: internal
    // transfers included, since they do move that account's balance.
    let mut net_native: HashMap<i64, i64> = HashMap::new();

    // Same attribution as the Cash Flow report (`compute_report_inner`).
    for txn in &txns {
        let local = local_date(&txn.occurred_at_utc, &txn.timezone_offset)?;
        if local < from || local > to {
            continue;
        }
        let Some(account_currency) = accounts.get(&txn.account_id) else { continue };
        let factor = converter
            .factor(account_currency, local)
            .ok_or_else(|| format!("no rate for {account_currency} on {local}"))?;
        *net_native.entry(txn.account_id).or_default() += txn.credit - txn.debit;
        if excluded_by_link.contains(&txn.id) {
            continue;
        }
        let total_minor = txn.credit + txn.debit;
        if total_minor == 0 {
            continue;
        }
        let is_income = txn.credit > 0;
        let expected_kind = if is_income { "income" } else { "expense" };
        let mut allocated = 0_i64;
        let mut converted = 0_i64;
        for s in shares_by_txn.get(&txn.id).into_iter().flatten() {
            match cats.get(&s.category_id) {
                Some(cat) if cat.kind == expected_kind => {}
                _ => continue,
            }
            allocated += s.share_minor;
            let amount = convert(s.share_minor, factor);
            *by_category.entry(s.category_id).or_default() += amount;
            converted += amount;
        }
        let residual = total_minor - allocated;
        if residual > 0 {
            let amount = convert(residual, factor);
            if is_income {
                uncategorized_income += amount;
            } else {
                uncategorized_expense += amount;
            }
            converted += amount;
        }
        if is_income {
            income += converted;
        } else {
            expense += converted;
        }
    }

    // History is sorted by account and time, so the last write for each wins.
    // An account whose history starts within the period already held what its
    // first row's balance says was there before that row: that is its opening
    // balance, not money that appeared from nowhere during the period.
    let mut opening_native: HashMap<i64, i64> = HashMap::new();
    let mut closing_native: HashMap<i64, i64> = HashMap::new();
    for t in load_balance_history(conn, &account_ids, to)? {
        opening_native
            .entry(t.account_id)
            .or_insert(t.balance - t.credit + t.debit);
        if t.local_date < from {
            opening_native.insert(t.account_id, t.balance);
        }
        closing_native.insert(t.account_id, t.balance);
    }

    let (mut opening, mut closing, mut adjustments) = (0_i64, 0_i64, 0_i64);
    let mut account_rows = Vec::with_capacity(account_ids.len());
    for id in &account_ids {
        let account_currency = &accounts[id];
        let open_native = opening_native.get(id).copied().unwrap_or(0);
        let close_native = closing_native.get(id).copied().unwrap_or(0);
        let open_factor = converter
            .factor(account_currency, from)
            .ok_or_else(|| format!("no rate for {account_currency} on {from}"))?;
        let close_factor = converter
            .factor(account_currency, to)
            .ok_or_else(|| format!("no rate for {account_currency} on {to}"))?;
        let open = convert(open_native, open_factor);
        let close = convert(close_native, close_factor);
        opening += open;
        closing += close;
        let gap = close_native - open_native - net_native.get(id).copied().unwrap_or(0);
        adjustments += convert(gap, close_factor);
        account_rows.push(WaterfallAccount {
            account_id: *id,
            currency: account_currency.clone(),
            opening_native: format_minor(open_native),
            closing_native: format_minor(close_native),
            opening: format_minor(open),
            closing: format_minor(close),
        });
    }

    let fx_difference = closing - opening - (income - expense) - adjustments;
    // A rate the user typed in doesn't depend on what has been downloaded.
    let used_currencies: BTreeSet<String> = accounts
        .values()
        .filter(|c| !fixed_currencies.contains(*c))
        .cloned()
        .collect();
    let stale = stale_rates(conn, &currency, &used_currencies, to, chrono::Local::now().date_naive())?;

    let mut categories: Vec<WaterfallCategoryAmount> = by_category
        .into_iter()
        .map(|(category_id, amount)| WaterfallCategoryAmount {
            category_id,
            amount: format_minor(amount),
        })
        .collect();
    categories.sort_by_key(|c| c.category_id);

    Ok(WaterfallResponse {
        currency,
        opening: format_minor(opening),
        closing: format_minor(closing),
        categories,
        uncategorized_income: format_minor(uncategorized_income),
        uncategorized_expense: format_minor(uncategorized_expense),
        adjustments: format_minor(adjustments),
        fx_difference: format_minor(fx_difference),
        accounts: account_rows,
        missing_rates: missing_rates.into_iter().collect(),
        stale_rates: stale,
        suggested_rates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    fn account(conn: &Connection, currency: &str, number: &str) -> i64 {
        conn.query_row(
            "INSERT INTO accounts (bank, currency, account_number, owner_name)
             VALUES ('B', ?1, ?2, 'A') RETURNING id",
            params![currency, number],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn category(conn: &Connection, name: &str, kind: &str) -> i64 {
        conn.query_row(
            "INSERT INTO categories (name, color, kind) VALUES (?1, '#888888', ?2) RETURNING id",
            params![name, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn rate(conn: &Connection, currency: &str, date: &str, value: &str) {
        conn.execute(
            "INSERT INTO exchange_rates (currency, rate_date, rate_to_base) VALUES (?1, ?2, ?3)",
            params![currency, date, value],
        )
        .unwrap();
    }

    /// A transaction on `date` at noon UTC; `balance` is the running balance.
    fn txn(conn: &Connection, account: i64, date: &str, credit: i64, debit: i64, balance: i64) -> i64 {
        conn.query_row(
            "INSERT INTO transactions (account_id, occurred_at_utc, credit, debit, balance)
             VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
            params![account, format!("{date}T12:00:00.000Z"), credit, debit, balance],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn tag(conn: &Connection, txn: i64, category: i64, share: i64) {
        conn.execute(
            "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
             VALUES (?1, ?2, ?3, 0)",
            params![txn, category, share],
        )
        .unwrap();
    }

    fn request(accounts: &[i64], currency: &str) -> WaterfallRequest {
        WaterfallRequest {
            account_ids: accounts.to_vec(),
            from: "2026-02-01".to_string(),
            to: "2026-02-28".to_string(),
            currency: currency.to_string(),
            fixed_rates: None,
        }
    }

    fn fixed(currency: &str, rate: &str, per_report: bool) -> WaterfallFixedRate {
        WaterfallFixedRate { currency: currency.to_string(), rate: rate.to_string(), per_report }
    }

    fn amount_of(r: &WaterfallResponse, category: i64) -> String {
        r.categories
            .iter()
            .find(|c| c.category_id == category)
            .map_or_else(|| "0.00".to_string(), |c| c.amount.clone())
    }

    #[test]
    fn single_currency_bridge_is_exact_with_nothing_left_over() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let acc = account(&conn, "USD", "1");
        let pay = category(&conn, "Pay", "income");
        let school = category(&conn, "School", "expense");
        txn(&conn, acc, "2026-01-15", 100_000, 0, 100_000);
        let a = txn(&conn, acc, "2026-02-05", 50_000, 0, 150_000);
        tag(&conn, a, pay, 50_000);
        // Split: part categorised, the rest stays uncategorised.
        let b = txn(&conn, acc, "2026-02-10", 0, 30_000, 120_000);
        tag(&conn, b, school, 20_000);

        let r = compute_waterfall_inner(&conn, &request(&[acc], "USD")).unwrap();
        assert_eq!(r.opening, "1000.00");
        assert_eq!(r.closing, "1200.00");
        assert_eq!(amount_of(&r, pay), "500.00");
        assert_eq!(amount_of(&r, school), "200.00");
        assert_eq!(r.uncategorized_expense, "100.00");
        assert_eq!(r.uncategorized_income, "0.00");
        assert_eq!(r.adjustments, "0.00");
        assert_eq!(r.fx_difference, "0.00");
    }

    #[test]
    fn converts_operations_at_their_day_and_balances_at_the_edges() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let acc = account(&conn, "THB", "1");
        let food = category(&conn, "Food", "expense");
        // 1 EUR = 1 USD throughout; the baht weakens during the period.
        rate(&conn, "USD", "2026-01-01", "1");
        rate(&conn, "THB", "2026-02-01", "25");
        rate(&conn, "THB", "2026-02-10", "40");
        rate(&conn, "THB", "2026-02-28", "50");
        txn(&conn, acc, "2026-01-15", 1_000_000, 0, 1_000_000);
        let a = txn(&conn, acc, "2026-02-10", 0, 100_000, 900_000);
        tag(&conn, a, food, 100_000);

        let r = compute_waterfall_inner(&conn, &request(&[acc], "USD")).unwrap();
        assert_eq!(r.opening, "400.00"); // 10 000 THB at 25 per USD
        assert_eq!(amount_of(&r, food), "25.00"); // 1 000 THB at 40
        assert_eq!(r.closing, "180.00"); // 9 000 THB at 50
        // 400 − 25 = 375 expected, 180 held: the rest is the baht's fall.
        assert_eq!(r.fx_difference, "-195.00");
        assert_eq!(r.adjustments, "0.00");
        assert_eq!(r.accounts[0].opening_native, "10000.00");
        assert_eq!(r.accounts[0].closing, "180.00");
    }

    #[test]
    fn paired_transfer_is_not_a_step_and_its_spread_lands_in_fx() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let usd = account(&conn, "USD", "1");
        let thb = account(&conn, "THB", "2");
        rate(&conn, "USD", "2026-01-01", "1");
        rate(&conn, "THB", "2026-01-01", "30");
        txn(&conn, usd, "2026-01-15", 100_000, 0, 100_000);
        // 100 USD become 2 700 THB, worth 90 USD at the reference rate.
        let out = txn(&conn, usd, "2026-02-05", 0, 10_000, 90_000);
        let inn = txn(&conn, thb, "2026-02-05", 270_000, 0, 270_000);
        let (a, b) = if out < inn { (out, inn) } else { (inn, out) };
        conn.execute(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
            params![a, b],
        )
        .unwrap();

        let r = compute_waterfall_inner(&conn, &request(&[usd, thb], "USD")).unwrap();
        assert_eq!(r.uncategorized_expense, "0.00");
        assert_eq!(r.uncategorized_income, "0.00");
        assert_eq!(r.opening, "1000.00");
        assert_eq!(r.closing, "990.00");
        assert_eq!(r.fx_difference, "-10.00");
        assert_eq!(r.adjustments, "0.00");
    }

    #[test]
    fn balance_moves_beyond_the_operations_are_adjustments() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let acc = account(&conn, "USD", "1");
        // A statement gap: the balance jumps by 50 between these two rows.
        txn(&conn, acc, "2026-01-15", 100_000, 0, 100_000);
        txn(&conn, acc, "2026-02-05", 0, 10_000, 95_000);

        let r = compute_waterfall_inner(&conn, &request(&[acc], "USD")).unwrap();
        assert_eq!(r.uncategorized_expense, "100.00");
        assert_eq!(r.adjustments, "50.00");
        assert_eq!(r.fx_difference, "0.00");
    }

    #[test]
    fn an_account_starting_within_the_period_opens_with_what_it_already_held() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let acc = account(&conn, "USD", "1");
        // The first statement row: 100 came in and the balance became 1 100.
        txn(&conn, acc, "2026-02-05", 10_000, 0, 110_000);
        txn(&conn, acc, "2026-02-06", 0, 20_000, 90_000);

        let r = compute_waterfall_inner(&conn, &request(&[acc], "USD")).unwrap();
        assert_eq!(r.opening, "1000.00");
        assert_eq!(r.closing, "900.00");
        assert_eq!(r.adjustments, "0.00");
        assert_eq!(r.accounts[0].opening_native, "1000.00");
    }

    #[test]
    fn account_without_a_rate_is_left_out_and_reported() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let usd = account(&conn, "USD", "1");
        let xxx = account(&conn, "THB", "2");
        txn(&conn, usd, "2026-01-15", 100_000, 0, 100_000);
        txn(&conn, xxx, "2026-01-15", 700_000, 0, 700_000);
        txn(&conn, xxx, "2026-02-15", 0, 70_000, 630_000);

        let r = compute_waterfall_inner(&conn, &request(&[usd, xxx], "USD")).unwrap();
        assert_eq!(r.missing_rates, vec!["THB".to_string()]);
        assert_eq!(r.opening, "1000.00");
        assert_eq!(r.closing, "1000.00");
        assert_eq!(r.uncategorized_expense, "0.00");
        assert_eq!(r.fx_difference, "0.00");
        assert_eq!(r.accounts.len(), 1);
    }

    #[test]
    fn reports_rates_that_end_well_before_the_period() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let thb = account(&conn, "THB", "1");
        rate(&conn, "USD", "2026-02-20", "1");
        rate(&conn, "THB", "2026-01-05", "30");
        txn(&conn, thb, "2026-02-15", 30_000, 0, 30_000);

        let r = compute_waterfall_inner(&conn, &request(&[thb], "USD")).unwrap();
        let stale: Vec<_> = r.stale_rates.iter().map(|s| (s.currency.as_str(), s.latest_date.as_str())).collect();
        // USD is a week behind, which is normal; the baht is seven weeks behind.
        assert_eq!(stale, vec![("THB", "2026-01-05")]);

        // Nothing is converted, so the rates don't matter.
        let same = compute_waterfall_inner(&conn, &request(&[thb], "THB")).unwrap();
        assert!(same.stale_rates.is_empty());
    }

    #[test]
    fn a_period_running_into_the_future_is_measured_against_today() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        rate(&conn, "THB", "2026-03-02", "30");
        let thb: BTreeSet<String> = ["THB".to_string()].into();
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();

        // The month ends four weeks after the latest quote, but today is only
        // four days past it: nothing newer exists yet.
        let early = stale_rates(&conn, "USD", &thb, day("2026-03-31"), day("2026-03-06")).unwrap();
        assert!(early.is_empty());
        // Once today is well past the quote, the warning is real.
        let late = stale_rates(&conn, "USD", &thb, day("2026-03-31"), day("2026-03-25")).unwrap();
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].currency, "THB");
    }

    /// 10 000 THB at the start, 1 000 THB spent mid-period, the baht weakening:
    /// 25, then 40, then 50 per USD.
    fn weakening_baht(conn: &Connection) -> (i64, i64) {
        let acc = account(conn, "THB", "1");
        let food = category(conn, "Food", "expense");
        rate(conn, "USD", "2026-01-01", "1");
        rate(conn, "THB", "2026-02-01", "25");
        rate(conn, "THB", "2026-02-10", "40");
        rate(conn, "THB", "2026-02-28", "50");
        txn(conn, acc, "2026-01-15", 1_000_000, 0, 1_000_000);
        let a = txn(conn, acc, "2026-02-10", 0, 100_000, 900_000);
        tag(conn, a, food, 100_000);
        (acc, food)
    }

    #[test]
    fn suggests_the_period_end_rate_the_readable_way_round() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let (acc, _) = weakening_baht(&conn);

        let usd = compute_waterfall_inner(&conn, &request(&[acc], "USD")).unwrap();
        assert_eq!(usd.suggested_rates, vec![fixed("THB", "50", true)]);
        let thb = compute_waterfall_inner(&conn, &request(&[acc], "THB")).unwrap();
        assert!(thb.suggested_rates.is_empty());
    }

    #[test]
    fn a_fixed_rate_applies_to_everything_and_leaves_no_rate_difference() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let (acc, food) = weakening_baht(&conn);
        let mut req = request(&[acc], "USD");
        req.fixed_rates = Some(vec![fixed("THB", "40", true)]);

        let r = compute_waterfall_inner(&conn, &req).unwrap();
        assert_eq!(r.opening, "250.00");
        assert_eq!(amount_of(&r, food), "25.00");
        assert_eq!(r.closing, "225.00");
        assert_eq!(r.fx_difference, "0.00");
        // What the user sees offered doesn't change with their own choice.
        assert_eq!(r.suggested_rates, vec![fixed("THB", "50", true)]);
    }

    #[test]
    fn fixed_mode_without_corrections_uses_the_suggestion() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let (acc, _) = weakening_baht(&conn);
        let mut req = request(&[acc], "USD");
        req.fixed_rates = Some(Vec::new());

        let r = compute_waterfall_inner(&conn, &req).unwrap();
        assert_eq!(r.opening, "200.00");
        assert_eq!(r.closing, "180.00");
        assert_eq!(r.fx_difference, "0.00");
    }

    #[test]
    fn a_rate_the_other_way_round_multiplies() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let usd = account(&conn, "USD", "1");
        txn(&conn, usd, "2026-01-15", 10_000, 0, 10_000);
        let mut req = request(&[usd], "THB");
        req.fixed_rates = Some(vec![fixed("USD", "35", false)]);

        assert_eq!(compute_waterfall_inner(&conn, &req).unwrap().opening, "3500.00");
    }

    #[test]
    fn a_fixed_rate_brings_in_a_currency_without_downloaded_rates() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let usd = account(&conn, "USD", "1");
        let thb = account(&conn, "THB", "2");
        txn(&conn, usd, "2026-01-15", 100_000, 0, 100_000);
        txn(&conn, thb, "2026-01-15", 700_000, 0, 700_000);
        let mut req = request(&[usd, thb], "USD");
        req.fixed_rates = Some(vec![fixed("THB", "35", true)]);

        let r = compute_waterfall_inner(&conn, &req).unwrap();
        assert!(r.missing_rates.is_empty());
        assert_eq!(r.opening, "1200.00");
    }

    #[test]
    fn a_fixed_rate_leaves_the_spread_of_a_transfer_in_fx() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let usd = account(&conn, "USD", "1");
        let thb = account(&conn, "THB", "2");
        txn(&conn, usd, "2026-01-15", 100_000, 0, 100_000);
        let out = txn(&conn, usd, "2026-02-05", 0, 10_000, 90_000);
        let inn = txn(&conn, thb, "2026-02-05", 270_000, 0, 270_000);
        conn.execute(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
            params![out.min(inn), out.max(inn)],
        )
        .unwrap();
        let mut req = request(&[usd, thb], "USD");
        req.fixed_rates = Some(vec![fixed("THB", "30", true)]);

        // 100 USD became 2 700 THB, worth 90 USD at the chosen rate.
        assert_eq!(compute_waterfall_inner(&conn, &req).unwrap().fx_difference, "-10.00");
    }

    #[test]
    fn rejects_a_rate_that_is_not_a_positive_number() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        for bad in ["0", "-3", "abc", ""] {
            let mut req = request(&[], "USD");
            req.fixed_rates = Some(vec![fixed("THB", bad, true)]);
            assert!(compute_waterfall_inner(&conn, &req).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_an_inverted_period() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let mut req = request(&[], "USD");
        req.from = "2026-03-01".to_string();
        assert!(compute_waterfall_inner(&conn, &req).is_err());
    }
}
