//! The category agent: an LLM suggests one category for a transaction,
//! following how this particular user categorises. See
//! `docs/plans/category-agent.md`.
//!
//! What makes it the user's agent:
//! - **Examples balanced by category.** For every category of the right kind
//!   the prompt gets up to N of the user's own categorised transactions: the
//!   ones they marked as examples first, then — unless turned off — recent
//!   ones picked automatically (distinct counterparties first). Plus a few
//!   earlier transactions with the same counterparty. Never the whole history.
//! - **The user's instructions** (Settings → AI) go into the system prompt.
//!   The technical part (category list, answer format) is the app's and is not
//!   editable, so instructions cannot break parsing.
//!
//! Every model call is written to `agent_log` with the full exchange and the
//! token usage, and so is every user decision about a category suggestion —
//! the raw material for evals.
//!
//! The model sees [`SuggestionContext`] only: text, never the balance, never
//! slip images (their notes were extracted at recognition).

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ai::{self, AiConnection};
use crate::db::DbState;
use crate::host::{AppHandle, State};
use crate::suggestions::{self as sg, Facts, Lang, SuggestionContext};

const INSTRUCTIONS_KEY: &str = "agent.instructions";
const EXAMPLES_PER_CATEGORY_KEY: &str = "agent.examples_per_category";
const AUTO_EXAMPLES_KEY: &str = "agent.auto_examples";
const MIN_CONFIDENCE_KEY: &str = "agent.min_confidence";
/// Below this the answer is not offered: the user wants the obvious cases
/// done and the doubtful ones left to them.
const DEFAULT_MIN_CONFIDENCE: i64 = 8;
const DEFAULT_EXAMPLES_PER_CATEGORY: usize = 3;
const MAX_EXAMPLES_PER_CATEGORY: usize = 10;
/// Earlier transactions with the same counterparty, on top of the balanced set.
const SAME_PEER_EXAMPLES: usize = 5;
/// One retry when the answer does not parse or names a wrong category.
const MAX_ATTEMPTS: usize = 2;

const ERR_NO_CONNECTION: &str = "agent.no_connection";
const ERR_NOT_FOUND: &str = "agent.not_found";
/// Skip reason: the model was not sure (abstained or below the threshold).
const SKIP_NOT_CONFIDENT: &str = "not_confident";

const EVENT_LLM_CALL: &str = "llm_call";
const EVENT_APPLIED: &str = "suggestion_applied";
const EVENT_DISMISSED: &str = "suggestion_dismissed";
const EVENT_SET_MANUALLY: &str = "category_set_manually";
const EVENT_EXAMPLE_MARKED: &str = "example_marked";
const EVENT_EXAMPLE_UNMARKED: &str = "example_unmarked";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

fn put_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn default_instructions(lang: Lang) -> &'static str {
    lang.pick(
        "Опирайся прежде всего на то, как я сам категоризовал похожие транзакции (примеры ниже): \
тот же контрагент, похожие заметки, тот же период жизни.\n\
Заметки со слипов и мой комментарий важнее описания банка.\n\
Контекст жизни (поездка, болезнь, гости…) может определять категорию сильнее, чем магазин или контрагент.\n\
Если не уверен в подкатегории — выбирай родительскую категорию и честно снижай уверенность.",
        "Rely first of all on how I categorised similar transactions myself (examples below): \
the same counterparty, similar notes, the same period of life.\n\
Slip notes and my own comment matter more than the bank description.\n\
The life context (a trip, an illness, guests…) may decide the category more than the shop or counterparty does.\n\
When unsure about the subcategory, choose the parent category and lower the confidence honestly.",
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub connection_id: Option<i64>,
    pub instructions: String,
    pub default_instructions: String,
    pub examples_per_category: usize,
    pub auto_examples: bool,
    /// Answers below this confidence (0–10) are not offered.
    pub min_confidence: i64,
}

fn load_settings(conn: &Connection) -> Result<AgentSettings, String> {
    let lang = Lang::of(conn);
    let connection_id = setting(conn, ai::AGENT_CONNECTION_KEY)?.and_then(|v| v.parse().ok());
    let instructions =
        setting(conn, INSTRUCTIONS_KEY)?.unwrap_or_else(|| default_instructions(lang).to_string());
    let examples_per_category = setting(conn, EXAMPLES_PER_CATEGORY_KEY)?
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_EXAMPLES_PER_CATEGORY)
        .min(MAX_EXAMPLES_PER_CATEGORY);
    let auto_examples = setting(conn, AUTO_EXAMPLES_KEY)?.is_none_or(|v| v != "0");
    let min_confidence = setting(conn, MIN_CONFIDENCE_KEY)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_MIN_CONFIDENCE)
        .clamp(0, 10);
    Ok(AgentSettings {
        connection_id,
        instructions,
        default_instructions: default_instructions(lang).to_string(),
        examples_per_category,
        auto_examples,
        min_confidence,
    })
}

pub fn get_agent_settings(state: State<'_, DbState>) -> Result<AgentSettings, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    load_settings(&conn)
}

