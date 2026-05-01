use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
use crate::money::format_minor;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Year,
    Quarter,
    Month,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    pub account_ids: Vec<i64>,
    pub expense_category_ids: Vec<i64>,
    pub income_category_ids: Vec<i64>,
    pub from: String,
    pub to: String,
    pub granularity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodColumn {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRow {
    pub category_id: Option<i64>,
    pub name: String,
    pub color: String,
    pub depth: i32,
    pub values: Vec<String>,
    pub total: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionData {
    pub rows: Vec<ReportRow>,
    pub total: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceMetrics {
    /// Per-period sum of opening balances across the selected accounts. The
    /// opening balance for a period is the running balance JUST BEFORE the
    /// first transaction of that period in each account (i.e. the closing
    /// balance carried over from the previous period; zero if the account
    /// had no prior activity).
    pub opening: Vec<String>,
    /// Per-period sum of closing balances across the selected accounts. The
    /// closing balance for a period is the running balance AFTER the last
    /// transaction of that period in each account (which equals the opening
    /// balance if the account had no transactions in that period).
    pub closing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportResponse {
    pub periods: Vec<PeriodColumn>,
    pub expense: SectionData,
    pub income: SectionData,
    pub balances: BalanceMetrics,
}

// ---------- Pure helpers (covered by unit tests) ----------

fn parse_granularity(s: &str) -> Result<Granularity, String> {
    match s {
        "year" => Ok(Granularity::Year),
        "quarter" => Ok(Granularity::Quarter),
        "month" => Ok(Granularity::Month),
        _ => Err(format!("invalid granularity '{s}'")),
    }
}

fn parse_iso_date(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|e| format!("invalid date '{s}': {e}"))
}

pub(crate) fn parse_offset(s: &str) -> Result<FixedOffset, String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Ok(FixedOffset::east_opt(0).unwrap());
    }
    let probe = format!("2000-01-01T00:00:00{trimmed}");
    DateTime::parse_from_rfc3339(&probe)
        .map(|dt| *dt.offset())
        .map_err(|e| format!("invalid timezone offset '{s}': {e}"))
}

pub(crate) fn local_date(occurred_at_utc: &str, tz_offset: &str) -> Result<NaiveDate, String> {
    let dt = DateTime::parse_from_rfc3339(occurred_at_utc.trim())
        .map_err(|e| format!("invalid timestamp '{occurred_at_utc}': {e}"))?;
    let offset = parse_offset(tz_offset)?;
    Ok(dt.with_timezone(&offset).date_naive())
}

fn period_key(date: NaiveDate, gran: Granularity) -> String {
    match gran {
        Granularity::Year => format!("{}", date.year()),
        Granularity::Quarter => {
            let q = (date.month() - 1) / 3 + 1;
            format!("{}-Q{}", date.year(), q)
        }
        Granularity::Month => format!("{}-{:02}", date.year(), date.month()),
    }
}

fn last_day_of_month(y: i32, m: u32) -> NaiveDate {
    let next = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1)
    };
    next.unwrap().pred_opt().unwrap()
}

/// Per-period (start_date, end_date) inclusive bounds for the same enumeration
/// used by `enumerate_periods`. Used by the balance metric pipeline to find the
/// running balance just-before each period start and at each period end.
fn period_bounds(from: NaiveDate, to: NaiveDate, gran: Granularity) -> Vec<(NaiveDate, NaiveDate)> {
    if to < from {
        return Vec::new();
    }
    let mut out = Vec::new();
    match gran {
        Granularity::Year => {
            for y in from.year()..=to.year() {
                let start = NaiveDate::from_ymd_opt(y, 1, 1).unwrap();
                let end = NaiveDate::from_ymd_opt(y, 12, 31).unwrap();
                out.push((start, end));
            }
        }
        Granularity::Quarter => {
            let mut y = from.year();
            let mut q = (from.month() - 1) / 3 + 1;
            let to_y = to.year();
            let to_q = (to.month() - 1) / 3 + 1;
            loop {
                let start_m = (q - 1) * 3 + 1;
                let end_m = start_m + 2;
                let start = NaiveDate::from_ymd_opt(y, start_m, 1).unwrap();
                let end = last_day_of_month(y, end_m);
                out.push((start, end));
                if y == to_y && q == to_q {
                    break;
                }
                q += 1;
                if q > 4 {
                    q = 1;
                    y += 1;
                }
            }
        }
        Granularity::Month => {
            let mut y = from.year();
            let mut m = from.month();
            let to_y = to.year();
            let to_m = to.month();
            loop {
                let start = NaiveDate::from_ymd_opt(y, m, 1).unwrap();
                let end = last_day_of_month(y, m);
                out.push((start, end));
                if y == to_y && m == to_m {
                    break;
                }
                m += 1;
                if m > 12 {
                    m = 1;
                    y += 1;
                }
            }
        }
    }
    out
}

