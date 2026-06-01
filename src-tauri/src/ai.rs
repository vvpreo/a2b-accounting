//! AI agent for single-transaction analysis and categorization.
//!
//! Talks to any OpenAI-compatible chat-completions endpoint (OpenRouter by
//! default — see `src/lib/ai-presets.ts`). Provider config lives in
//! `app_settings` under the `ai_provider_config` key as a JSON blob; the API
//! key may be a literal value or an `env:VAR_NAME` reference resolved from the
//! process environment at call time, so the secret never has to be stored in
//! the database.
//!
//! The agent is given every transaction field **except `balance`** (balance is
//! private and deliberately never selected) plus the list of known categories.
//! It answers in PLAIN TEXT (not JSON — many local/OpenAI-compatible servers
//! don't support JSON mode) and ends with two marker lines we parse out:
//! `Уверенность: <0..10>` and `Категория: <name | —>` (the category is the very
//! last line). The frontend persists the running dialog + the latest verdict
//! back into the `transactions.agent` column via [`set_transaction_agent`].
//!
//! HTTP follows the `frankfurter.rs` precedent (per-call reqwest client, 60s
//! timeout). Async commands take `AppHandle` and grab the DB lock only to read
//! owned data, dropping the guard before any `.await` — the same rule the
//! `exchange_rates.rs` background jobs follow (a `std::sync::Mutex` guard is
//! not `Send`).

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::db::DbState;
use crate::money;

const CONFIG_KEY: &str = "ai_provider_config";

/// The agent's system prompt template. Kept in a standalone markdown file
/// (`prompts/transaction_agent.md`) so it's easy to read and tweak without
/// hunting through Rust string literals. Two placeholders are substituted at
/// runtime: `{{TRANSACTION}}` (the transaction fields, minus balance) and
/// `{{CATEGORIES}}` (the known category list).
const SYSTEM_PROMPT_TEMPLATE: &str = include_str!("prompts/transaction_agent.md");

/// Provider configuration, parsed from the `ai_provider_config` setting.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiConfig {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    temperature: Option<f64>,
}

/// One chat turn sent from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Structured answer returned to the frontend. `reply` is the model's verbatim
/// answer (stored as-is — the single source of truth); `suggestedCategory` and
/// `confidence` are parsed out of its YAML verdict block for the UI.
///
/// The model answers in PLAIN TEXT (not JSON — many local models don't support
/// JSON mode): human-readable text, a `---` separator, then a YAML block:
///   ---
///   confidence: <0..10>
///   suggestedCategory: <name | —>
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReply {
    pub reply: String,
    pub suggested_category: Option<String>,
    pub confidence: Option<i64>,
}

fn load_config(conn: &Connection) -> Result<AiConfig, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![CONFIG_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let raw = raw.ok_or("AI provider is not configured")?;
    let cfg: AiConfig =
        serde_json::from_str(&raw).map_err(|e| format!("invalid ai_provider_config: {e}"))?;
    if cfg.base_url.trim().is_empty() {
        return Err("AI base URL is not set".to_string());
    }
    if cfg.model.trim().is_empty() {
        return Err("AI model is not set".to_string());
    }
    Ok(cfg)
}

/// Resolve the configured API key. `env:NAME` reads `NAME` from the process
/// environment (so the secret is never persisted); anything else is taken
/// literally. An empty key is allowed — local servers (Ollama/LM Studio) don't
/// need one.
fn resolve_api_key(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if let Some(var) = raw.strip_prefix("env:") {
        let var = var.trim();
        if var.is_empty() {
            return Err("empty environment variable name in API key".to_string());
        }
        std::env::var(var).map_err(|_| format!("environment variable '{var}' is not set"))
    } else {
        Ok(raw.to_string())
    }
}

