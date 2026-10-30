//! Cash-account entries from a text description. See
//! `docs/plans/cash-dictation.md`.
//!
//! The owner describes what to enter ("rent 25 000 on the 5th, January to
//! October; once 4 500 for the bike on March 3rd"), the model turns it into a
//! plan — repeating rules and one-off entries — and the app expands the rules
//! into dated rows itself: date arithmetic is code, not the model. Nothing is
//! written until the owner confirms the preview (`create_cash_entries`).

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai;
use crate::cash_transactions::{
    ensure_cash_account, insert_cash_row, normalize_occurred_at, normalize_optional,
    recompute_cash_balances, CashDirection,
};
use crate::category_agent::{self as agent, LogEntry};
use crate::db::DbState;
use crate::host::{AppHandle, State};
use crate::money;
use crate::suggestions::Lang;

/// One retry when the answer does not parse.
const MAX_ATTEMPTS: usize = 2;
/// Recent entries of the account the model sees, so "as last month" works.
const RECENT_ENTRIES: usize = 40;
/// A guard against a runaway rule ("every month since 1990").
const MAX_ROWS: usize = 1000;

pub(crate) const EVENT_CALL: &str = "cash_dictation_call";
const EVENT_CREATED: &str = "cash_dictation_created";

const ERR_EMPTY: &str = "cash_dictation.empty";
const ERR_TOO_MANY: &str = "cash_dictation.too_many_rows";

const SYSTEM_TEMPLATE: &str = "You prepare entries for a cash account (banknotes in a wallet) \
of a personal-finance app. The owner describes in free text which entries they need — usually \
the same spending every month — and you turn the description into a plan. You do not chat: \
you return exactly one JSON object.

## The account

{account}