fn enumerate_periods(from: NaiveDate, to: NaiveDate, gran: Granularity) -> Vec<String> {
    if to < from {
        return Vec::new();
    }
    let mut out = Vec::new();
    match gran {
        Granularity::Year => {
            for y in from.year()..=to.year() {
                out.push(format!("{}", y));
            }
        }
        Granularity::Quarter => {
            let mut y = from.year();
            let mut q = (from.month() - 1) / 3 + 1;
            let to_y = to.year();
            let to_q = (to.month() - 1) / 3 + 1;
            loop {
                out.push(format!("{}-Q{}", y, q));
                if y == to_y && q == to_q {
                    break;
                }
                q += 1;
                if q > 4 {
                    q = 1;
                    y += 1;
                }
            }
        }
        Granularity::Month => {
            let mut y = from.year();
            let mut m = from.month();
            let to_y = to.year();
            let to_m = to.month();
            loop {
                out.push(format!("{}-{:02}", y, m));
                if y == to_y && m == to_m {
                    break;
                }
                m += 1;
                if m > 12 {
                    m = 1;
                    y += 1;
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone)]
struct CatNode {
    parent_id: Option<i64>,
    name: String,
    color: String,
    kind: String,
}

/// For an *unselected* category, return the closest *strict* ancestor that *is* selected.
/// Used when deciding the displayed parent of a selected node — that parent must not be the node itself.
fn strict_nearest_selected_ancestor(
    start: i64,
    selected: &HashSet<i64>,
    cats: &HashMap<i64, CatNode>,
) -> Option<i64> {
    let mut current = cats.get(&start).and_then(|c| c.parent_id);
    while let Some(id) = current {
        if selected.contains(&id) {
            return Some(id);
        }
        current = cats.get(&id).and_then(|c| c.parent_id);
    }
    None
}

/// Produce the ordered list of (category_id, depth) rows for a section,
/// preserving the user-supplied order at each level.
fn section_layout(
    selected_ids: &[i64],
    cats: &HashMap<i64, CatNode>,
) -> Vec<(i64, i32)> {
    let selected: HashSet<i64> = selected_ids.iter().copied().collect();
    let mut children_of: HashMap<Option<i64>, Vec<i64>> = HashMap::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for &id in selected_ids {
        if !seen.insert(id) {
            continue;
        }
        let dp = strict_nearest_selected_ancestor(id, &selected, cats);
        children_of.entry(dp).or_default().push(id);
    }

    let mut out = Vec::new();
    let roots = children_of.get(&None).cloned().unwrap_or_default();
    for root in roots {
        push_subtree(root, 0, &children_of, &mut out);
    }
    out
}

fn push_subtree(
    id: i64,
    depth: i32,
    children_of: &HashMap<Option<i64>, Vec<i64>>,
    out: &mut Vec<(i64, i32)>,
) {
    out.push((id, depth));
    if let Some(children) = children_of.get(&Some(id)) {
        for &child in children {
            push_subtree(child, depth + 1, children_of, out);
        }
    }
}

// ---------- DB-backed pipeline ----------

#[derive(Debug, Clone)]
struct TxnRow {
    id: i64,
    occurred_at_utc: String,
    timezone_offset: String,
    credit: i64,
    debit: i64,
}

#[derive(Debug, Clone)]
struct ShareRow {
    transaction_id: i64,
    category_id: i64,
    share_minor: i64,
}

fn load_categories(conn: &Connection) -> Result<HashMap<i64, CatNode>, String> {
    let mut stmt = conn
        .prepare("SELECT id, parent_id, name, color, kind FROM categories")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                CatNode {
                    parent_id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                    kind: r.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, node) = r.map_err(|e| e.to_string())?;
        out.insert(id, node);
    }
    Ok(out)
}

fn load_transactions(
    conn: &Connection,
    account_ids: &[i64],
    from_local: NaiveDate,
    to_local: NaiveDate,
) -> Result<Vec<TxnRow>, String> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Coarse SQL filter by UTC date string. We over-fetch by ±1 day to absorb any
    // timezone shift, then filter precisely in Rust by local date.
    let utc_lo = format!(
        "{}T00:00:00.000Z",
        from_local.pred_opt().unwrap_or(from_local)
    );
    let utc_hi = format!(
        "{}T23:59:59.999Z",
        to_local.succ_opt().unwrap_or(to_local)
    );

    let placeholders: Vec<String> = (1..=account_ids.len())
        .map(|i| format!("?{}", i + 2))
        .collect();
    let sql = format!(
        "SELECT t.id, t.occurred_at_utc, ib.timezone_offset, t.credit, t.debit
         FROM transactions t
         JOIN import_batches ib ON ib.id = t.import_batch_id
         WHERE t.is_correcting = 0
           AND t.occurred_at_utc >= ?1
           AND t.occurred_at_utc <= ?2
           AND t.account_id IN ({})",
        placeholders.join(",")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(utc_lo), Box::new(utc_hi)];
    for id in account_ids {
        params_vec.push(Box::new(*id));
    }
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        params_vec.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |r| {
            Ok(TxnRow {
                id: r.get(0)?,
                occurred_at_utc: r.get(1)?,
                timezone_offset: r.get(2)?,
                credit: r.get(3)?,
                debit: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone)]
struct BalanceTxn {
    account_id: i64,
    local_date: NaiveDate,
    occurred_at_utc: String,
    id: i64,
    balance: i64,
}

/// Load every transaction for `account_ids` whose local date is on or before
/// `to_local`, with its running `balance` field. Includes correcting
/// transactions because they participate in the actual balance chain (we want
/// the same number the bank shows, not a synthetic income/expense view).
/// Returns rows sorted by (account_id, local_date, occurred_at_utc, id).
fn load_balance_history(
    conn: &Connection,
    account_ids: &[i64],
    to_local: NaiveDate,
) -> Result<Vec<BalanceTxn>, String> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Use a generous UTC ceiling — `to_local + 1 day` UTC catches anything that
    // could possibly be on or before `to_local` once the per-batch tz offset is
    // applied. We re-filter by local_date in Rust below.
    let utc_hi = format!(
        "{}T23:59:59.999Z",
        to_local.succ_opt().unwrap_or(to_local)
    );
    let placeholders: Vec<String> = (1..=account_ids.len())
        .map(|i| format!("?{}", i + 1))
        .collect();
    let sql = format!(
        "SELECT t.id, t.account_id, t.occurred_at_utc, ib.timezone_offset, t.balance
         FROM transactions t
         JOIN import_batches ib ON ib.id = t.import_batch_id
         WHERE t.occurred_at_utc <= ?1
           AND t.account_id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(utc_hi)];
    for id in account_ids {
        params_vec.push(Box::new(*id));
    }
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        params_vec.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt
        .query(params_refs.as_slice())
        .map_err(|e| e.to_string())?;
    let mut out: Vec<BalanceTxn> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        let account_id: i64 = row.get(1).map_err(|e| e.to_string())?;
        let utc: String = row.get(2).map_err(|e| e.to_string())?;
        let tz: String = row.get(3).map_err(|e| e.to_string())?;
        let balance: i64 = row.get(4).map_err(|e| e.to_string())?;
        let local = local_date(&utc, &tz)?;
        if local > to_local {
            continue;
        }
        out.push(BalanceTxn {
            account_id,
            local_date: local,
            occurred_at_utc: utc,
            id,
            balance,
        });
    }
    out.sort_by(|a, b| {
        a.account_id
            .cmp(&b.account_id)
            .then(a.local_date.cmp(&b.local_date))
            .then(a.occurred_at_utc.cmp(&b.occurred_at_utc))
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

/// Walk per-account history once, snapshotting the running balance just
/// before each period start (opening) and at each period end (closing). The
/// returned vectors are summed across all selected accounts — currencies are
/// added 1:1, matching the existing income/expense aggregation behavior
/// (mixed_currency_accounts_sum_one_to_one test).
fn compute_balance_metrics(
    history: &[BalanceTxn],
    bounds: &[(NaiveDate, NaiveDate)],
) -> (Vec<i64>, Vec<i64>) {
    let n_periods = bounds.len();
    let mut opening = vec![0_i64; n_periods];
    let mut closing = vec![0_i64; n_periods];
    if n_periods == 0 {
        return (opening, closing);
    }
    // History is sorted by account_id, so accumulate per-account runs by
    // detecting account boundaries in the slice.
    let mut start = 0;
    while start < history.len() {
        let acc = history[start].account_id;
        let mut end = start + 1;
        while end < history.len() && history[end].account_id == acc {
            end += 1;
        }
        let txns = &history[start..end];
        let mut cursor = 0;
        let mut last_balance = 0_i64;
        for (i, (p_start, p_end)) in bounds.iter().enumerate() {
            // Advance the cursor past every txn dated strictly before this
            // period start; that gives us the opening balance.
            while cursor < txns.len() && txns[cursor].local_date < *p_start {
                last_balance = txns[cursor].balance;
                cursor += 1;
            }
            opening[i] += last_balance;
            // Then advance past every txn dated on or before this period end;
            // the last one we touch holds the closing balance.
            while cursor < txns.len() && txns[cursor].local_date <= *p_end {
                last_balance = txns[cursor].balance;
                cursor += 1;
            }
            closing[i] += last_balance;
        }
        start = end;
    }
    (opening, closing)
}

/// Returns the set of transaction ids whose paired link partner is also part
/// of `txn_ids` — those are the internal-transfer rows that fully cancel out
/// inside the report and must be skipped from income/expense aggregation.
/// Links whose other side falls outside the report scope are NOT excluded:
/// the visible side stays as-is so the user still sees the gap.
fn excluded_by_paired_link(
    conn: &Connection,
    txn_ids: &[i64],
) -> Result<HashSet<i64>, String> {
    let mut out: HashSet<i64> = HashSet::new();
    if txn_ids.len() < 2 {
        return Ok(out);
    }
    let in_scope: HashSet<i64> = txn_ids.iter().copied().collect();
    let placeholders: Vec<String> = (1..=txn_ids.len()).map(|i| format!("?{i}")).collect();
    // We only need links that touch *some* in-scope txn — load both sides and
    // intersect with `in_scope` to find pairs where both halves are present.
    let sql = format!(
        "SELECT txn_a_id, txn_b_id FROM transaction_links
         WHERE txn_a_id IN ({}) OR txn_b_id IN ({})",
        placeholders.join(","),
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    // Numbered placeholders `?1..?N` are referenced by *both* IN(...) clauses
    // — rusqlite resolves them to the same value, so we bind each id exactly
    // once.
    let params_vec: Vec<Box<dyn rusqlite::ToSql>> =
        txn_ids.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>).collect();
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt
        .query(params_refs.as_slice())
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let a: i64 = row.get(0).map_err(|e| e.to_string())?;
        let b: i64 = row.get(1).map_err(|e| e.to_string())?;
        if in_scope.contains(&a) && in_scope.contains(&b) {
            out.insert(a);
            out.insert(b);
        }
    }
    Ok(out)
}

fn load_shares(conn: &Connection, txn_ids: &[i64]) -> Result<Vec<ShareRow>, String> {
    if txn_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = (1..=txn_ids.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "SELECT transaction_id, category_id, share_minor
         FROM transaction_categories
         WHERE transaction_id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_vec: Vec<Box<dyn rusqlite::ToSql>> =
        txn_ids.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>).collect();
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        params_vec.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |r| {
            Ok(ShareRow {
                transaction_id: r.get(0)?,
                category_id: r.get(1)?,
                share_minor: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn compute_report(
    state: State<'_, DbState>,
    request: ReportRequest,
) -> Result<ReportResponse, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    compute_report_inner(&conn, &request)
}

pub(crate) fn compute_report_inner(
    conn: &Connection,
    req: &ReportRequest,
) -> Result<ReportResponse, String> {
    let from = parse_iso_date(&req.from)?;
    let to = parse_iso_date(&req.to)?;
    if to < from {
        return Err("`to` must be on or after `from`".to_string());
    }
    let gran = parse_granularity(&req.granularity)?;

    let period_keys = enumerate_periods(from, to, gran);
    let period_index: HashMap<String, usize> = period_keys
        .iter()
        .enumerate()
        .map(|(i, k)| (k.clone(), i))
        .collect();
    let periods: Vec<PeriodColumn> = period_keys
        .iter()
        .map(|k| PeriodColumn {
            key: k.clone(),
            label: k.clone(),
        })
        .collect();

    let cats = load_categories(conn)?;

    let expense_layout = section_layout(&req.expense_category_ids, &cats);
    let income_layout = section_layout(&req.income_category_ids, &cats);
    let expense_selected: HashSet<i64> =
        req.expense_category_ids.iter().copied().collect();
    let income_selected: HashSet<i64> =
        req.income_category_ids.iter().copied().collect();

    let expense_index: HashMap<i64, usize> = expense_layout
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (*id, i))
        .collect();
    let income_index: HashMap<i64, usize> = income_layout
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (*id, i))
        .collect();

    let n_periods = periods.len();
    // Matrix layout: an extra trailing row reserved for "uncategorized".
    let mut expense_values: Vec<Vec<i64>> =
        vec![vec![0_i64; n_periods]; expense_layout.len() + 1];
    let mut income_values: Vec<Vec<i64>> =
        vec![vec![0_i64; n_periods]; income_layout.len() + 1];
    let expense_uncat = expense_layout.len();
    let income_uncat = income_layout.len();

    let txns = load_transactions(conn, &req.account_ids, from, to)?;
    let txn_ids: Vec<i64> = txns.iter().map(|t| t.id).collect();
    let shares = load_shares(conn, &txn_ids)?;
    // Internal transfer links: when *both* sides of a link are present in the
    // currently-loaded txn set (i.e. both account and date filters keep them
    // in scope), neither side counts toward income/expense — they cancel out
    // as an internal movement. If only one half is in scope the visible side
    // surfaces normally.
    let excluded_by_link = excluded_by_paired_link(conn, &txn_ids)?;

    // Group shares by transaction once for fast residual computation.
    let mut shares_by_txn: HashMap<i64, Vec<&ShareRow>> = HashMap::new();
    for s in &shares {
        shares_by_txn.entry(s.transaction_id).or_default().push(s);
    }

    for txn in &txns {
        if excluded_by_link.contains(&txn.id) {
            continue;
        }
        let local = local_date(&txn.occurred_at_utc, &txn.timezone_offset)?;
        if local < from || local > to {
            continue;
        }
        let key = period_key(local, gran);
        let p_idx = match period_index.get(&key) {
            Some(i) => *i,
            None => continue,
        };

        let direction_is_income = txn.credit > 0;
        let total_minor = txn.credit + txn.debit;
        if total_minor == 0 {
            continue;
        }

        let txn_shares = shares_by_txn.get(&txn.id).cloned().unwrap_or_default();
        let mut allocated = 0_i64;

        let (selected_set, layout_index, values, uncat_idx) = if direction_is_income {
            (
                &income_selected,
                &income_index,
                &mut income_values,
                income_uncat,
            )
        } else {
            (
                &expense_selected,
                &expense_index,
                &mut expense_values,
                expense_uncat,
            )
        };

        for s in &txn_shares {
            // Defensive: if a share points at a category whose kind disagrees with the
            // transaction direction, just skip it. The set-categories command already
            // enforces this invariant on write, but the report should not crash.
            let cat = match cats.get(&s.category_id) {
                Some(c) => c,
                None => continue,
            };
            let expected_kind = if direction_is_income { "income" } else { "expense" };
            if cat.kind != expected_kind {
                continue;
            }
            allocated += s.share_minor;
            // New semantics: each share lands in its *own* category if that
            // category is selected; otherwise it falls into "Без категории".
            // We deliberately do NOT promote to the nearest selected ancestor:
            // section totals must stay invariant across checkbox state, so any
            // unselected category's amount has to land in the uncat bucket.
            if selected_set.contains(&s.category_id) {
                let row_idx = match layout_index.get(&s.category_id) {
                    Some(i) => *i,
                    None => continue,
                };
                values[row_idx][p_idx] += s.share_minor;
            } else {
                values[uncat_idx][p_idx] += s.share_minor;
            }
        }

        // Whatever portion of the txn isn't covered by any share is genuinely
        // uncategorised — also park it in the uncat bucket so the section
        // total equals the txn total regardless of selection state.
        let residual = total_minor - allocated;
        if residual > 0 {
            values[uncat_idx][p_idx] += residual;
        }
    }

    let expense_section = build_section(
        &expense_layout,
        &cats,
        &expense_values,
        expense_uncat,
        n_periods,
    );
    let income_section = build_section(
        &income_layout,
        &cats,
        &income_values,
        income_uncat,
        n_periods,
    );

    // Balance metrics walk a separate query — they need pre-range history (to
    // know the running balance entering the first period), and they include
    // correcting transactions, so they can't ride the existing income/expense
    // pipeline.
    let bounds = period_bounds(from, to, gran);
    let history = load_balance_history(conn, &req.account_ids, to)?;
    let (opening_minor, closing_minor) = compute_balance_metrics(&history, &bounds);
    let balances = BalanceMetrics {
        opening: opening_minor.iter().copied().map(format_minor).collect(),
        closing: closing_minor.iter().copied().map(format_minor).collect(),
    };

    Ok(ReportResponse {
        periods,
        expense: expense_section,
        income: income_section,
        balances,
    })
}

fn build_section(
    layout: &[(i64, i32)],
    cats: &HashMap<i64, CatNode>,
    values: &[Vec<i64>],
    uncat_idx: usize,
    n_periods: usize,
) -> SectionData {
    let mut rows: Vec<ReportRow> = Vec::with_capacity(layout.len() + 1);
    let mut section_totals = vec![0_i64; n_periods];

    for (row_idx, (cat_id, depth)) in layout.iter().enumerate() {
        let cat = cats.get(cat_id);
        let row_values = &values[row_idx];
        let total: i64 = row_values.iter().sum();
        for (i, v) in row_values.iter().enumerate() {
            section_totals[i] += *v;
        }
        rows.push(ReportRow {
            category_id: Some(*cat_id),
            name: cat.map(|c| c.name.clone()).unwrap_or_else(|| format!("#{cat_id}")),
            color: cat.map(|c| c.color.clone()).unwrap_or_else(|| "#999999".to_string()),
            depth: *depth,
            values: row_values.iter().copied().map(format_minor).collect(),
            total: format_minor(total),
        });
    }

    // Always show "Без категории" when it carries any amount — keeping the
    // section total invariant across category checkbox state is the whole
    // point of the new allocation rule (see compute_report_inner).
    {
        let row_values = &values[uncat_idx];
        let total: i64 = row_values.iter().sum();
        if total != 0 {
            for (i, v) in row_values.iter().enumerate() {
                section_totals[i] += *v;
            }
            rows.push(ReportRow {
                category_id: None,
                name: String::new(),
                color: String::new(),
                depth: 0,
                values: row_values.iter().copied().map(format_minor).collect(),
                total: format_minor(total),
            });
        }
    }

    let grand_total: i64 = section_totals.iter().sum();
    let mut total_strings: Vec<String> =
        section_totals.iter().copied().map(format_minor).collect();
    total_strings.push(format_minor(grand_total));

    SectionData {
        rows,
        total: total_strings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    // ---------- Pure-helper tests ----------

    #[test]
    fn enumerate_periods_year() {
        let from = NaiveDate::from_ymd_opt(2025, 6, 1).unwrap();
        let to = NaiveDate::from_ymd_opt(2027, 2, 1).unwrap();
        assert_eq!(
            enumerate_periods(from, to, Granularity::Year),
            vec!["2025", "2026", "2027"]
        );
    }

    #[test]
    fn enumerate_periods_quarter_wraps_year() {
        let from = NaiveDate::from_ymd_opt(2025, 11, 1).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 5, 1).unwrap();
        assert_eq!(
            enumerate_periods(from, to, Granularity::Quarter),
            vec!["2025-Q4", "2026-Q1", "2026-Q2"]
        );
    }

    #[test]
    fn enumerate_periods_month_wraps_year() {
        let from = NaiveDate::from_ymd_opt(2025, 12, 1).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 2, 1).unwrap();
        assert_eq!(
            enumerate_periods(from, to, Granularity::Month),
            vec!["2025-12", "2026-01", "2026-02"]
        );
    }

    #[test]
    fn period_key_quarters() {
        assert_eq!(
            period_key(NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(), Granularity::Quarter),
            "2026-Q1"
        );
        assert_eq!(
            period_key(NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(), Granularity::Quarter),
            "2026-Q2"
        );
        assert_eq!(
            period_key(NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(), Granularity::Quarter),
            "2026-Q4"
        );
    }

    #[test]
    fn local_date_respects_timezone_offset() {
        // 22:30 UTC on Apr 30 with +03:00 offset → Apr 31? -> May 1 local.
        let local = local_date("2026-04-30T22:30:00.000Z", "+03:00").unwrap();
        assert_eq!(local, NaiveDate::from_ymd_opt(2026, 5, 1).unwrap());
    }

    #[test]
    fn section_layout_preserves_order_and_nests_children() {
        // Tree: Food (1) → Cafe (2) → Coffee (3); Transport (4); Salary (5, expense, sibling root).
        let cats = sample_cats();
        // User selects Food then Coffee then Transport — Cafe is *not* selected.
        let order = vec![1, 3, 4];
        let layout = section_layout(&order, &cats);
        // Coffee's strict ancestor in selected = Food (1). Transport is a separate root.
        assert_eq!(layout, vec![(1, 0), (3, 1), (4, 0)]);
    }

    #[test]
    fn section_layout_skips_duplicates() {
        let cats = sample_cats();
        let order = vec![1, 1, 4];
        let layout = section_layout(&order, &cats);
        assert_eq!(layout, vec![(1, 0), (4, 0)]);
    }

    fn sample_cats() -> HashMap<i64, CatNode> {
        let mut m = HashMap::new();
        m.insert(1, CatNode { parent_id: None, name: "Food".into(), color: "#a".into(), kind: "expense".into() });
        m.insert(2, CatNode { parent_id: Some(1), name: "Cafe".into(), color: "#b".into(), kind: "expense".into() });
        m.insert(3, CatNode { parent_id: Some(2), name: "Coffee".into(), color: "#c".into(), kind: "expense".into() });
        m.insert(4, CatNode { parent_id: None, name: "Transport".into(), color: "#d".into(), kind: "expense".into() });
        m.insert(5, CatNode { parent_id: None, name: "Salary".into(), color: "#e".into(), kind: "income".into() });
        m
    }

    // ---------- End-to-end pipeline tests (with real DB) ----------

    struct Fixture {
        _dir: TempDir,
        conn: Connection,
        account_id: i64,
        batch_id: i64,
    }

    fn open_fixture(currency: &str) -> Fixture {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let account_id: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('TestBank', ?1, '0001', 'Alice') RETURNING id",
                [currency],
                |r| r.get(0),
            )
            .unwrap();
        let batch_id: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T10:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [account_id],
                |r| r.get(0),
            )
            .unwrap();
        Fixture { _dir: dir, conn, account_id, batch_id }
    }

    fn insert_txn(
        f: &Fixture,
        occurred_at: &str,
        credit: i64,
        debit: i64,
        is_correcting: bool,
    ) -> i64 {
        f.conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, is_correcting)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) RETURNING id",
                params![
                    f.account_id,
                    f.batch_id,
                    occurred_at,
                    credit,
                    debit,
                    if is_correcting { 1 } else { 0 }
                ],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn insert_root_cat(f: &Fixture, name: &str, kind: &str) -> i64 {
        f.conn
            .query_row(
                "INSERT INTO categories (name, color, kind) VALUES (?1, '#abcdef', ?2) RETURNING id",
                params![name, kind],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn insert_child_cat(f: &Fixture, name: &str, parent_id: i64, kind: &str) -> i64 {
        f.conn
            .query_row(
                "INSERT INTO categories (name, color, kind, parent_id)
                 VALUES (?1, '#abcdef', ?2, ?3) RETURNING id",
                params![name, kind, parent_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn link(f: &Fixture, txn_id: i64, cat_id: i64, share_minor: i64, position: i64) {
        f.conn
            .execute(
                "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![txn_id, cat_id, share_minor, position],
            )
            .unwrap();
    }

    fn req(
        accounts: &[i64],
        expense: &[i64],
        income: &[i64],
        from: &str,
        to: &str,
        gran: &str,
    ) -> ReportRequest {
        ReportRequest {
            account_ids: accounts.to_vec(),
            expense_category_ids: expense.to_vec(),
            income_category_ids: income.to_vec(),
            from: from.to_string(),
            to: to.to_string(),
            granularity: gran.to_string(),
        }
    }

    #[test]
    fn aggregates_one_category_over_two_months() {
        let f = open_fixture("RUB");
        let salary = insert_root_cat(&f, "Salary", "income");
        let t1 = insert_txn(&f, "2026-04-15T09:00:00Z", 50000_00, 0, false);
        let t2 = insert_txn(&f, "2026-05-15T09:00:00Z", 60000_00, 0, false);
        link(&f, t1, salary, 50000_00, 0);
        link(&f, t2, salary, 60000_00, 0);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[salary], "2026-04-01", "2026-05-31", "month"),
        )
        .unwrap();

        assert_eq!(resp.periods.iter().map(|p| &p.key).collect::<Vec<_>>(), vec!["2026-04", "2026-05"]);
        assert_eq!(resp.income.rows.len(), 1);
        assert_eq!(resp.income.rows[0].values, vec!["50000.00", "60000.00"]);
        assert_eq!(resp.income.rows[0].total, "110000.00");
        assert_eq!(resp.income.total, vec!["50000.00", "60000.00", "110000.00"]);
        assert!(resp.expense.rows.is_empty());
    }

    #[test]
    fn parent_and_child_both_selected_get_separate_rows() {
        let f = open_fixture("RUB");
        let food = insert_root_cat(&f, "Food", "expense");
        let cafe = insert_child_cat(&f, "Cafe", food, "expense");

        let t_food = insert_txn(&f, "2026-04-10T10:00:00Z", 0, 1000_00, false);
        let t_cafe = insert_txn(&f, "2026-04-12T10:00:00Z", 0, 500_00, false);
        link(&f, t_food, food, 1000_00, 0);
        link(&f, t_cafe, cafe, 500_00, 0);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[food, cafe], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();

        let food_row = resp.expense.rows.iter().find(|r| r.category_id == Some(food)).unwrap();
        let cafe_row = resp.expense.rows.iter().find(|r| r.category_id == Some(cafe)).unwrap();
        assert_eq!(food_row.depth, 0);
        assert_eq!(cafe_row.depth, 1);
        assert_eq!(food_row.total, "1000.00");
        assert_eq!(cafe_row.total, "500.00");
        // Section total = both rows combined.
        assert_eq!(resp.expense.total.last().unwrap(), "1500.00");
    }

    #[test]
    fn unselected_child_lands_in_uncategorized() {
        let f = open_fixture("RUB");
        let food = insert_root_cat(&f, "Food", "expense");
        let cafe = insert_child_cat(&f, "Cafe", food, "expense");

        let t_food = insert_txn(&f, "2026-04-10T10:00:00Z", 0, 800_00, false);
        let t_cafe = insert_txn(&f, "2026-04-12T10:00:00Z", 0, 200_00, false);
        link(&f, t_food, food, 800_00, 0);
        link(&f, t_cafe, cafe, 200_00, 0);

        // User selects only Food. Per the new "totals-invariant" rule Cafe's
        // amount must NOT be promoted into Food — it goes to "Без категории".
        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[food], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();

        assert_eq!(resp.expense.rows.len(), 2, "Food row + uncategorized row");
        let food_row = resp.expense.rows.iter().find(|r| r.category_id == Some(food)).unwrap();
        let uncat_row = resp.expense.rows.iter().find(|r| r.category_id.is_none()).unwrap();
        assert_eq!(food_row.total, "800.00", "Food shows only its own amount");
        assert_eq!(uncat_row.total, "200.00", "Cafe falls into uncategorized");
        // Section total still equals total spent (1000).
        assert_eq!(resp.expense.total.last().unwrap(), "1000.00");
    }

    #[test]
    fn uncategorized_picks_up_residuals_unconditionally() {
        // The uncat row is no longer gated by the show_uncategorized flag —
        // it always appears when there's an unallocated amount, so section
        // totals stay equal to the underlying transaction total.
        let f = open_fixture("RUB");
        let food = insert_root_cat(&f, "Food", "expense");
        let t = insert_txn(&f, "2026-04-15T10:00:00Z", 0, 1000_00, false);
        link(&f, t, food, 600_00, 0);

        let resp = compute_report_inner(
            &f.conn,
            // show_uncat=false in the request — backend ignores it now.
            &req(&[f.account_id], &[food], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();

        assert_eq!(resp.expense.rows.len(), 2, "row for Food + uncategorized row");
        let food_row = resp.expense.rows.iter().find(|r| r.category_id == Some(food)).unwrap();
        let uncat_row = resp.expense.rows.iter().find(|r| r.category_id.is_none()).unwrap();
        assert_eq!(food_row.total, "600.00");
        assert_eq!(uncat_row.total, "400.00");
    }

    #[test]
    fn correcting_transactions_are_skipped() {
        let f = open_fixture("RUB");
        let food = insert_root_cat(&f, "Food", "expense");
        // A correcting transaction tied to Food, plus a regular one — we should only see
        // the regular one in the report.
        let correcting = insert_txn(&f, "2026-04-15T10:00:00Z", 0, 999_00, true);
        let regular = insert_txn(&f, "2026-04-16T10:00:00Z", 0, 50_00, false);
        link(&f, correcting, food, 999_00, 0);
        link(&f, regular, food, 50_00, 0);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[food], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        assert_eq!(resp.expense.rows.len(), 1, "Food row only — uncategorized is empty");
        assert_eq!(resp.expense.rows[0].total, "50.00");
        assert_eq!(resp.expense.total.last().unwrap(), "50.00");
    }

    #[test]
    fn out_of_range_transactions_are_filtered() {
        let f = open_fixture("RUB");
        let salary = insert_root_cat(&f, "Salary", "income");
        let inside = insert_txn(&f, "2026-04-15T09:00:00Z", 100_00, 0, false);
        let before = insert_txn(&f, "2026-03-31T09:00:00Z", 999_00, 0, false);
        let after = insert_txn(&f, "2026-05-01T09:00:00Z", 999_00, 0, false);
        link(&f, inside, salary, 100_00, 0);
        link(&f, before, salary, 999_00, 0);
        link(&f, after, salary, 999_00, 0);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[salary], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        assert_eq!(resp.income.rows.len(), 1);
        assert_eq!(resp.income.rows[0].total, "100.00");
    }

    #[test]
    fn mixed_currency_accounts_sum_one_to_one() {
        // MVP behaviour: USD and RUB accounts are summed as if 1 USD == 1 RUB.
        // The report does not perform conversion yet.
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let usd_acc: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'USD', '1', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rub_acc: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'RUB', '2', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let usd_batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T10:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [usd_acc],
                |r| r.get(0),
            )
            .unwrap();
        let rub_batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T10:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [rub_acc],
                |r| r.get(0),
            )
            .unwrap();
        let salary: i64 = conn
            .query_row(
                "INSERT INTO categories (name, color, kind) VALUES ('Salary', '#000', 'income') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let usd_t: i64 = conn
            .query_row(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-15T09:00:00Z', 50_00, 0, 0) RETURNING id",
                params![usd_acc, usd_batch],
                |r| r.get(0),
            )
            .unwrap();
        let rub_t: i64 = conn
            .query_row(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-20T09:00:00Z', 30_00, 0, 0) RETURNING id",
                params![rub_acc, rub_batch],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
             VALUES (?1, ?2, 50_00, 0), (?3, ?2, 30_00, 0)",
            params![usd_t, salary, rub_t],
        )
        .unwrap();

        let resp = compute_report_inner(
            &conn,
            &ReportRequest {
                account_ids: vec![usd_acc, rub_acc],
                expense_category_ids: vec![],
                income_category_ids: vec![salary],
                from: "2026-04-01".to_string(),
                to: "2026-04-30".to_string(),
                granularity: "month".to_string(),
            },
        )
        .unwrap();
        assert_eq!(resp.income.rows[0].total, "80.00");
    }

    #[test]
    fn filter_by_accounts_excludes_others() {
        let f = open_fixture("RUB");
        // Add a second account that should be excluded.
        let other_acc: i64 = f
            .conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('Other', 'RUB', '99', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let other_batch: i64 = f
            .conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T10:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [other_acc],
                |r| r.get(0),
            )
            .unwrap();
        let salary = insert_root_cat(&f, "Salary", "income");

        let kept = insert_txn(&f, "2026-04-15T09:00:00Z", 100_00, 0, false);
        link(&f, kept, salary, 100_00, 0);
        let dropped: i64 = f
            .conn
            .query_row(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-15T10:00:00Z', 999_00, 0, 0) RETURNING id",
                params![other_acc, other_batch],
                |r| r.get(0),
            )
            .unwrap();
        f.conn
            .execute(
                "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                 VALUES (?1, ?2, 999_00, 0)",
                params![dropped, salary],
            )
            .unwrap();

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[salary], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        assert_eq!(resp.income.rows[0].total, "100.00");
    }

    #[test]
    fn no_categories_selected_routes_everything_to_uncategorized() {
        // With no categories selected for a section, every transaction in
        // that section's direction surfaces as a single "Без категории" row —
        // section totals still equal the underlying transaction totals.
        let f = open_fixture("RUB");
        let _ = insert_txn(&f, "2026-04-15T09:00:00Z", 100_00, 0, false);
        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        // Income txn produced an uncategorised row in the income section.
        assert_eq!(resp.income.rows.len(), 1);
        assert_eq!(resp.income.rows[0].category_id, None);
        assert_eq!(resp.income.rows[0].total, "100.00");
        // Expense section had no transactions at all.
        assert!(resp.expense.rows.is_empty());
        assert_eq!(resp.expense.total, vec!["0.00", "0.00"]);
    }

    #[test]
    fn invalid_request_returns_error() {
        let f = open_fixture("RUB");
        let bad = compute_report_inner(
            &f.conn,
            &req(&[], &[], &[], "2026-04-30", "2026-04-01", "month"),
        );
        assert!(bad.is_err());

        let bad = compute_report_inner(
            &f.conn,
            &req(&[], &[], &[], "2026-04-01", "2026-04-30", "decade"),
        );
        assert!(bad.is_err());
    }

    // ---------- Balance metric tests ----------

    fn insert_txn_with_balance(
        f: &Fixture,
        occurred_at: &str,
        credit: i64,
        debit: i64,
        balance: i64,
        is_correcting: bool,
    ) -> i64 {
        f.conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, is_correcting)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
                params![
                    f.account_id,
                    f.batch_id,
                    occurred_at,
                    credit,
                    debit,
                    balance,
                    if is_correcting { 1 } else { 0 }
                ],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn period_bounds_year_quarter_month() {
        let from = NaiveDate::from_ymd_opt(2026, 2, 15).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 5, 10).unwrap();
        assert_eq!(
            period_bounds(from, to, Granularity::Month),
            vec![
                (NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 2, 28).unwrap()),
                (NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 3, 31).unwrap()),
                (NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 4, 30).unwrap()),
                (NaiveDate::from_ymd_opt(2026, 5, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 5, 31).unwrap()),
            ]
        );
        assert_eq!(
            period_bounds(from, to, Granularity::Quarter),
            vec![
                (NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 3, 31).unwrap()),
                (NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(), NaiveDate::from_ymd_opt(2026, 6, 30).unwrap()),
            ]
        );
        assert_eq!(
            period_bounds(from, to, Granularity::Year),
            vec![(
                NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()
            )]
        );
    }

    #[test]
    fn balance_metrics_running_balance_per_period() {
        let f = open_fixture("RUB");
        // Activity: Apr 5 → 1000.00, Apr 20 → 1500.00, May 10 → 1200.00.
        // Reporting Apr–Jun monthly with no prior history:
        //   Apr opening = 0, closing = 1500.00
        //   May opening = 1500.00, closing = 1200.00
        //   Jun opening = closing = 1200.00 (no activity carries forward)
        insert_txn_with_balance(&f, "2026-04-05T10:00:00Z", 1000_00, 0, 1000_00, false);
        insert_txn_with_balance(&f, "2026-04-20T10:00:00Z", 500_00, 0, 1500_00, false);
        insert_txn_with_balance(&f, "2026-05-10T10:00:00Z", 0, 300_00, 1200_00, false);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[], "2026-04-01", "2026-06-30", "month"),
        )
        .unwrap();
        assert_eq!(resp.balances.opening, vec!["0.00", "1500.00", "1200.00"]);
        assert_eq!(resp.balances.closing, vec!["1500.00", "1200.00", "1200.00"]);
    }

    #[test]
    fn balance_metrics_carries_forward_from_pre_range_history() {
        let f = open_fixture("RUB");
        // A txn before the report range establishes the baseline; the first
        // period's opening must reflect that balance, not zero.
        insert_txn_with_balance(&f, "2026-01-15T10:00:00Z", 5000_00, 0, 5000_00, false);
        insert_txn_with_balance(&f, "2026-04-05T10:00:00Z", 0, 200_00, 4800_00, false);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        assert_eq!(resp.balances.opening, vec!["5000.00"]);
        assert_eq!(resp.balances.closing, vec!["4800.00"]);
    }

    #[test]
    fn balance_metrics_sum_across_accounts() {
        let f = open_fixture("RUB");
        let other_acc: i64 = f
            .conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('Other', 'RUB', '99', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let other_batch: i64 = f
            .conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T10:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [other_acc],
                |r| r.get(0),
            )
            .unwrap();
        // Account A: 1000 → 1500 in April.
        insert_txn_with_balance(&f, "2026-04-10T10:00:00Z", 1000_00, 0, 1000_00, false);
        insert_txn_with_balance(&f, "2026-04-25T10:00:00Z", 500_00, 0, 1500_00, false);
        // Account B (other_acc): pre-range 200, then April activity.
        f.conn
            .execute(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-03-15T10:00:00Z', 200_00, 0, 200_00),
                        (?1, ?2, '2026-04-12T10:00:00Z', 100_00, 0, 300_00)",
                params![other_acc, other_batch],
            )
            .unwrap();

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id, other_acc], &[], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        // Opening: A=0, B=200 → 200
        // Closing: A=1500, B=300 → 1800
        assert_eq!(resp.balances.opening, vec!["200.00"]);
        assert_eq!(resp.balances.closing, vec!["1800.00"]);
    }

    #[test]
    fn balance_metrics_includes_correcting_transactions() {
        // Correcting txns are skipped by the income/expense aggregation but
        // they DO move the bank balance, so the metric must include them.
        let f = open_fixture("RUB");
        insert_txn_with_balance(&f, "2026-04-10T10:00:00Z", 1000_00, 0, 1000_00, false);
        // Correcting entry on Apr 20 jumps balance from 1000 to 950.
        insert_txn_with_balance(&f, "2026-04-20T10:00:00Z", 0, 50_00, 950_00, true);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[f.account_id], &[], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        assert_eq!(resp.balances.closing, vec!["950.00"]);
    }

    #[test]
    fn balance_metrics_empty_when_no_accounts_selected() {
        let f = open_fixture("RUB");
        insert_txn_with_balance(&f, "2026-04-10T10:00:00Z", 100_00, 0, 100_00, false);

        let resp = compute_report_inner(
            &f.conn,
            &req(&[], &[], &[], "2026-04-01", "2026-04-30", "month"),
        )
        .unwrap();
        // Empty account selection produces zero balances, mirroring how the
        // income/expense pipeline treats it.
        assert_eq!(resp.balances.opening, vec!["0.00"]);
        assert_eq!(resp.balances.closing, vec!["0.00"]);
    }

    // ---------- Transfer-link exclusion ----------

    fn fixture_two_accounts_for_transfers() -> (TempDir, Connection, i64, i64, i64, i64) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let a1: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'USD', 'A1', 'O') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let a2: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'USD', 'A2', 'O') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let b1: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [a1],
                |r| r.get(0),
            )
            .unwrap();
        let b2: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                [a2],
                |r| r.get(0),
            )
            .unwrap();
        (dir, conn, a1, a2, b1, b2)
    }

    fn raw_insert_link(conn: &Connection, lo: i64, hi: i64) {
        let (lo, hi) = if lo < hi { (lo, hi) } else { (hi, lo) };
        conn.execute(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
            params![lo, hi],
        )
        .unwrap();
    }

    #[test]
    fn linked_pair_in_scope_is_excluded_from_both_sections() {
        // Transfer between own accounts: outgoing on A1 ($1000), incoming on A2.
        // Both accounts in scope → both rows must be skipped, totals are zero.
        let (_dir, conn, a1, a2, b1, b2) = fixture_two_accounts_for_transfers();
        let out: i64 = conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-10T10:00:00Z', 0, 1000_00, 0) RETURNING id",
                params![a1, b1],
                |r| r.get(0),
            )
            .unwrap();
        let inc: i64 = conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-10T10:00:00Z', 1000_00, 0, 0) RETURNING id",
                params![a2, b2],
                |r| r.get(0),
            )
            .unwrap();
        raw_insert_link(&conn, out, inc);
        let resp = compute_report_inner(
            &conn,
            &ReportRequest {
                account_ids: vec![a1, a2],
                expense_category_ids: vec![],
                income_category_ids: vec![],
                from: "2026-04-01".to_string(),
                to: "2026-04-30".to_string(),
                granularity: "month".to_string(),
            },
        )
        .unwrap();
        // Income+expense fully cancel out — uncategorized rows must not appear.
        assert!(
            resp.income.rows.is_empty() && resp.expense.rows.is_empty(),
            "linked pair should fully cancel: income={:?} expense={:?}",
            resp.income.rows,
            resp.expense.rows
        );
        assert_eq!(resp.income.total, vec!["0.00", "0.00"]);
        assert_eq!(resp.expense.total, vec!["0.00", "0.00"]);
    }

    #[test]
    fn linked_pair_with_only_one_side_in_scope_keeps_it() {
        // Same link as above, but the report is scoped to only A1 — so the
        // partner on A2 isn't in `txn_ids`. The visible side must remain in
        // its uncategorized row.
        let (_dir, conn, a1, a2, b1, b2) = fixture_two_accounts_for_transfers();
        let out: i64 = conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-10T10:00:00Z', 0, 1000_00, 0) RETURNING id",
                params![a1, b1],
                |r| r.get(0),
            )
            .unwrap();
        let inc: i64 = conn
            .query_row(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-04-10T10:00:00Z', 1000_00, 0, 0) RETURNING id",
                params![a2, b2],
                |r| r.get(0),
            )
            .unwrap();
        raw_insert_link(&conn, out, inc);
        let resp = compute_report_inner(
            &conn,
            &ReportRequest {
                account_ids: vec![a1],
                expense_category_ids: vec![],
                income_category_ids: vec![],
                from: "2026-04-01".to_string(),
                to: "2026-04-30".to_string(),
                granularity: "month".to_string(),
            },
        )
        .unwrap();
        assert_eq!(resp.expense.rows.len(), 1, "outgoing side surfaces as uncategorized");
        assert_eq!(resp.expense.rows[0].total, "1000.00");
        assert!(resp.income.rows.is_empty());
    }
}