/// Build the system prompt for one transaction: its fields (no balance) plus the
/// known categories and the plain-text + marker-lines output contract. Read
/// under the DB lock.
fn build_system_prompt(conn: &Connection, transaction_id: i64) -> Result<String, String> {
    let row = conn
        .query_row(
            "SELECT t.occurred_at_utc, t.credit, t.debit, t.peer, t.bank_description,
                    t.comment, a.name, a.bank, a.currency
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             WHERE t.id = ?1",
            [transaction_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((occurred, credit, debit, peer, bank_description, comment, acc_name, bank, currency)) =
        row
    else {
        return Err(format!("transaction {transaction_id} does not exist"));
    };

    let direction = if credit > 0 { "income" } else { "expense" };
    let amount = money::format_minor(if credit > 0 { credit } else { debit });
    let account = if acc_name.trim().is_empty() { bank } else { acc_name };

    let mut stmt = conn
        .prepare(
            "SELECT name, kind, description FROM categories
             ORDER BY kind ASC, name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let cats: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let mut category_lines = String::new();
    for (name, kind, desc) in &cats {
        // Include the description so the model can disambiguate by intent, not
        // just by the bare name. Fall back to "(no description)" so the model
        // knows the field exists but is empty for this category.
        let description = desc
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("(no description)");
        category_lines.push_str(&format!("- {name} ({kind}) — {description}\n"));
    }
    if cats.is_empty() {
        category_lines.push_str("(no user categories defined yet)\n");
    }
    // Always present the explicit "no category" option so the model knows that
    // leaving the transaction uncategorized is a valid, first-class choice.
    category_lines
        .push_str("- — (no category / uncategorized) — choose this (output the value \"—\") when none of the categories above clearly fit\n");

    let field = |label: &str, value: &Option<String>| -> String {
        match value.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(v) => format!("- {label}: {v}\n"),
            None => format!("- {label}: (empty)\n"),
        }
    };

    let transaction_block = format!(
        "- date (UTC): {occurred}\n\
- direction: {direction}\n\
- amount: {amount} {currency}\n\
- account: {account}\n\
{peer_line}{desc_line}{comment_line}",
        peer_line = field("peer", &peer),
        desc_line = field("bankDescription", &bank_description),
        comment_line = field("comment", &comment),
    );

    Ok(SYSTEM_PROMPT_TEMPLATE
        .replace("{{TRANSACTION}}", transaction_block.trim_end())
        .replace("{{CATEGORIES}}", category_lines.trim_end()))
}

/// A line of three-or-more dashes — the `---` separator between the human text
/// and the YAML verdict block.
fn is_separator(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3 && t.chars().all(|c| c == '-')
}

/// Treat the category value as "no suggestion" when it's empty or a dash.
fn is_empty_category(value: &str) -> bool {
    matches!(value, "" | "-" | "—" | "–" | "?")
}

/// Parse the verdict out of the model's answer. The answer is human-readable
/// text, then a `---` separator, then a small YAML block:
///   ---
///   confidence: <0..10>
///   suggestedCategory: <name | —>
/// We do NOT strip the YAML from `reply` — the full answer is stored as-is
/// (single source of truth) and the block is hidden at display time. A missing
/// separator / malformed keys degrade to `None` rather than failing.
fn parse_agent_reply(content: &str) -> AgentReply {
    let lines: Vec<&str> = content.lines().collect();
    let sep = lines.iter().rposition(|l| is_separator(l));

    let mut suggested_category: Option<String> = None;
    let mut confidence: Option<i64> = None;

    if let Some(idx) = sep {
        for line in &lines[idx + 1..] {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_lowercase();
            let value = value
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .trim();
            match key.as_str() {
                "confidence" | "уверенность" => {
                    let digits: String =
                        value.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(n) = digits.parse::<i64>() {
                        confidence = Some(n.clamp(0, 10));
                    }
                }
                "suggestedcategory" | "suggested_category" | "category" | "категория" => {
                    if !is_empty_category(value) {
                        suggested_category = Some(value.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    AgentReply {
        reply: content.trim().to_string(),
        suggested_category,
        confidence,
    }
}

/// One POST to `{base_url}/chat/completions`. Returns the assistant message
/// content as plain text. We intentionally do NOT send `response_format` — many
/// local/OpenAI-compatible servers don't support JSON mode; the answer format
/// is steered entirely by the prompt (plain text + marker lines).
async fn chat_completion(
    config: &AiConfig,
    api_key: &str,
    messages: Value,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;

    let body = json!({
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature.unwrap_or(0.0),
    });

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("AI provider returned {status}: {body}"));
    }

    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("AI response parse failed: {e}"))?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "AI response missing message content".to_string())
}

/// Send a tiny prompt to validate the configured endpoint/key/model. Used by
/// the "Test connection" button in settings.
#[tauri::command]
pub async fn ai_test_connection(app: AppHandle) -> Result<String, String> {
    let (config, api_key) = {
        let state = app.state::<DbState>();
        let conn = state.lock().map_err(|e| e.to_string())?;
        let config = load_config(&conn)?;
        let api_key = resolve_api_key(&config.api_key)?;
        (config, api_key)
    };

    let messages = json!([{ "role": "user", "content": "Reply with exactly: ok" }]);
    let content = chat_completion(&config, &api_key, messages).await?;
    let snippet: String = content.trim().chars().take(80).collect();
    Ok(format!("{}: {snippet}", config.model))
}

/// Run the agent over a single transaction. Prepends the per-transaction system
/// prompt to the provided dialog history and returns the structured answer.
#[tauri::command]
pub async fn ai_transaction_chat(
    app: AppHandle,
    transaction_id: i64,
    messages: Vec<ChatMsg>,
) -> Result<AgentReply, String> {
    let (config, api_key, system_prompt) = {
        let state = app.state::<DbState>();
        let conn = state.lock().map_err(|e| e.to_string())?;
        let config = load_config(&conn)?;
        let system_prompt = build_system_prompt(&conn, transaction_id)?;
        let api_key = resolve_api_key(&config.api_key)?;
        (config, api_key, system_prompt)
    };

    let mut msgs: Vec<Value> = vec![json!({ "role": "system", "content": system_prompt })];
    if messages.is_empty() {
        msgs.push(json!({
            "role": "user",
            "content": "Проанализируй эту транзакцию, предложи категорию и объясни рассуждение."
        }));
    } else {
        for m in &messages {
            msgs.push(json!({ "role": m.role, "content": m.content }));
        }
    }

    let content = chat_completion(&config, &api_key, json!(msgs)).await?;
    Ok(parse_agent_reply(&content))
}

/// Persist the agent JSON blob (dialog + latest verdict) for a transaction.
/// Passing `None` clears it.
#[tauri::command]
pub fn set_transaction_agent(
    state: State<'_, DbState>,
    transaction_id: i64,
    agent: Option<String>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let updated = conn
        .execute(
            "UPDATE transactions SET agent = ?1 WHERE id = ?2",
            params![agent, transaction_id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err(format!("transaction {transaction_id} does not exist"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_literal_key() {
        assert_eq!(resolve_api_key("sk-abc").unwrap(), "sk-abc");
    }

    #[test]
    fn resolve_missing_env_key_errors() {
        assert!(resolve_api_key("env:DEFINITELY_NOT_SET_VAR_XYZ").is_err());
    }

    #[test]
    fn parse_yaml_block() {
        let input = "Это покупка продуктов на рынке.\n\n---\nconfidence: 8\nsuggestedCategory: Продукты";
        let r = parse_agent_reply(input);
        // reply keeps the full answer (the YAML block is hidden only at display time).
        assert_eq!(r.reply, input);
        assert_eq!(r.suggested_category.as_deref(), Some("Продукты"));
        assert_eq!(r.confidence, Some(8));
    }

    #[test]
    fn parse_quoted_category_and_order_independent() {
        let r = parse_agent_reply(
            "Fuel at a gas station.\n---\nsuggestedCategory: \"Транспорт\"\nconfidence: 7",
        );
        assert_eq!(r.suggested_category.as_deref(), Some("Транспорт"));
        assert_eq!(r.confidence, Some(7));
        assert!(r.reply.contains("Fuel"));
    }

    #[test]
    fn parse_dash_category_is_none() {
        let r = parse_agent_reply("Непонятная операция.\n---\nconfidence: 2\nsuggestedCategory: —");
        assert!(r.suggested_category.is_none());
        assert_eq!(r.confidence, Some(2));
    }

    #[test]
    fn parse_no_separator_keeps_whole_text() {
        let r = parse_agent_reply("just some free text");
        assert_eq!(r.reply, "just some free text");
        assert!(r.suggested_category.is_none());
        assert!(r.confidence.is_none());
    }

    #[test]
    fn confidence_is_clamped() {
        let r = parse_agent_reply("text\n---\nconfidence: 42\nsuggestedCategory: X");
        assert_eq!(r.confidence, Some(10));
        assert_eq!(r.suggested_category.as_deref(), Some("X"));
    }
}