Today is {today}. Read relative dates (\"since last January\", \"until the end of the year\") \
from today.

{life}## Categories

Format: `id: path — description`. Spending (\"out\") takes an expense category, money coming \
in (\"in\") an income one. Any node may be chosen, not only a leaf. Use null when the \
description does not tell the category and the recent entries do not settle it.

### Expense

{expense}

### Income

{income}

## Recent entries of this account

The owner's own entries, newest first: `date | in/out amount | category | counterparty | comment`. \
Follow their wording of comments and counterparties and their categories for the same spending.

{recent}

## Answer

Reply with a single JSON object and nothing else:

{\"rules\": [{\"direction\": \"out\", \"amount\": \"25000.00\", \"categoryId\": 12, \
\"peer\": null, \"comment\": \"Rent\", \"day\": 5, \"from\": \"2026-01\", \"to\": \"2026-10\", \
\"everyMonths\": 1}],
 \"once\": [{\"date\": \"2026-03-03\", \"direction\": \"out\", \"amount\": \"4500.00\", \
\"categoryId\": 7, \"peer\": null, \"comment\": \"Bike repair\"}],
 \"notes\": \"<assumptions you made or what was unclear, in {language}; empty when none>\"}

- `rules` repeat: one entry per month from `from` to `to` inclusive (`YYYY-MM`), every \
`everyMonths` months (1 monthly, 3 quarterly, 12 yearly). `day` is the day of the month \
(1-31; the app moves it to the last day in shorter months) or \"last\".
- `once` are single entries with an exact `date` (`YYYY-MM-DD`).
- `amount` is a positive number in the account currency, without the currency sign.
- Several items with the same schedule are separate rules — one rule per amount and category.
- Write `comment` and `peer` in the owner's language, as short as their recent entries.
- Never invent entries the description does not ask for. When a month range is not said, \
ask in `notes` rather than guess a long one; a missing day of the month is the 1st.";

// ---------------------------------------------------------------------------
// The plan the model returns
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Day {
    Of(u32),
    Last,
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    incoming: bool,
    amount_minor: i64,
    category_id: Option<i64>,
    peer: Option<String>,
    comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Rule {
    entry: Entry,
    day: Day,
    from: (i32, u32),
    to: (i32, u32),
    every_months: u32,
}

#[derive(Debug, Clone, PartialEq)]
struct Once {
    entry: Entry,
    date: NaiveDate,
}

#[derive(Debug, Clone, PartialEq, Default)]
struct Plan {
    rules: Vec<Rule>,
    once: Vec<Once>,
    notes: Option<String>,
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn month(v: &Value, field: &str) -> Result<(i32, u32), String> {
    let s = v.as_str().ok_or(format!("{field} is not a YYYY-MM string"))?;
    let date = NaiveDate::parse_from_str(&format!("{}-01", s.trim().get(..7).unwrap_or(s)), "%Y-%m-%d")
        .map_err(|_| format!("{field} '{s}' is not YYYY-MM"))?;
    Ok((date.year(), date.month()))
}

fn entry(v: &Value, what: &str) -> Result<Entry, String> {
    let incoming = match v["direction"].as_str().map(str::trim) {
        Some("in") => true,
        Some("out") => false,
        other => return Err(format!("{what}: direction {other:?} is not \"in\" or \"out\"")),
    };
    let amount = match &v["amount"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err(format!("{what}: amount is missing")),
    };
    let amount_minor = money::parse_minor(&amount).map_err(|e| format!("{what}: amount '{amount}': {e}"))?;
    if amount_minor <= 0 {
        return Err(format!("{what}: amount must be positive"));
    }
    let category_id = match &v["categoryId"] {
        Value::Null => None,
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    Ok(Entry { incoming, amount_minor, category_id, peer: text(&v["peer"]), comment: text(&v["comment"]) })
}

/// The first `{` … last `}` of the reply as the plan.
fn parse_plan(content: &str) -> Result<Plan, String> {
    let (Some(start), Some(end)) = (content.find('{'), content.rfind('}')) else {
        return Err("the reply has no JSON object".to_string());
    };
    if end < start {
        return Err("the reply has no JSON object".to_string());
    }
    let v: Value = serde_json::from_str(&content[start..=end]).map_err(|e| format!("invalid JSON: {e}"))?;
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    let mut plan = Plan { notes: text(&v["notes"]), ..Default::default() };
    for (i, r) in list("rules").iter().enumerate() {
        let what = format!("rules[{i}]");
        let day = match &r["day"] {
            Value::String(s) if s.trim().eq_ignore_ascii_case("last") => Day::Last,
            Value::Null => Day::Of(1),
            d => {
                let n = d.as_u64().or_else(|| d.as_str().and_then(|s| s.trim().parse().ok()));
                match n {
                    Some(n @ 1..=31) => Day::Of(n as u32),
                    _ => return Err(format!("{what}: day {d} is not 1-31 or \"last\"")),
                }
            }
        };
        let from = month(&r["from"], &format!("{what}.from"))?;
        let to = month(&r["to"], &format!("{what}.to"))?;
        if to < from {
            return Err(format!("{what}: `to` is before `from`"));
        }
        let every_months = match r["everyMonths"].as_u64() {
            None => 1,
            Some(n @ 1..=12) => n as u32,
            Some(n) => return Err(format!("{what}: everyMonths {n} is not 1-12")),
        };
        plan.rules.push(Rule { entry: entry(r, &what)?, day, from, to, every_months });
    }
    for (i, o) in list("once").iter().enumerate() {
        let what = format!("once[{i}]");
        let raw = o["date"].as_str().unwrap_or("").trim();
        let date = NaiveDate::parse_from_str(raw.get(..10).unwrap_or(raw), "%Y-%m-%d")
            .map_err(|_| format!("{what}: date '{raw}' is not YYYY-MM-DD"))?;
        plan.once.push(Once { entry: entry(o, &what)?, date });
    }
    Ok(plan)
}

// ---------------------------------------------------------------------------
// The rows the app derives from the plan
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRow {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    /// `in` | `out`.
    pub direction: String,
    pub amount: String,
    pub category_id: Option<i64>,
    pub peer: Option<String>,
    pub comment: Option<String>,
    /// Index into the plan's rules; `None` for a one-off entry.
    pub rule_index: Option<usize>,
    /// The rule's day does not exist in this month: moved to its last day.
    pub moved_to_month_end: bool,
    /// The model named a category that is not in the list or not of the
    /// entry's kind; the row came without one.
    pub category_dropped: bool,
}

fn last_day(y: i32, m: u32) -> NaiveDate {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid month") - Duration::days(1)
}

/// `allowed` maps a category id to whether it is an income one.
fn expand(plan: &Plan, allowed: &std::collections::HashMap<i64, bool>) -> Result<Vec<DraftRow>, String> {
    let row = |e: &Entry, date: NaiveDate, rule_index, moved| {
        let fits = e.category_id.is_some_and(|id| allowed.get(&id) == Some(&e.incoming));
        DraftRow {
            date: date.format("%Y-%m-%d").to_string(),
            direction: if e.incoming { "in" } else { "out" }.to_string(),
            amount: money::format_minor(e.amount_minor),
            category_id: e.category_id.filter(|_| fits),
            peer: e.peer.clone(),
            comment: e.comment.clone(),
            rule_index,
            moved_to_month_end: moved,
            category_dropped: e.category_id.is_some() && !fits,
        }
    };
    let mut rows = Vec::new();
    for (i, r) in plan.rules.iter().enumerate() {
        let (mut y, mut m) = r.from;
        while (y, m) <= r.to {
            let end = last_day(y, m);
            let (date, moved) = match r.day {
                Day::Last => (end, false),
                Day::Of(d) if d > end.day() => (end, true),
                Day::Of(d) => (NaiveDate::from_ymd_opt(y, m, d).expect("day within the month"), false),
            };
            rows.push(row(&r.entry, date, Some(i), moved));
            if rows.len() > MAX_ROWS {
                return Err(ERR_TOO_MANY.to_string());
            }
            let next = m - 1 + r.every_months;
            y += (next / 12) as i32;
            m = next % 12 + 1;
        }
    }
    rows.extend(plan.once.iter().map(|o| row(&o.entry, o.date, None, false)));
    if rows.len() > MAX_ROWS {
        return Err(ERR_TOO_MANY.to_string());
    }
    rows.sort_by(|a, b| a.date.cmp(&b.date).then(a.rule_index.cmp(&b.rule_index)));
    Ok(rows)
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

fn fill(template: &str, pairs: &[(&str, &str)]) -> String {
    pairs.iter().fold(template.to_string(), |acc, (k, v)| acc.replace(&format!("{{{k}}}"), v))
}

/// The account's newest entries as prompt lines. Dates are the owner's local
/// ones: cash entries are stored in UTC, the browser knows the offset.
fn recent_lines(conn: &Connection, account_id: i64, tz_offset_minutes: i32) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.occurred_at_utc, t.credit, t.debit, t.peer, t.comment,
                    (SELECT group_concat(tc.category_id) FROM transaction_categories tc
                      WHERE tc.transaction_id = t.id)
             FROM transactions t WHERE t.account_id = ?1
             ORDER BY t.occurred_at_utc DESC, t.id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    type Recent = (String, i64, i64, Option<String>, Option<String>, Option<String>);
    let rows: Vec<Recent> = stmt
        .query_map(params![account_id, RECENT_ENTRIES as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok("(no entries yet)".to_string());
    }
    let paths: std::collections::HashMap<i64, String> =
        agent::agent_category_paths(conn)?.into_iter().map(|(id, path, ..)| (id, path)).collect();
    let lines: Vec<String> = rows
        .into_iter()
        .map(|(utc, credit, debit, peer, comment, cats)| {
            let date = chrono::DateTime::parse_from_rfc3339(&utc)
                .map(|d| (d + Duration::minutes(tz_offset_minutes as i64)).format("%Y-%m-%d").to_string())
                .unwrap_or(utc);
            let amount = if credit > 0 {
                format!("in {}", money::format_minor(credit))
            } else {
                format!("out {}", money::format_minor(debit))
            };
            let cats = cats
                .unwrap_or_default()
                .split(',')
                .filter_map(|id| id.parse::<i64>().ok())
                .map(|id| paths.get(&id).map(|p| format!("{id}: {p}")).unwrap_or_else(|| "—".to_string()))
                .collect::<Vec<_>>()
                .join(" + ");
            let or_dash = |s: Option<String>| s.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "—".to_string());
            format!(
                "{date} | {amount} | {} | {} | {}",
                if cats.is_empty() { "—".to_string() } else { cats },
                or_dash(peer),
                or_dash(comment)
            )
        })
        .collect();
    Ok(lines.join("\n"))
}

struct Prompt {
    system: String,
    /// Category id → is it an income one.
    allowed: std::collections::HashMap<i64, bool>,
}

fn build_prompt(conn: &Connection, account_id: i64, today: &str, tz_offset_minutes: i32) -> Result<Prompt, String> {
    let (name, currency): (String, String) = conn
        .query_row("SELECT name, currency FROM accounts WHERE id = ?1", [account_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    let paths = agent::agent_category_paths(conn)?;
    let allowed = paths.iter().map(|(id, _, kind, ..)| (*id, kind == "income")).collect();
    let lang = Lang::of(conn);
    let account = format!("Name: {}\nCurrency: {currency}", if name.trim().is_empty() { "—" } else { name.trim() });
    let system = fill(
        SYSTEM_TEMPLATE,
        &[
            ("account", &account),
            ("today", today),
            ("life", &agent::life_section(conn)?),
            ("expense", &agent::category_lines(&paths, "expense")),
            ("income", &agent::category_lines(&paths, "income")),
            ("recent", &recent_lines(conn, account_id, tz_offset_minutes)?),
            ("language", lang.pick("Russian", "English")),
        ],
    );
    Ok(Prompt { system, allowed })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashDraft {
    pub rows: Vec<DraftRow>,
    pub rule_count: usize,
    pub once_count: usize,
    /// The model's assumptions and questions.
    pub notes: Option<String>,
    /// The `agent_log` row of the call — `create_cash_entries` refers to it.
    pub log_id: i64,
    pub total_tokens: i64,
    pub duration_ms: i64,
}

/// Ask the agent's model for a plan and expand it into rows. `today` is the
/// owner's local date and `tz_offset_minutes` their offset from UTC (east
/// positive), both from the browser.
pub async fn draft_cash_entries(
    app: AppHandle,
    account_id: i64,
    text: String,
    today: String,
    tz_offset_minutes: i32,
) -> Result<CashDraft, String> {
    if text.trim().is_empty() {
        return Err(ERR_EMPTY.to_string());
    }
    let (connection, api_key, prompt) = {
        let conn = app.db().lock().map_err(|e| e.to_string())?;
        ensure_cash_account(&conn, account_id)?;
        let connection_id: i64 = conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", [ai::AGENT_CONNECTION_KEY], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .and_then(|v| v.parse().ok())
            .ok_or(agent::ERR_NO_CONNECTION)?;
        let connection =
            ai::load_connection(&conn, connection_id).map_err(|_| agent::ERR_NO_CONNECTION.to_string())?;
        let api_key = ai::resolve_api_key(&connection.api_key).map_err(|e| format!("{}: {e}", connection.name))?;
        (connection, api_key, build_prompt(&conn, account_id, &today, tz_offset_minutes)?)
    };
    let prompt_hash = agent::sha256_hex(&[&prompt.system]);

    let mut messages = vec![("user".to_string(), text.trim().to_string())];
    let (mut total_tokens, mut duration_ms) = (0i64, 0i64);
    for attempt in 1..=MAX_ATTEMPTS {
        let result = ai::chat(&connection, &api_key, &prompt.system, &messages).await;
        let conn = app.db().lock().map_err(|e| e.to_string())?;
        let details = json!({ "attempt": attempt, "accountId": account_id, "today": today });
        let reply = match result {
            Err(e) => {
                agent::log(
                    &conn,
                    LogEntry {
                        event: EVENT_CALL,
                        connection: Some(&connection),
                        prompt_hash: Some(&prompt_hash),
                        request: Some(&e.request),
                        response: e.response.as_ref(),
                        error: Some(&e.message),
                        duration_ms: Some(e.duration_ms),
                        details: Some(details),
                        ..Default::default()
                    },
                )?;
                return Err(e.message);
            }
            Ok(reply) => reply,
        };
        duration_ms += reply.duration_ms;
        total_tokens += reply.usage.total_tokens.unwrap_or(0);
        let outcome = parse_plan(&reply.content).and_then(|plan| {
            let rows = expand(&plan, &prompt.allowed)?;
            Ok((plan, rows))
        });
        agent::log(
            &conn,
            LogEntry {
                event: EVENT_CALL,
                connection: Some(&connection),
                prompt_hash: Some(&prompt_hash),
                request: Some(&reply.request),
                response: Some(&reply.response),
                result: outcome.as_ref().ok().map(|(plan, rows)| {
                    json!({
                        "rules": plan.rules.len(),
                        "once": plan.once.len(),
                        "rows": rows,
                        "notes": plan.notes,
                    })
                }),
                error: outcome.as_ref().err().map(String::as_str),
                usage: Some(&reply.usage),
                duration_ms: Some(reply.duration_ms),
                details: Some(details),
                ..Default::default()
            },
        )?;
        let log_id = conn.last_insert_rowid();
        match outcome {
            Ok((plan, rows)) => {
                return Ok(CashDraft {
                    rows,
                    rule_count: plan.rules.len(),
                    once_count: plan.once.len(),
                    notes: plan.notes,
                    log_id,
                    total_tokens,
                    duration_ms,
                })
            }
            // Too many rows is the owner's description, not a format slip.
            Err(e) if e == ERR_TOO_MANY => return Err(e),
            Err(e) if attempt == MAX_ATTEMPTS => return Err(e),
            Err(e) => {
                messages.push(("assistant".to_string(), reply.content));
                messages.push((
                    "user".to_string(),
                    format!("Your answer could not be used: {e}. Reply again with only the JSON object."),
                ));
            }
        }
    }
    unreachable!("the loop returns on its last attempt")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashEntryInput {
    pub occurred_at_utc: String,
    pub direction: CashDirection,
    pub amount: String,
    pub category_id: Option<i64>,
    pub peer: Option<String>,
    pub comment: Option<String>,
}

/// Create the confirmed rows in one SQL transaction: each with its category
/// on the whole amount; the balance is recomputed once from the earliest.
/// `log_id`, `proposed` and `edited` only go to the agent log.
pub fn create_cash_entries(
    state: State<'_, DbState>,
    account_id: i64,
    entries: Vec<CashEntryInput>,
    log_id: Option<i64>,
    proposed: usize,
    edited: usize,
) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;
    ensure_cash_account(conn, account_id)?;
    if entries.is_empty() {
        return Ok(0);
    }
    let allowed: std::collections::HashMap<i64, bool> = agent::agent_category_paths(conn)?
        .into_iter()
        .map(|(id, _, kind, ..)| (id, kind == "income"))
        .collect();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut earliest: Option<String> = None;
    for e in &entries {
        let occurred_at = normalize_occurred_at(&e.occurred_at_utc)?;
        let minor = money::parse_minor(&e.amount).map_err(|err| err.to_string())?;
        if minor <= 0 {
            return Err(format!("amount '{}' must be positive", e.amount));
        }
        let incoming = matches!(e.direction, CashDirection::In);
        if let Some(id) = e.category_id {
            if allowed.get(&id) != Some(&incoming) {
                return Err(format!("category {id} does not fit an {} entry", if incoming { "income" } else { "expense" }));
            }
        }
        let (credit, debit) = if incoming { (minor, 0) } else { (0, minor) };
        let peer = normalize_optional(e.peer.clone());
        let comment = normalize_optional(e.comment.clone());
        let id = insert_cash_row(&tx, account_id, &occurred_at, credit, debit, peer.as_deref(), comment.as_deref())?;
        if let Some(category_id) = e.category_id {
            tx.execute(
                "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                 VALUES (?1, ?2, ?3, 0)",
                params![id, category_id, minor],
            )
            .map_err(|e| e.to_string())?;
        }
        if earliest.as_ref().is_none_or(|t| occurred_at < *t) {
            earliest = Some(occurred_at);
        }
    }
    if let Some(from) = earliest {
        recompute_cash_balances(&tx, account_id, &from).map_err(|e| e.to_string())?;
    }
    agent::log(
        &tx,
        LogEntry {
            event: EVENT_CREATED,
            details: Some(json!({
                "accountId": account_id,
                "callLogId": log_id,
                "proposed": proposed,
                "created": entries.len(),
                "edited": edited,
            })),
            ..Default::default()
        },
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn dates(rows: &[DraftRow]) -> Vec<&str> {
        rows.iter().map(|r| r.date.as_str()).collect()
    }

    #[test]
    fn rules_expand_month_by_month_and_clamp_short_months() {
        let plan = parse_plan(
            r#"Here you go: {"rules": [{"direction": "out", "amount": 25000, "categoryId": 1,
                "comment": "Аренда", "day": 31, "from": "2026-01", "to": "2026-04"}],
              "once": [{"date": "2026-02-10", "direction": "out", "amount": "4500.50", "categoryId": null}],
              "notes": ""}"#,
        )
        .unwrap();
        let rows = expand(&plan, &HashMap::from([(1, false)])).unwrap();
        assert_eq!(dates(&rows), ["2026-01-31", "2026-02-10", "2026-02-28", "2026-03-31", "2026-04-30"]);
        assert_eq!(rows[0].amount, "25000.00");
        assert_eq!(rows[1].amount, "4500.50");
        assert_eq!(rows[1].rule_index, None);
        assert!(rows[2].moved_to_month_end && !rows[3].moved_to_month_end);
        assert_eq!(rows[0].comment.as_deref(), Some("Аренда"));
        assert_eq!(plan.notes, None);
    }

    #[test]
    fn quarterly_rules_cross_the_year_and_last_day_works() {
        let plan = parse_plan(
            r#"{"rules": [{"direction": "out", "amount": "100", "day": "last", "from": "2025-11",
                "to": "2026-08", "everyMonths": 3}], "once": []}"#,
        )
        .unwrap();
        let rows = expand(&plan, &HashMap::new()).unwrap();
        assert_eq!(dates(&rows), ["2025-11-30", "2026-02-28", "2026-05-31", "2026-08-31"]);
        assert!(rows.iter().all(|r| !r.moved_to_month_end));
    }

    #[test]
    fn a_category_of_the_wrong_kind_or_unknown_is_dropped() {
        let plan = parse_plan(
            r#"{"rules": [], "once": [
                {"date": "2026-01-01", "direction": "out", "amount": "1", "categoryId": 2},
                {"date": "2026-01-02", "direction": "out", "amount": "1", "categoryId": 99},
                {"date": "2026-01-03", "direction": "in", "amount": "1", "categoryId": 2}]}"#,
        )
        .unwrap();
        let rows = expand(&plan, &HashMap::from([(2, true)])).unwrap();
        assert_eq!(rows.iter().map(|r| (r.category_id, r.category_dropped)).collect::<Vec<_>>(), [
            (None, true),
            (None, true),
            (Some(2), false)
        ]);
    }

    #[test]
    fn broken_plans_are_rejected() {
        assert!(parse_plan("no json").is_err());
        assert!(parse_plan(r#"{"rules": [{"direction": "out", "amount": "1", "from": "2026-05", "to": "2026-01"}]}"#).is_err());
        assert!(parse_plan(r#"{"once": [{"date": "2026-13-01", "direction": "out", "amount": "1"}]}"#).is_err());
        assert!(parse_plan(r#"{"once": [{"date": "2026-01-01", "direction": "sideways", "amount": "1"}]}"#).is_err());
        assert!(parse_plan(r#"{"once": [{"date": "2026-01-01", "direction": "out", "amount": "-5"}]}"#).is_err());
    }

    #[test]
    fn a_runaway_rule_is_refused() {
        let plan = parse_plan(
            r#"{"rules": [{"direction": "out", "amount": "1", "day": 1, "from": "1900-01", "to": "2026-01"}]}"#,
        )
        .unwrap();
        assert_eq!(expand(&plan, &HashMap::new()).unwrap_err(), ERR_TOO_MANY);
    }

    #[test]
    fn entries_are_created_with_categories_and_one_balance_chain() {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let cash: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency) VALUES ('Cash', 'cash', 'Cash', 'THB') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let rent: i64 = conn
            .query_row(
                "INSERT INTO categories (name, color, kind) VALUES ('Rent', '#000000', 'expense') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let state: DbState = std::sync::Mutex::new(conn);
        let entry = |at: &str, direction, amount: &str, category_id| CashEntryInput {
            occurred_at_utc: at.to_string(),
            direction,
            amount: amount.to_string(),
            category_id,
            peer: None,
            comment: Some("  ".to_string()),
        };
        let created = create_cash_entries(
            &state,
            cash,
            vec![
                entry("2026-02-05T05:00:00.000Z", CashDirection::Out, "300", Some(rent)),
                entry("2026-01-05T05:00:00.000Z", CashDirection::In, "1000", None),
                entry("2026-03-05T05:00:00.000Z", CashDirection::Out, "300", Some(rent)),
            ],
            None,
            3,
            0,
        )
        .unwrap();
        assert_eq!(created, 3);
        let conn = state.lock().unwrap();
        let rows: Vec<(i64, Option<String>, Option<i64>)> = conn
            .prepare(
                "SELECT t.balance, t.comment, tc.share_minor FROM transactions t
                 LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
                 ORDER BY t.occurred_at_utc",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows, [(1000_00, None, None), (700_00, None, Some(300_00)), (400_00, None, Some(300_00))]);
        drop(conn);

        // An expense category on an income entry is refused, nothing written.
        let err = create_cash_entries(
            &state,
            cash,
            vec![entry("2026-04-05T05:00:00.000Z", CashDirection::In, "1", Some(rent))],
            None,
            1,
            0,
        );
        assert!(err.is_err());
        let count: i64 = state.lock().unwrap().query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 3);
    }
}