pub fn save_agent_settings(
    state: State<'_, DbState>,
    connection_id: Option<i64>,
    instructions: String,
    examples_per_category: usize,
    auto_examples: bool,
    min_confidence: i64,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    match connection_id {
        Some(id) => {
            ai::load_connection(&conn, id)?;
            put_setting(&conn, ai::AGENT_CONNECTION_KEY, &id.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM app_settings WHERE key = ?1", [ai::AGENT_CONNECTION_KEY])
                .map_err(|e| e.to_string())?;
        }
    }
    put_setting(&conn, INSTRUCTIONS_KEY, instructions.trim())?;
    put_setting(
        &conn,
        EXAMPLES_PER_CATEGORY_KEY,
        &examples_per_category.min(MAX_EXAMPLES_PER_CATEGORY).to_string(),
    )?;
    put_setting(&conn, AUTO_EXAMPLES_KEY, if auto_examples { "1" } else { "0" })?;
    put_setting(&conn, MIN_CONFIDENCE_KEY, &min_confidence.clamp(0, 10).to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub(crate) struct LogEntry<'a> {
    pub event: &'a str,
    pub transaction_id: Option<i64>,
    pub suggestion_id: Option<i64>,
    pub suggested_category_id: Option<i64>,
    pub chosen_category_id: Option<i64>,
    pub connection: Option<&'a AiConnection>,
    pub prompt_hash: Option<&'a str>,
    pub request: Option<&'a Value>,
    pub response: Option<&'a Value>,
    pub result: Option<Value>,
    pub error: Option<&'a str>,
    pub usage: Option<&'a ai::Usage>,
    pub duration_ms: Option<i64>,
    pub details: Option<Value>,
}

pub(crate) fn log(conn: &Connection, e: LogEntry) -> Result<(), String> {
    let json = |v: Option<&Value>| v.map(Value::to_string);
    conn.execute(
        "INSERT INTO agent_log
           (event, transaction_id, suggestion_id, suggested_category_id, chosen_category_id,
            connection_name, protocol, base_url, model, prompt_hash, request, response, result,
            error, prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, duration_ms,
            details)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                 ?19, ?20)",
        params![
            e.event,
            e.transaction_id,
            e.suggestion_id,
            e.suggested_category_id,
            e.chosen_category_id,
            e.connection.map(|c| c.name.as_str()),
            e.connection.map(|c| c.protocol.as_str()),
            e.connection.map(|c| c.base_url.as_str()),
            e.connection.map(|c| c.model.as_str()),
            e.prompt_hash,
            json(e.request),
            json(e.response),
            json(e.result.as_ref()),
            e.error,
            e.usage.and_then(|u| u.prompt_tokens),
            e.usage.and_then(|u| u.completion_tokens),
            e.usage.and_then(|u| u.reasoning_tokens),
            e.usage.and_then(|u| u.total_tokens),
            e.duration_ms,
            json(e.details.as_ref()),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The user's decision about a category suggestion (called from
/// `suggestions::apply_suggestion` / `dismiss_suggestion`).
pub(crate) fn log_decision(
    conn: &Connection,
    applied: bool,
    suggestion_id: i64,
    transaction_id: i64,
    category_id: Option<i64>,
) -> Result<(), String> {
    log(
        conn,
        LogEntry {
            event: if applied { EVENT_APPLIED } else { EVENT_DISMISSED },
            transaction_id: Some(transaction_id),
            suggestion_id: Some(suggestion_id),
            suggested_category_id: category_id,
            chosen_category_id: if applied { category_id } else { None },
            ..Default::default()
        },
    )
}

/// The categories command as the UI calls it: when the agent had suggested a
/// category for this transaction, what the user chose instead is logged — the
/// right answer for evals.
pub fn set_transaction_categories_by_user(
    state: State<'_, DbState>,
    transaction_id: i64,
    items: Vec<crate::transaction_categories::CategoryItem>,
) -> Result<(), String> {
    let chosen = items.iter().min_by_key(|i| i.position).map(|i| i.category_id);
    crate::transaction_categories::set_transaction_categories(state, transaction_id, items)?;
    let conn = state.lock().map_err(|e| e.to_string())?;
    let suggested: Option<(i64, Option<i64>, String)> = conn
        .query_row(
            "SELECT id, category_id, status FROM transaction_suggestions
             WHERE transaction_id = ?1 AND kind = 'category' AND source = 'llm'",
            [transaction_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // An accepted suggestion was logged when applied.
    if let Some((id, category_id, status)) = suggested.filter(|s| s.2 != "accepted") {
        log(
            &conn,
            LogEntry {
                event: EVENT_SET_MANUALLY,
                transaction_id: Some(transaction_id),
                suggestion_id: Some(id),
                suggested_category_id: category_id,
                chosen_category_id: chosen,
                details: Some(json!({ "suggestionStatus": status })),
                ..Default::default()
            },
        )?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRow {
    pub connection_name: Option<String>,
    pub model: Option<String>,
    pub calls: i64,
    pub errors: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
    pub duration_ms: i64,
    pub last_at: String,
}

/// Token spend per connection and model, from the log.
pub fn agent_token_usage(state: State<'_, DbState>) -> Result<Vec<TokenUsageRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT connection_name, model, COUNT(*), SUM(error IS NOT NULL),
                    COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0),
                    COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(total_tokens), 0),
                    COALESCE(SUM(duration_ms), 0), MAX(created_at)
             FROM agent_log WHERE event = ?1
             GROUP BY connection_name, model
             ORDER BY MAX(created_at) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([EVENT_LLM_CALL], |r| {
            Ok(TokenUsageRow {
                connection_name: r.get(0)?,
                model: r.get(1)?,
                calls: r.get(2)?,
                errors: r.get(3)?,
                prompt_tokens: r.get(4)?,
                completion_tokens: r.get(5)?,
                reasoning_tokens: r.get(6)?,
                total_tokens: r.get(7)?,
                duration_ms: r.get(8)?,
                last_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The whole log as JSON (the UI downloads it) — the source for evals.
pub fn export_agent_log(state: State<'_, DbState>) -> Result<Value, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, event, transaction_id, suggestion_id, suggested_category_id,
                    chosen_category_id, connection_name, protocol, base_url, model, prompt_hash,
                    request, response, result, error, prompt_tokens, completion_tokens,
                    reasoning_tokens, total_tokens, duration_ms, details
             FROM agent_log ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let parse = |s: Option<String>| s.map(|s| serde_json::from_str::<Value>(&s).unwrap_or(Value::String(s)));
    let events: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "createdAt": r.get::<_, String>(1)?,
                "event": r.get::<_, String>(2)?,
                "transactionId": r.get::<_, Option<i64>>(3)?,
                "suggestionId": r.get::<_, Option<i64>>(4)?,
                "suggestedCategoryId": r.get::<_, Option<i64>>(5)?,
                "chosenCategoryId": r.get::<_, Option<i64>>(6)?,
                "connectionName": r.get::<_, Option<String>>(7)?,
                "protocol": r.get::<_, Option<String>>(8)?,
                "baseUrl": r.get::<_, Option<String>>(9)?,
                "model": r.get::<_, Option<String>>(10)?,
                "promptHash": r.get::<_, Option<String>>(11)?,
                "request": parse(r.get(12)?),
                "response": parse(r.get(13)?),
                "result": parse(r.get(14)?),
                "error": r.get::<_, Option<String>>(15)?,
                "promptTokens": r.get::<_, Option<i64>>(16)?,
                "completionTokens": r.get::<_, Option<i64>>(17)?,
                "reasoningTokens": r.get::<_, Option<i64>>(18)?,
                "totalTokens": r.get::<_, Option<i64>>(19)?,
                "durationMs": r.get::<_, Option<i64>>(20)?,
                "details": parse(r.get(21)?),
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let categories: Vec<Value> = sg::category_paths(&conn)?
        .into_iter()
        .map(|(id, path, kind, ..)| json!({ "id": id, "path": path, "kind": kind }))
        .collect();
    Ok(json!({
        "meta": {
            "format": "a2b-agent-log",
            "version": 1,
            "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "appVersion": env!("CARGO_PKG_VERSION"),
        },
        "categories": categories,
        "events": events,
    }))
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

/// Mark / unmark transactions as examples. Only categorised transactions can
/// be examples; returns how many changed.
pub fn set_category_examples(
    state: State<'_, DbState>,
    transaction_ids: Vec<i64>,
    example: bool,
) -> Result<i64, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut changed = 0;
    for id in transaction_ids {
        let n = if example {
            conn.execute(
                "INSERT OR IGNORE INTO category_examples (transaction_id)
                 SELECT ?1 WHERE EXISTS (SELECT 1 FROM transaction_categories WHERE transaction_id = ?1)",
                [id],
            )
        } else {
            conn.execute("DELETE FROM category_examples WHERE transaction_id = ?1", [id])
        }
        .map_err(|e| e.to_string())?;
        if n > 0 {
            changed += 1;
            log(
                &conn,
                LogEntry {
                    event: if example { EVENT_EXAMPLE_MARKED } else { EVENT_EXAMPLE_UNMARKED },
                    transaction_id: Some(id),
                    ..Default::default()
                },
            )?;
        }
    }
    Ok(changed)
}

pub fn list_category_examples(state: State<'_, DbState>) -> Result<Vec<i64>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    marked_examples(&conn).map(|s| {
        let mut v: Vec<i64> = s.into_iter().collect();
        v.sort_unstable();
        v
    })
}

fn marked_examples(conn: &Connection) -> Result<HashSet<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT transaction_id FROM category_examples")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

/// `transaction → [(category, share)]` in position order.
fn categories_by_txn(conn: &Connection) -> Result<HashMap<i64, Vec<(i64, i64)>>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT transaction_id, category_id, share_minor FROM transaction_categories
             ORDER BY transaction_id, position",
        )
        .map_err(|e| e.to_string())?;
    let mut map: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (txn, cat, share) = row.map_err(|e| e.to_string())?;
        map.entry(txn).or_default().push((cat, share));
    }
    Ok(map)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExampleSource {
    /// The user marked it.
    Marked,
    /// Picked automatically for its category.
    Auto,
    /// Same counterparty as the transaction being categorised.
    SamePeer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedExample {
    pub transaction_id: i64,
    /// The category this example stands for (none for same-counterparty ones).
    pub for_category_id: Option<i64>,
    pub source: ExampleSource,
}

fn norm(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
}

/// The balanced example set for one transaction of `kind` (`expense` /
/// `income`). `exclude` is never an example (the transaction itself);
/// `before`, when given, keeps only earlier transactions (used by evals to
/// stay honest).
fn pick_examples(
    all: &[Facts],
    cats: &HashMap<i64, Vec<(i64, i64)>>,
    category_kinds: &HashMap<i64, String>,
    category_order: &[i64],
    marked: &HashSet<i64>,
    target: &Facts,
    kind: &str,
    per_category: usize,
    auto: bool,
) -> Vec<PickedExample> {
    // Categorised transactions of this kind, newest first.
    let mut candidates: Vec<&Facts> = all
        .iter()
        .filter(|f| f.id != target.id)
        .filter(|f| {
            cats.get(&f.id).is_some_and(|cs| {
                cs.iter().all(|(c, _)| category_kinds.get(c).is_some_and(|k| k == kind))
            })
        })
        .collect();
    candidates.sort_by(|a, b| b.at.cmp(&a.at).then(b.id.cmp(&a.id)));

    let mut picked: Vec<PickedExample> = Vec::new();
    let mut used: HashSet<i64> = HashSet::new();
    for &category in category_order {
        if category_kinds.get(&category).is_none_or(|k| k != kind) {
            continue;
        }
        let in_category: Vec<&Facts> = candidates
            .iter()
            .copied()
            .filter(|f| cats[&f.id].iter().any(|(c, _)| *c == category))
            .collect();
        let take = |f: &Facts, source: ExampleSource, used: &mut HashSet<i64>, picked: &mut Vec<PickedExample>| {
            used.insert(f.id);
            picked.push(PickedExample { transaction_id: f.id, for_category_id: Some(category), source });
        };
        // Every marked one goes in — the user chose them, however many;
        // N only says how far automatic ones top up.
        let mut n = 0;
        for f in in_category.iter().filter(|f| marked.contains(&f.id)) {
            if !used.contains(&f.id) {
                take(f, ExampleSource::Marked, &mut used, &mut picked);
                n += 1;
            }
        }
        if auto && n < per_category {
            // Distinct counterparties first, then whatever is left.
            // Counterparties already shown for this category (the marked ones) count.
            let mut peers: HashSet<Option<String>> = in_category
                .iter()
                .filter(|f| used.contains(&f.id))
                .map(|f| norm(&f.peer))
                .collect();
            let unmarked: Vec<&Facts> =
                in_category.iter().copied().filter(|f| !marked.contains(&f.id)).collect();
            for pass in 0..2 {
                for f in &unmarked {
                    if n == per_category {
                        break;
                    }
                    if used.contains(&f.id) {
                        continue;
                    }
                    let peer = norm(&f.peer);
                    if pass == 0 && !peers.insert(peer) {
                        continue;
                    }
                    take(f, ExampleSource::Auto, &mut used, &mut picked);
                    n += 1;
                }
            }
        }
    }

    if let Some(peer) = norm(&target.peer) {
        for f in candidates.iter().filter(|f| norm(&f.peer).as_deref() == Some(peer.as_str())) {
            if picked.iter().filter(|p| p.source == ExampleSource::SamePeer).count() == SAME_PEER_EXAMPLES {
                break;
            }
            if used.insert(f.id) {
                picked.push(PickedExample { transaction_id: f.id, for_category_id: None, source: ExampleSource::SamePeer });
            }
        }
    }
    picked
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/// The fixed, technical part of the system prompt. `{instructions}`,
/// `{categories}` and `{language}` are filled in.
const SYSTEM_TEMPLATE: &str = "You categorise one bank transaction of a personal-finance app \
for its owner. You do not chat: you return exactly one answer.

## The owner's instructions

{instructions}

## Categories

Choose exactly one category id from this list. Any node may be chosen, not only a leaf: \
when you cannot tell the subcategory, choose its parent. Format: `id: path — description`.

{categories}

## When to answer

Suggest a category only when it is obvious — a wrong suggestion costs the owner more than none. \
Obvious means the owner's own examples decide it: the same counterparty (or the same kind of \
purchase) is in this category in the examples and nowhere else, and nothing about this \
transaction is different (another note, an unusual amount, a life context the examples did not have).

Return `\"categoryId\": null` whenever you would have to reason your way to the category: a new \
counterparty, examples that disagree, a transfer to a person without a telling note, a purchase \
during a life context (a trip, guests…) whose examples are categorised differently from usual or \
missing, or a note that says what was bought but not who it was for or who paid.

## Answer

Reply with a single JSON object and nothing else:
{\"categoryId\": <id from the list, or null>, \"confidence\": <integer 0-10>, \"rationale\": \"<1-2 sentences in {language}: why this category, or why it is not clear>\"}

Confidence: 9-10 the examples or notes leave no doubt; 6-8 likely; 3-5 a reasonable guess; \
0-2 nothing to go on.";

fn fill(template: &str, pairs: &[(&str, &str)]) -> String {
    pairs.iter().fold(template.to_string(), |acc, (k, v)| acc.replace(&format!("{{{k}}}"), v))
}

fn category_lines(paths: &[(i64, String, String, Option<String>, Option<i64>)], kind: &str) -> String {
    paths
        .iter()
        .filter(|(_, _, k, ..)| k == kind)
        .map(|(id, path, _, description, _)| match description.as_deref().map(str::trim) {
            Some(d) if !d.is_empty() => format!("{id}: {path} — {d}"),
            _ => format!("{id}: {path}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One transaction as a compact line (examples).
fn describe(ctx: &SuggestionContext) -> String {
    let date = ctx.occurred_at_local.as_deref().unwrap_or(&ctx.occurred_at_utc);
    let mut parts = vec![
        date.get(..10).unwrap_or(date).to_string(),
        format!("{} {} {}", ctx.direction, ctx.amount, ctx.currency),
        format!("account \"{}\"", ctx.account),
    ];
    if let Some(p) = &ctx.peer {
        parts.push(format!("counterparty \"{p}\""));
    }
    if let Some(d) = &ctx.bank_description {
        parts.push(format!("bank \"{d}\""));
    }
    if let Some(c) = &ctx.comment {
        parts.push(format!("note \"{c}\""));
    }
    for n in &ctx.slip_notes {
        parts.push(format!("slip \"{n}\""));
    }
    for l in &ctx.life_contexts {
        parts.push(format!("life \"{l}\""));
    }
    parts.join(" | ")
}

fn answer_of(cats: &[(i64, i64)], path_of: &HashMap<i64, String>) -> String {
    let total: i64 = cats.iter().map(|(_, s)| *s).sum();
    if cats.len() == 1 || total == 0 {
        return cats
            .iter()
            .map(|(c, _)| format!("category {c} ({})", path_of.get(c).map_or("?", String::as_str)))
            .collect::<Vec<_>>()
            .join(", ");
    }
    cats.iter()
        .map(|(c, s)| {
            format!("category {c} ({}) {}%", path_of.get(c).map_or("?", String::as_str), (s * 100 + total / 2) / total)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// What the model gets about the transaction itself: the context without ids.
fn target_json(ctx: &SuggestionContext) -> Value {
    let mut v = serde_json::to_value(ctx).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("transactionId");
        o.remove("accountId");
        o.retain(|_, v| !(v.is_null() || v.as_array().is_some_and(Vec::is_empty)));
    }
    v
}

pub(crate) struct Prompt {
    pub system: String,
    pub user: String,
    pub examples: Vec<PickedExample>,
    /// Allowed answers: category id → path.
    pub allowed: HashMap<i64, String>,
}

pub(crate) fn build_prompt(
    conn: &Connection,
    settings: &AgentSettings,
    all: &[Facts],
    target: &Facts,
) -> Result<Prompt, String> {
    let kind = if target.credit > 0 { "income" } else { "expense" };
    let paths = sg::category_paths(conn)?;
    let path_of: HashMap<i64, String> = paths.iter().map(|(id, p, ..)| (*id, p.clone())).collect();
    let category_kinds: HashMap<i64, String> = paths.iter().map(|(id, _, k, ..)| (*id, k.clone())).collect();
    let order: Vec<i64> = paths.iter().map(|(id, ..)| *id).collect();
    let cats = categories_by_txn(conn)?;
    let marked = marked_examples(conn)?;
    let examples = pick_examples(
        all,
        &cats,
        &category_kinds,
        &order,
        &marked,
        target,
        kind,
        settings.examples_per_category,
        settings.auto_examples,
    );

    let lang = Lang::of(conn);
    let system = fill(
        SYSTEM_TEMPLATE,
        &[
            ("instructions", settings.instructions.trim()),
            ("categories", &category_lines(&paths, kind)),
            ("language", lang.pick("Russian", "English")),
        ],
    );

    let by_id: HashMap<i64, &Facts> = all.iter().map(|f| (f.id, f)).collect();
    let line = |p: &PickedExample| -> Result<String, String> {
        let f = by_id[&p.transaction_id];
        Ok(format!("- {} → {}", describe(&sg::context_of(conn, f)?), answer_of(&cats[&f.id], &path_of)))
    };
    let balanced: Vec<String> = examples
        .iter()
        .filter(|p| p.source != ExampleSource::SamePeer)
        .map(line)
        .collect::<Result<_, _>>()?;
    let same_peer: Vec<String> = examples
        .iter()
        .filter(|p| p.source == ExampleSource::SamePeer)
        .map(line)
        .collect::<Result<_, _>>()?;

    let mut user = String::new();
    if balanced.is_empty() && same_peer.is_empty() {
        user.push_str("## How the owner categorised earlier transactions\n\n(no examples yet)\n\n");
    } else {
        if !balanced.is_empty() {
            user.push_str("## How the owner categorised earlier transactions\n\n");
            user.push_str(&balanced.join("\n"));
            user.push_str("\n\n");
        }
        if !same_peer.is_empty() {
            user.push_str("## Earlier transactions with the same counterparty\n\n");
            user.push_str(&same_peer.join("\n"));
            user.push_str("\n\n");
        }
    }
    let ctx = sg::context_of(conn, target)?;
    user.push_str("## Transaction to categorise\n\n");
    user.push_str(&serde_json::to_string_pretty(&target_json(&ctx)).unwrap_or_default());

    let allowed = paths
        .iter()
        .filter(|(_, _, k, ..)| k == kind)
        .map(|(id, p, ..)| (*id, p.clone()))
        .collect();
    Ok(Prompt { system, user, examples, allowed })
}

fn sha256_hex(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    format!("{:x}", h.finalize())
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answer {
    /// `None`: the model was not sure and suggests nothing.
    pub category_id: Option<i64>,
    pub confidence: i64,
    pub rationale: String,
}

fn leading_int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.round() as i64)),
        Value::String(s) => {
            let digits: String = s.trim().chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        }
        _ => None,
    }
}

fn lenient_fields(content: &str) -> Option<Value> {
    static RE: std::sync::OnceLock<[regex::Regex; 3]> = std::sync::OnceLock::new();
    let [id, confidence, rationale] = RE.get_or_init(|| {
        [
            regex::Regex::new(r#""categoryId"\s*:\s*"?(\d+|null)"#).expect("valid regex"),
            regex::Regex::new(r#""confidence"\s*:\s*"?(\d+(?:\.\d+)?)"#).expect("valid regex"),
            regex::Regex::new(r#""rationale"\s*:\s*"((?:[^"\\]|\\.)*)""#).expect("valid regex"),
        ]
    });
    let id = match &id.captures(content)?[1] {
        "null" => Value::Null,
        n => json!(n.parse::<i64>().ok()?),
    };
    let confidence = confidence.captures(content).map(|c| c[1].to_string()).unwrap_or_default();
    let rationale = rationale
        .captures(content)
        .map(|c| serde_json::from_str::<String>(&format!("\"{}\"", &c[1])).unwrap_or_else(|_| c[1].to_string()))
        .unwrap_or_default();
    Some(json!({ "categoryId": id, "confidence": confidence, "rationale": rationale }))
}

/// Parse the model's reply: the first `{` … last `}` must be a JSON object
/// with a known category id.
pub(crate) fn parse_answer(content: &str, allowed: &HashMap<i64, String>) -> Result<Answer, String> {
    let (start, end) = (content.find('{'), content.rfind('}'));
    let (Some(start), Some(end)) = (start, end) else {
        return Err("the reply has no JSON object".to_string());
    };
    if end < start {
        return Err("the reply has no JSON object".to_string());
    }
    // Models sometimes break the JSON (e.g. `"categoryId": 12: Food / Cafe`);
    // the three fields are simple enough to pick out by pattern then.
    let v: Value = match serde_json::from_str(&content[start..=end]) {
        Ok(v) => v,
        Err(e) => lenient_fields(content).ok_or_else(|| format!("invalid JSON: {e}"))?,
    };
    let category_id = match &v["categoryId"] {
        Value::Null => None,
        id => Some(leading_int(id).ok_or("categoryId is not a number or null")?),
    };
    if let Some(id) = category_id.filter(|id| !allowed.contains_key(id)) {
        return Err(format!("categoryId {id} is not in the list of categories"));
    }
    let confidence = leading_int(&v["confidence"]).unwrap_or(0).clamp(0, 10);
    let rationale = v["rationale"].as_str().unwrap_or("").trim().to_string();
    Ok(Answer { category_id, confidence, rationale })
}

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutcome {
    /// `suggested`, `skipped` or `error`.
    pub status: String,
    /// Skip reason code (`suggestions.skip.*`).
    pub reason: Option<String>,
    pub error: Option<String>,
    pub category_id: Option<i64>,
    pub confidence: Option<i64>,
    pub total_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
}

impl AgentOutcome {
    fn skipped(reason: &str) -> AgentOutcome {
        AgentOutcome { status: "skipped".into(), reason: Some(reason.into()), ..Default::default() }
    }
}

struct Prepared {
    connection: AiConnection,
    api_key: String,
    prompt: Prompt,
    input_hash: String,
    prompt_hash: String,
    min_confidence: i64,
}

fn prepare(conn: &Connection, transaction_id: i64, redo: bool) -> Result<Result<Prepared, AgentOutcome>, String> {
    let all = sg::load_all_facts(conn)?;
    let Some(target) = all.iter().find(|f| f.id == transaction_id) else {
        return Ok(Err(AgentOutcome::skipped("not_found")));
    };
    let categorised: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM transaction_categories WHERE transaction_id = ?1)",
            [transaction_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if categorised {
        return Ok(Err(AgentOutcome::skipped("already_categorized")));
    }
    if sg::linked_ids(conn)?.contains_key(&transaction_id) {
        return Ok(Err(AgentOutcome::skipped("linked")));
    }
    let link_pending: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM transaction_suggestions
                            WHERE transaction_id = ?1 AND status = 'pending'
                              AND kind IN ('transfer', 'cash_withdrawal'))",
            [transaction_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if link_pending {
        return Ok(Err(AgentOutcome::skipped("link_pending")));
    }
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT status, input_hash FROM transaction_suggestions
             WHERE transaction_id = ?1 AND kind = 'category'",
            [transaction_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if !redo && existing.as_ref().is_some_and(|(s, _)| s == "pending") {
        return Ok(Err(AgentOutcome::skipped("already_suggested")));
    }

    let settings = load_settings(conn)?;
    let connection_id = settings.connection_id.ok_or(ERR_NO_CONNECTION)?;
    let connection = ai::load_connection(conn, connection_id).map_err(|_| ERR_NO_CONNECTION.to_string())?;
    let api_key = ai::resolve_api_key(&connection.api_key)?;
    let prompt = build_prompt(conn, &settings, &all, target)?;
    let input_hash = sha256_hex(&[&connection.base_url, &connection.model, &prompt.system, &prompt.user]);
    if !redo && existing.as_ref().is_some_and(|(s, h)| s == "dismissed" && *h == input_hash) {
        return Ok(Err(AgentOutcome::skipped("dismissed")));
    }
    // Already asked with exactly this input and the model was not sure: it
    // would say the same again. New examples or notes change the input.
    if !redo {
        let last: Option<String> = conn
            .query_row(
                "SELECT result FROM agent_log
                 WHERE event = ?1 AND transaction_id = ?2 AND error IS NULL AND result IS NOT NULL
                   AND json_extract(details, '$.inputHash') = ?3
                 ORDER BY id DESC LIMIT 1",
                params![EVENT_LLM_CALL, transaction_id, input_hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let unsure = last
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .is_some_and(|r| r["categoryId"].is_null() || r["confidence"].as_i64().unwrap_or(0) < settings.min_confidence);
        if unsure {
            return Ok(Err(AgentOutcome::skipped(SKIP_NOT_CONFIDENT)));
        }
    }
    let prompt_hash = sha256_hex(&[settings.instructions.trim()]);
    let min_confidence = settings.min_confidence;
    Ok(Ok(Prepared { connection, api_key, prompt, input_hash, prompt_hash, min_confidence }))
}

fn upsert_llm_suggestion(
    conn: &Connection,
    transaction_id: i64,
    category_id: i64,
    answer: &Answer,
    reasoning: Option<&str>,
    prompt_text: &str,
    model: &str,
    input_hash: &str,
) -> Result<i64, String> {
    conn.query_row(
        "INSERT INTO transaction_suggestions
           (transaction_id, kind, source, category_id, partner_txn_id, cash_account_id,
            confidence, rationale, reasoning, prompt, model, input_hash, status, created_at)
         VALUES (?1, 'category', 'llm', ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7, ?8, 'pending',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (transaction_id, kind) DO UPDATE SET
            source = excluded.source, category_id = excluded.category_id,
            partner_txn_id = NULL, cash_account_id = NULL,
            confidence = excluded.confidence, rationale = excluded.rationale,
            reasoning = excluded.reasoning, prompt = excluded.prompt, model = excluded.model,
            input_hash = excluded.input_hash, status = 'pending',
            created_at = excluded.created_at
         RETURNING id",
        params![
            transaction_id,
            category_id,
            answer.confidence,
            answer.rationale,
            reasoning,
            prompt_text,
            model,
            input_hash
        ],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Suggest a category for one transaction. The UI calls it transaction by
/// transaction (progress, stop button); a run never applies anything.
pub async fn suggest_category(app: AppHandle, transaction_id: i64, redo: bool) -> Result<AgentOutcome, String> {
    // Runs as its own task: if the page goes away mid-call, the model still
    // answers, the suggestion is stored and the call is logged.
    tokio::spawn(run_suggest_category(app, transaction_id, redo))
        .await
        .map_err(|e| format!("agent task failed: {e}"))?
}

async fn run_suggest_category(app: AppHandle, transaction_id: i64, redo: bool) -> Result<AgentOutcome, String> {
    let prepared = {
        let state = app.db();
        let conn = state.lock().map_err(|e| e.to_string())?;
        match prepare(&conn, transaction_id, redo)? {
            Ok(p) => p,
            Err(outcome) => return Ok(outcome),
        }
    };
    let Prepared { connection, api_key, prompt, input_hash, prompt_hash, min_confidence } = prepared;
    let example_ids: Vec<Value> = prompt
        .examples
        .iter()
        .map(|e| json!({ "transactionId": e.transaction_id, "forCategoryId": e.for_category_id, "source": e.source }))
        .collect();

    let mut messages = vec![("user".to_string(), prompt.user.clone())];
    let mut total_tokens = 0i64;
    let mut duration_ms = 0i64;
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        let result = ai::chat(&connection, &api_key, &prompt.system, &messages).await;
        let state = app.db();
        let conn = state.lock().map_err(|e| e.to_string())?;
        let details = json!({ "attempt": attempt, "examples": example_ids, "inputHash": input_hash });
        match result {
            Err(e) => {
                duration_ms += e.duration_ms;
                log(
                    &conn,
                    LogEntry {
                        event: EVENT_LLM_CALL,
                        transaction_id: Some(transaction_id),
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
                // A transport / provider error is not worth a retry here.
                return Ok(AgentOutcome {
                    status: "error".into(),
                    error: Some(e.message),
                    duration_ms: Some(duration_ms),
                    ..Default::default()
                });
            }
            Ok(reply) => {
                duration_ms += reply.duration_ms;
                total_tokens += reply.usage.total_tokens.unwrap_or(0);
                let parsed = parse_answer(&reply.content, &prompt.allowed);
                // Only a sure answer becomes a suggestion; the rest is left
                // to the user (and still logged, for evals).
                let offered = parsed
                    .as_ref()
                    .ok()
                    .and_then(|a| a.category_id.filter(|_| a.confidence >= min_confidence));
                let suggestion_id = match (&parsed, offered) {
                    (Ok(answer), Some(category_id)) => {
                        let prompt_text = format!(
                            "{}\n\n---\n\n{}",
                            prompt.system,
                            messages.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n\n---\n\n")
                        );
                        Some(upsert_llm_suggestion(
                            &conn,
                            transaction_id,
                            category_id,
                            answer,
                            reply.reasoning.as_deref(),
                            &prompt_text,
                            &format!("{} · {}", connection.name, connection.model),
                            &input_hash,
                        )?)
                    }
                    (Ok(_), None) => {
                        // A redo that is no longer sure: the old suggestion goes.
                        conn.execute(
                            "DELETE FROM transaction_suggestions
                             WHERE transaction_id = ?1 AND kind = 'category' AND source = 'llm'
                               AND status = 'pending'",
                            [transaction_id],
                        )
                        .map_err(|e| e.to_string())?;
                        None
                    }
                    (Err(_), _) => None,
                };
                log(
                    &conn,
                    LogEntry {
                        event: EVENT_LLM_CALL,
                        transaction_id: Some(transaction_id),
                        suggestion_id,
                        suggested_category_id: parsed.as_ref().ok().and_then(|a| a.category_id),
                        connection: Some(&connection),
                        prompt_hash: Some(&prompt_hash),
                        request: Some(&reply.request),
                        response: Some(&reply.response),
                        result: parsed.as_ref().ok().map(|a| {
                            json!({
                                "categoryId": a.category_id,
                                "confidence": a.confidence,
                                "rationale": a.rationale,
                                "offered": offered.is_some(),
                                "minConfidence": min_confidence,
                            })
                        }),
                        error: parsed.as_ref().err().map(String::as_str),
                        usage: Some(&reply.usage),
                        duration_ms: Some(reply.duration_ms),
                        details: Some(details),
                        ..Default::default()
                    },
                )?;
                match parsed {
                    Ok(answer) if offered.is_none() => {
                        return Ok(AgentOutcome {
                            status: "skipped".into(),
                            reason: Some(SKIP_NOT_CONFIDENT.into()),
                            category_id: answer.category_id,
                            confidence: Some(answer.confidence),
                            total_tokens: Some(total_tokens),
                            duration_ms: Some(duration_ms),
                            ..Default::default()
                        })
                    }
                    Ok(answer) => {
                        return Ok(AgentOutcome {
                            status: "suggested".into(),
                            category_id: offered,
                            confidence: Some(answer.confidence),
                            total_tokens: Some(total_tokens),
                            duration_ms: Some(duration_ms),
                            ..Default::default()
                        })
                    }
                    Err(e) => {
                        last_error = e.clone();
                        messages.push(("assistant".to_string(), reply.content));
                        messages.push((
                            "user".to_string(),
                            format!("Your answer could not be used: {e}. Reply again with only the JSON object."),
                        ));
                    }
                }
            }
        }
    }
    Ok(AgentOutcome {
        status: "error".into(),
        error: Some(last_error),
        total_tokens: Some(total_tokens),
        duration_ms: Some(duration_ms),
        ..Default::default()
    })
}

// ---------------------------------------------------------------------------
// Are the examples enough? (Categories screen → "Examples for the agent")
// ---------------------------------------------------------------------------

/// The category has no categorised transactions (and no subcategories).
const ISSUE_NO_EXAMPLES: &str = "no_examples";
/// Fewer categorised transactions than examples per category.
const ISSUE_FEW_EXAMPLES: &str = "few_examples";
/// The agent suggested another category for transactions of this one, and
/// none of them is marked as an example yet.
const ISSUE_AGENT_MISSES: &str = "agent_misses";
/// A counterparty of this category is also in other categories, and none of
/// its transactions here is marked as an example.
const ISSUE_CONFLICTS: &str = "conflicts";

/// A counterparty of a category whose other transactions are in other
/// categories of the same kind: the model sees mixed answers for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerConflict {
    /// As written in its newest transaction.
    pub peer: String,
    /// Its transactions in this category, newest first.
    pub here: Vec<i64>,
    /// Its transactions in other categories.
    pub elsewhere: Vec<PeerElsewhere>,
    /// One of `here` is marked as an example.
    pub resolved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerElsewhere {
    pub category_id: i64,
    pub transactions: Vec<i64>,
}

/// A transaction of this category for which the agent suggested another one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMiss {
    pub transaction_id: i64,
    pub suggested_category_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryExamplesReport {
    pub category_id: i64,
    /// Its categorised transactions, newest first.
    pub labeled: Vec<i64>,
    /// Distinct counterparties among them.
    pub peers: usize,
    /// Marked as examples, newest first (the agent shows them all).
    pub marked: Vec<i64>,
    /// Picked automatically when fewer than N are marked.
    pub auto: Vec<i64>,
    pub conflicts: Vec<PeerConflict>,
    /// The agent's suggestion of this category was right (the transaction is
    /// in it now).
    pub agent_hits: usize,
    pub agent_misses: Vec<AgentMiss>,
    /// The agent suggested this category, but the transaction is in another
    /// one or the suggestion was dismissed.
    pub agent_false: usize,
    /// What to look at: `no_examples`, `few_examples`, `agent_misses`,
    /// `conflicts`.
    pub issues: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamplesReport {
    pub examples_per_category: usize,
    pub auto_examples: bool,
    pub categories: Vec<CategoryExamplesReport>,
}

/// Per category: which examples the agent shows the model, and what says
/// they may not be enough — few categorised transactions, counterparties
/// with mixed answers, and the agent's own mistakes (its suggestion against
/// the category the transaction is in now).
pub fn category_examples_report(state: State<'_, DbState>) -> Result<ExamplesReport, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    examples_report(&conn)
}

fn examples_report(conn: &Connection) -> Result<ExamplesReport, String> {
    let settings = load_settings(conn)?;
    let n = settings.examples_per_category;
    let mut all = sg::load_all_facts(conn)?;
    all.sort_by(|a, b| b.at.cmp(&a.at).then(b.id.cmp(&a.id)));
    let paths = sg::category_paths(conn)?;
    let category_kinds: HashMap<i64, String> = paths.iter().map(|(id, _, k, ..)| (*id, k.clone())).collect();
    let parents: HashSet<i64> = paths.iter().filter_map(|p| p.4).collect();
    let order: Vec<i64> = paths.iter().map(|(id, ..)| *id).collect();
    let cats = categories_by_txn(conn)?;
    let marked = marked_examples(conn)?;

    let mut out: HashMap<i64, CategoryExamplesReport> = order
        .iter()
        .map(|&c| {
            (
                c,
                CategoryExamplesReport {
                    category_id: c,
                    labeled: vec![],
                    peers: 0,
                    marked: vec![],
                    auto: vec![],
                    conflicts: vec![],
                    agent_hits: 0,
                    agent_misses: vec![],
                    agent_false: 0,
                    issues: vec![],
                },
            )
        })
        .collect();

    // Categorised transactions and their counterparties, newest first.
    // peer → category → its transactions there.
    let mut by_peer: HashMap<String, (String, HashMap<i64, Vec<i64>>)> = HashMap::new();
    for f in &all {
        let Some(cs) = cats.get(&f.id) else { continue };
        for (c, _) in cs {
            let Some(r) = out.get_mut(c) else { continue };
            r.labeled.push(f.id);
            if marked.contains(&f.id) {
                r.marked.push(f.id);
            }
            if let Some(peer) = norm(&f.peer) {
                let entry = by_peer
                    .entry(peer)
                    .or_insert_with(|| (f.peer.clone().unwrap_or_default().trim().to_string(), HashMap::new()));
                entry.1.entry(*c).or_default().push(f.id);
            }
        }
    }

    // The automatic examples, exactly as the agent picks them (a phantom
    // target that matches nothing: the per-category part only).
    if let Some(first) = all.first() {
        let mut probe = first.clone();
        probe.id = i64::MIN;
        probe.peer = None;
        for kind in ["expense", "income"] {
            for p in pick_examples(&all, &cats, &category_kinds, &order, &marked, &probe, kind, n, settings.auto_examples) {
                if let (Some(c), ExampleSource::Auto) = (p.for_category_id, p.source) {
                    if let Some(r) = out.get_mut(&c) {
                        r.auto.push(p.transaction_id);
                    }
                }
            }
        }
    }

    // Counterparties with mixed answers. A split transaction sits in several
    // categories at once — that is not a disagreement, so it only counts in
    // the category it is compared against.
    for (display, per_category) in by_peer.values() {
        for (&c, here) in per_category {
            let r = out.get_mut(&c).expect("category of a categorised transaction");
            r.peers += 1;
            let kind = &category_kinds[&c];
            let here_set: HashSet<i64> = here.iter().copied().collect();
            let mut elsewhere: Vec<PeerElsewhere> = per_category
                .iter()
                .filter(|(other, _)| **other != c && category_kinds.get(*other) == Some(kind))
                .map(|(other, txns)| PeerElsewhere {
                    category_id: *other,
                    transactions: txns.iter().copied().filter(|t| !here_set.contains(t)).collect(),
                })
                .filter(|e| !e.transactions.is_empty())
                .collect();
            if elsewhere.is_empty() {
                continue;
            }
            elsewhere.sort_by(|a, b| b.transactions.len().cmp(&a.transactions.len()).then(a.category_id.cmp(&b.category_id)));
            r.conflicts.push(PeerConflict {
                peer: display.clone(),
                here: here.clone(),
                elsewhere,
                resolved: here.iter().any(|t| marked.contains(t)),
            });
        }
    }

    // The agent's record: its current suggestion against the category the
    // transaction is in now.
    let mut stmt = conn
        .prepare(
            "SELECT transaction_id, category_id, status FROM transaction_suggestions
             WHERE kind = 'category' AND source = 'llm' AND category_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let suggested: Vec<(i64, i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    for (txn, s, status) in suggested {
        match cats.get(&txn) {
            Some(cs) if cs.iter().any(|(c, _)| *c == s) => {
                if let Some(r) = out.get_mut(&s) {
                    r.agent_hits += 1;
                }
            }
            Some(cs) => {
                if let Some(r) = out.get_mut(&s) {
                    r.agent_false += 1;
                }
                for (c, _) in cs {
                    if let Some(r) = out.get_mut(c) {
                        r.agent_misses.push(AgentMiss { transaction_id: txn, suggested_category_id: s });
                    }
                }
            }
            None if status == "dismissed" => {
                if let Some(r) = out.get_mut(&s) {
                    r.agent_false += 1;
                }
            }
            None => {}
        }
    }

    let mut v: Vec<CategoryExamplesReport> = order.iter().filter_map(|c| out.remove(c)).collect();
    for r in &mut v {
        r.conflicts.sort_by(|a, b| a.resolved.cmp(&b.resolved).then(b.here.len().cmp(&a.here.len())).then(a.peer.cmp(&b.peer)));
        r.agent_misses.sort_by(|a, b| b.transaction_id.cmp(&a.transaction_id));
        if r.labeled.is_empty() {
            if !parents.contains(&r.category_id) {
                r.issues.push(ISSUE_NO_EXAMPLES);
            }
        } else if r.labeled.len() < n {
            r.issues.push(ISSUE_FEW_EXAMPLES);
        }
        if r.agent_misses.iter().any(|m| !marked.contains(&m.transaction_id)) {
            r.issues.push(ISSUE_AGENT_MISSES);
        }
        if r.conflicts.iter().any(|c| !c.resolved) {
            r.issues.push(ISSUE_CONFLICTS);
        }
    }
    Ok(ExamplesReport { examples_per_category: n, auto_examples: settings.auto_examples, categories: v })
}

/// The exact prompt for a transaction, for the eval tooling and debugging:
/// `{system, user, examples}`.
pub fn preview_category_prompt(state: State<'_, DbState>, transaction_id: i64) -> Result<Value, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let settings = load_settings(&conn)?;
    let all = sg::load_all_facts(&conn)?;
    let target = all.iter().find(|f| f.id == transaction_id).ok_or(ERR_NOT_FOUND)?;
    let prompt = build_prompt(&conn, &settings, &all, target)?;
    Ok(json!({ "system": prompt.system, "user": prompt.user, "examples": prompt.examples }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct Fx {
        _dir: TempDir,
        state: DbState,
    }

    impl Fx {
        fn new() -> Fx {
            let dir = TempDir::new().unwrap();
            let conn = db::open(dir.path()).unwrap();
            Fx { _dir: dir, state: Mutex::new(conn) }
        }

        fn exec<T: rusqlite::types::FromSql>(&self, sql: &str, p: impl rusqlite::Params) -> T {
            self.state.lock().unwrap().query_row(sql, p, |r| r.get(0)).unwrap()
        }

        fn category(&self, name: &str, parent: Option<i64>) -> i64 {
            self.exec(
                "INSERT INTO categories (name, kind, parent_id, color) VALUES (?1, 'expense', ?2, '#888888') RETURNING id",
                params![name, parent],
            )
        }

        fn txn(&self, account: i64, at: &str, debit: i64, peer: &str) -> i64 {
            self.exec(
                "INSERT INTO transactions (account_id, occurred_at_utc, credit, debit, balance, peer, bank_description)
                 VALUES (?1, ?2, 0, ?3, 98765432, ?4, 'Payment') RETURNING id",
                params![account, at, debit, peer],
            )
        }

        fn categorise(&self, txn: i64, category: i64) {
            self.state
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                     SELECT ?1, ?2, debit, 0 FROM transactions WHERE id = ?1",
                    params![txn, category],
                )
                .unwrap();
        }
    }

    fn fixture() -> (Fx, i64, i64, i64, Vec<i64>) {
        let fx = Fx::new();
        let account: i64 = fx.exec(
            "INSERT INTO accounts (name, kind, bank, currency) VALUES ('Main', 'bank', 'KBank', 'THB') RETURNING id",
            [],
        );
        let food = fx.category("Food", None);
        let cafe = fx.category("Cafe", Some(food));
        let rent = fx.category("Rent", None);
        let mut txns = Vec::new();
        for (i, (peer, cat)) in [("Starbucks", cafe), ("Amazon Cafe", cafe), ("Starbucks", cafe), ("Landlord", rent)]
            .into_iter()
            .enumerate()
        {
            let t = fx.txn(account, &format!("2026-05-0{}T03:00:00.000Z", i + 1), 10_000, peer);
            fx.categorise(t, cat);
            txns.push(t);
        }
        (fx, account, cafe, rent, txns)
    }

    #[test]
    fn examples_are_balanced_marked_first_and_never_the_target() {
        let (fx, account, cafe, rent, txns) = fixture();
        let target = fx.txn(account, "2026-05-09T03:00:00.000Z", 5_000, "Starbucks");
        set_category_examples(&fx.state, vec![txns[0], target], true).unwrap();
        // Uncategorised target cannot be an example.
        assert_eq!(list_category_examples(&fx.state).unwrap(), vec![txns[0]]);

        let conn = fx.state.lock().unwrap();
        put_setting(&conn, EXAMPLES_PER_CATEGORY_KEY, "2").unwrap();
        let settings = load_settings(&conn).unwrap();
        let all = sg::load_all_facts(&conn).unwrap();
        let t = all.iter().find(|f| f.id == target).unwrap();
        let prompt = build_prompt(&conn, &settings, &all, t).unwrap();
        let cafe_examples: Vec<&PickedExample> =
            prompt.examples.iter().filter(|e| e.for_category_id == Some(cafe)).collect();
        assert_eq!(cafe_examples.len(), 2);
        assert_eq!((cafe_examples[0].transaction_id, cafe_examples[0].source), (txns[0], ExampleSource::Marked));
        // The automatic one prefers another counterparty.
        assert_eq!(cafe_examples[1].transaction_id, txns[1]);
        assert!(prompt.examples.iter().any(|e| e.for_category_id == Some(rent)));
        assert!(prompt.examples.iter().all(|e| e.transaction_id != target));
        // The remaining Starbucks one comes as a same-counterparty example.
        assert!(prompt
            .examples
            .iter()
            .any(|e| e.transaction_id == txns[2] && e.source == ExampleSource::SamePeer));
        assert!(prompt.system.contains(&format!("{cafe}: Food / Cafe")));
        assert!(prompt.user.contains("→ "));
        // Never the balance.
        assert!(!prompt.user.contains("98765432") && !prompt.user.contains("987654.32"));
    }

    #[test]
    fn examples_report_flags_what_is_missing() {
        let (fx, account, cafe, rent, txns) = fixture();
        let food: i64 = fx.exec("SELECT parent_id FROM categories WHERE id = ?1", [cafe]);
        let treats = fx.category("Treats", None);
        let unused = fx.category("Unused", None);
        // Starbucks is a cafe three times… and once a treat.
        let treat = fx.txn(account, "2026-05-08T03:00:00.000Z", 3_000, "STARBUCKS ");
        fx.categorise(treat, treats);
        set_category_examples(&fx.state, vec![txns[0]], true).unwrap();
        let pending = fx.txn(account, "2026-05-09T03:00:00.000Z", 3_000, "Starbucks");
        {
            let conn = fx.state.lock().unwrap();
            let suggest = |txn: i64, category: i64| {
                let answer = Answer { category_id: Some(category), confidence: 8, rationale: "r".into() };
                upsert_llm_suggestion(&conn, txn, category, &answer, None, "p", "m", &txn.to_string()).unwrap();
            };
            suggest(txns[1], cafe); // right
            suggest(txns[3], cafe); // wrong: it is rent
            suggest(pending, treats); // not decided yet
        }

        let report = examples_report(&fx.state.lock().unwrap()).unwrap();
        assert_eq!(report.examples_per_category, 3);
        let of = |c: i64| report.categories.iter().find(|r| r.category_id == c).unwrap();

        let r = of(cafe);
        assert_eq!(r.labeled, vec![txns[2], txns[1], txns[0]]);
        assert_eq!((r.peers, r.marked.clone(), r.auto.len()), (2, vec![txns[0]], 2));
        assert_eq!((r.agent_hits, r.agent_false, r.agent_misses.len()), (1, 1, 0));
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!(r.conflicts[0].peer, "STARBUCKS");
        assert_eq!(r.conflicts[0].elsewhere[0].category_id, treats);
        assert_eq!(r.conflicts[0].elsewhere[0].transactions, vec![treat]);
        // A Starbucks cafe is marked: the cafe side of the disagreement is covered.
        assert!(r.conflicts[0].resolved);
        assert!(r.issues.is_empty(), "{:?}", r.issues);

        assert_eq!(of(treats).issues, vec![ISSUE_FEW_EXAMPLES, ISSUE_CONFLICTS]);
        assert_eq!(of(treats).agent_hits + of(treats).agent_false, 0);
        let r = of(rent);
        assert_eq!(r.agent_misses.len(), 1);
        assert_eq!((r.agent_misses[0].transaction_id, r.agent_misses[0].suggested_category_id), (txns[3], cafe));
        assert_eq!(r.issues, vec![ISSUE_FEW_EXAMPLES, ISSUE_AGENT_MISSES]);
        assert_eq!(of(unused).issues, vec![ISSUE_NO_EXAMPLES]);
        // A parent used through its subcategories is fine.
        assert!(of(food).issues.is_empty());

        // Marking the corrected transaction addresses the miss.
        set_category_examples(&fx.state, vec![txns[3]], true).unwrap();
        let report = examples_report(&fx.state.lock().unwrap()).unwrap();
        let r = report.categories.iter().find(|r| r.category_id == rent).unwrap();
        assert_eq!(r.issues, vec![ISSUE_FEW_EXAMPLES]);
    }

    #[test]
    fn every_marked_example_goes_in_even_beyond_n() {
        let (fx, account, cafe, ..) = fixture();
        let more: Vec<i64> = (0..3)
            .map(|i| {
                let t = fx.txn(account, &format!("2026-04-0{}T03:00:00.000Z", i + 1), 1_000, "Old cafe");
                fx.categorise(t, cafe);
                t
            })
            .collect();
        set_category_examples(&fx.state, more.clone(), true).unwrap();
        let target = fx.txn(account, "2026-05-09T03:00:00.000Z", 5_000, "Somebody");
        let conn = fx.state.lock().unwrap();
        put_setting(&conn, EXAMPLES_PER_CATEGORY_KEY, "2").unwrap();
        let settings = load_settings(&conn).unwrap();
        let all = sg::load_all_facts(&conn).unwrap();
        let t = all.iter().find(|f| f.id == target).unwrap();
        let prompt = build_prompt(&conn, &settings, &all, t).unwrap();
        let cafe_examples: Vec<&PickedExample> =
            prompt.examples.iter().filter(|e| e.for_category_id == Some(cafe)).collect();
        // Three marked with N = 2: all three, and no automatic ones on top.
        assert_eq!(cafe_examples.len(), 3);
        assert!(cafe_examples.iter().all(|e| e.source == ExampleSource::Marked));
        drop(conn);
        let report = examples_report(&fx.state.lock().unwrap()).unwrap();
        let r = report.categories.iter().find(|r| r.category_id == cafe).unwrap();
        assert_eq!((r.marked.len(), r.auto.len()), (3, 0));
    }

    #[test]
    fn auto_examples_can_be_turned_off() {
        let (fx, account, ..) = fixture();
        let target = fx.txn(account, "2026-05-09T03:00:00.000Z", 5_000, "Somebody");
        let conn = fx.state.lock().unwrap();
        put_setting(&conn, AUTO_EXAMPLES_KEY, "0").unwrap();
        let settings = load_settings(&conn).unwrap();
        let all = sg::load_all_facts(&conn).unwrap();
        let t = all.iter().find(|f| f.id == target).unwrap();
        let prompt = build_prompt(&conn, &settings, &all, t).unwrap();
        assert!(prompt.examples.is_empty());
        assert!(prompt.user.contains("(no examples yet)"));
    }

    #[test]
    fn answers_are_parsed_and_validated() {
        let allowed: HashMap<i64, String> = [(12, "Food / Cafe".to_string())].into();
        let a = parse_answer("Sure!\n```json\n{\"categoryId\": \"12\", \"confidence\": 7.4, \"rationale\": \"кофе\"}\n```", &allowed)
            .unwrap();
        assert_eq!(a, Answer { category_id: Some(12), confidence: 7, rationale: "кофе".into() });
        assert!(parse_answer("{\"categoryId\": 99, \"confidence\": 5}", &allowed).unwrap_err().contains("99"));
        assert!(parse_answer("no json here", &allowed).is_err());
        assert_eq!(parse_answer("{\"categoryId\": 12, \"confidence\": 42}", &allowed).unwrap().confidence, 10);
        // Not sure: no category.
        let a = parse_answer("{\"categoryId\": null, \"confidence\": 3, \"rationale\": \"new shop\"}", &allowed).unwrap();
        assert_eq!(a, Answer { category_id: None, confidence: 3, rationale: "new shop".into() });
        assert_eq!(parse_answer("{\"categoryId\": null, \"confidence\": 2,, }", &allowed).unwrap().category_id, None);
        // Broken JSON as a model wrote it, copying the example format.
        let a = parse_answer(
            "{\"categoryId\": 12: Food / Cafe, \"confidence\": 9, \"rationale\": \"a \\\"latte\\\" at a cafe\"}",
            &allowed,
        )
        .unwrap();
        assert_eq!(a, Answer { category_id: Some(12), confidence: 9, rationale: "a \"latte\" at a cafe".into() });
    }

    #[test]
    fn manual_category_after_a_suggestion_is_logged() {
        let (fx, account, cafe, rent, _) = fixture();
        let target = fx.txn(account, "2026-05-09T03:00:00.000Z", 5_000, "Starbucks");
        {
            let conn = fx.state.lock().unwrap();
            let answer = Answer { category_id: Some(cafe), confidence: 6, rationale: "r".into() };
            upsert_llm_suggestion(&conn, target, cafe, &answer, None, "p", "m", "h").unwrap();
        }
        set_transaction_categories_by_user(
            &fx.state,
            target,
            vec![crate::transaction_categories::CategoryItem { category_id: rent, share_minor: 5_000, position: 0 }],
        )
        .unwrap();
        let (event, suggested, chosen): (String, i64, i64) = fx
            .state
            .lock()
            .unwrap()
            .query_row(
                "SELECT event, suggested_category_id, chosen_category_id FROM agent_log",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((event.as_str(), suggested, chosen), (EVENT_SET_MANUALLY, cafe, rent));
    }

    #[test]
    fn categorised_and_linked_transactions_are_skipped() {
        let (fx, _, _, _, txns) = fixture();
        let conn = fx.state.lock().unwrap();
        let outcome = prepare(&conn, txns[0], false).unwrap().err().unwrap();
        assert_eq!(outcome.reason.as_deref(), Some("already_categorized"));
        // No connection configured → an error, not a silent skip.
        drop(conn);
        let account: i64 = fx.exec("SELECT account_id FROM transactions WHERE id = ?1", [txns[0]]);
        let fresh = fx.txn(account, "2026-05-20T03:00:00.000Z", 1_000, "X");
        let conn = fx.state.lock().unwrap();
        assert_eq!(prepare(&conn, fresh, false).err().as_deref(), Some(ERR_NO_CONNECTION));
    }

    #[test]
    fn an_unsure_answer_is_not_asked_again_for_the_same_input() {
        let (fx, account, ..) = fixture();
        let target = fx.txn(account, "2026-05-20T03:00:00.000Z", 1_000, "Somebody new");
        let conn = fx.state.lock().unwrap();
        conn.execute(
            "INSERT INTO ai_connections (name, preset, protocol, base_url, model) VALUES ('Local', 'custom', 'openai', 'http://x/v1', 'm')",
            [],
        )
        .unwrap();
        put_setting(&conn, ai::AGENT_CONNECTION_KEY, &conn.last_insert_rowid().to_string()).unwrap();
        let first = prepare(&conn, target, false).unwrap().ok().unwrap();
        assert_eq!(first.min_confidence, DEFAULT_MIN_CONFIDENCE);
        assert!(first.prompt.system.contains("\"categoryId\": null"));

        let answered = |result: Value| {
            log(
                &conn,
                LogEntry {
                    event: EVENT_LLM_CALL,
                    transaction_id: Some(target),
                    result: Some(result),
                    details: Some(json!({ "inputHash": first.input_hash })),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        answered(json!({ "categoryId": null, "confidence": 3 }));
        let outcome = prepare(&conn, target, false).unwrap().err().unwrap();
        assert_eq!(outcome.reason.as_deref(), Some(SKIP_NOT_CONFIDENT));
        // "Ask again" does ask.
        assert!(prepare(&conn, target, true).unwrap().is_ok());
        // A sure answer that was later dismissed or lost is no reason to skip.
        answered(json!({ "categoryId": 1, "confidence": 9 }));
        assert!(prepare(&conn, target, false).unwrap().is_ok());
        // Below the threshold counts as unsure; lowering the threshold asks again.
        answered(json!({ "categoryId": 1, "confidence": 6 }));
        assert!(prepare(&conn, target, false).unwrap().is_err());
        put_setting(&conn, MIN_CONFIDENCE_KEY, "5").unwrap();
        assert!(prepare(&conn, target, false).unwrap().is_ok());
    }
}
