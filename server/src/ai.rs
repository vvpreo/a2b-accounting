//! LLM connections and the one call every agent makes.
//!
//! The user keeps any number of connections (`ai_connections`), each created
//! from a preset in the UI (`src/lib/ai-presets.ts`: OpenAI, Anthropic,
//! OpenRouter, Custom — e.g. an Ollama on the DGX Spark). A connection speaks
//! one of two protocols: OpenAI-compatible chat completions or Anthropic's
//! Messages API. [`chat`] hides the difference and returns the answer text,
//! the model's reasoning when it gave any, token usage and the exact request /
//! response JSON (for the agent log) — the API key never goes into either.
//!
//! The API key may be a literal value or an `env:VAR_NAME` reference resolved
//! from the process environment at call time, so the secret never has to be
//! stored in the database.
//!
//! HTTP follows the `frankfurter.rs` precedent (per-call reqwest client).
//! Async commands take `AppHandle` and grab the DB lock only to read owned
//! data, dropping the guard before any `.await` (a `std::sync::Mutex` guard is
//! not `Send`).

use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::DbState;
use crate::host::{AppHandle, State};

/// The pre-connections single config blob; folded into `ai_connections` once.
const LEGACY_CONFIG_KEY: &str = "ai_provider_config";
/// Which connection the category agent uses.
pub const AGENT_CONNECTION_KEY: &str = "agent.connection_id";

pub const PROTOCOL_OPENAI: &str = "openai";
pub const PROTOCOL_ANTHROPIC: &str = "anthropic";

/// Local models on a busy box can take minutes for a long prompt.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_MAX_TOKENS: u32 = 4096;

const ERR_NOT_FOUND: &str = "ai.connection_not_found";
const ERR_EMPTY_NAME: &str = "ai.empty_name";
const ERR_BAD_PROTOCOL: &str = "ai.bad_protocol";
const ERR_NO_BASE_URL: &str = "ai.no_base_url";
const ERR_NO_MODEL: &str = "ai.no_model";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnection {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub preset: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub temperature: Option<f64>,
}

fn row_to_connection(r: &rusqlite::Row) -> rusqlite::Result<AiConnection> {
    Ok(AiConnection {
        id: r.get(0)?,
        name: r.get(1)?,
        preset: r.get(2)?,
        protocol: r.get(3)?,
        base_url: r.get(4)?,
        model: r.get(5)?,
        api_key: r.get(6)?,
        temperature: r.get(7)?,
    })
}

const SELECT_CONNECTION: &str =
    "SELECT id, name, preset, protocol, base_url, model, api_key, temperature FROM ai_connections";

pub fn load_connection(conn: &Connection, id: i64) -> Result<AiConnection, String> {
    conn.query_row(&format!("{SELECT_CONNECTION} WHERE id = ?1"), [id], row_to_connection)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ERR_NOT_FOUND.to_string())
}

pub fn list_ai_connections(state: State<'_, DbState>) -> Result<Vec<AiConnection>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{SELECT_CONNECTION} ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_connection)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Create (`id == 0`) or update a connection; returns its id.
pub fn save_ai_connection(state: State<'_, DbState>, connection: AiConnection) -> Result<i64, String> {
    let c = connection;
    if c.name.trim().is_empty() {
        return Err(ERR_EMPTY_NAME.to_string());
    }
    if c.protocol != PROTOCOL_OPENAI && c.protocol != PROTOCOL_ANTHROPIC {
        return Err(ERR_BAD_PROTOCOL.to_string());
    }
    if c.base_url.trim().is_empty() {
        return Err(ERR_NO_BASE_URL.to_string());
    }
    if c.model.trim().is_empty() {
        return Err(ERR_NO_MODEL.to_string());
    }
    let conn = state.lock().map_err(|e| e.to_string())?;
    let values = params![
        c.name.trim(),
        c.preset,
        c.protocol,
        c.base_url.trim(),
        c.model.trim(),
        c.api_key.trim(),
        c.temperature,
    ];
    if c.id == 0 {
        conn.execute(
            "INSERT INTO ai_connections (name, preset, protocol, base_url, model, api_key, temperature)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            values,
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        // The first connection becomes the agent's.
        conn.execute(
            "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![AGENT_CONNECTION_KEY, id.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        let n = conn
            .execute(
                "UPDATE ai_connections SET name = ?1, preset = ?2, protocol = ?3, base_url = ?4,
                        model = ?5, api_key = ?6, temperature = ?7
                 WHERE id = ?8",
                params![
                    c.name.trim(),
                    c.preset,
                    c.protocol,
                    c.base_url.trim(),
                    c.model.trim(),
                    c.api_key.trim(),
                    c.temperature,
                    c.id
                ],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(ERR_NOT_FOUND.to_string());
        }
        Ok(c.id)
    }
}

pub fn delete_ai_connection(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ai_connections WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1 AND value = ?2",
        params![AGENT_CONNECTION_KEY, id.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Fold the old single `ai_provider_config` blob into a connection, once.
/// Runs at startup; a no-op when there is no blob.
pub fn migrate_legacy_config(conn: &Connection) -> rusqlite::Result<()> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [LEGACY_CONFIG_KEY],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(()) };
    let legacy: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let field = |k: &str| legacy[k].as_str().unwrap_or("").trim().to_string();
    let (base_url, model) = (field("baseUrl"), field("model"));
    if !base_url.is_empty() && !model.is_empty() {
        let preset = match field("presetId").as_str() {
            "" => "custom".to_string(),
            p => p.to_string(),
        };
        let name = match preset.as_str() {
            "openrouter" => "OpenRouter".to_string(),
            "openai" => "OpenAI".to_string(),
            _ => model.clone(),
        };
        conn.execute(
            "INSERT INTO ai_connections (name, preset, protocol, base_url, model, api_key, temperature)
             VALUES (?1, ?2, 'openai', ?3, ?4, ?5, ?6)",
            params![name, preset, base_url, model, field("apiKey"), legacy["temperature"].as_f64()],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![AGENT_CONNECTION_KEY, conn.last_insert_rowid().to_string()],
        )?;
    }
    conn.execute("DELETE FROM app_settings WHERE key = ?1", [LEGACY_CONFIG_KEY])?;
    Ok(())
}

/// Resolve the configured API key. `env:NAME` reads `NAME` from the process
/// environment (so the secret is never persisted); anything else is taken
/// literally. An empty key is allowed — local servers (Ollama/LM Studio) don't
/// need one.
pub(crate) fn resolve_api_key(raw: &str) -> Result<String, String> {
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

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub content: String,
    pub reasoning: Option<String>,
    pub usage: Usage,
    pub request: Value,
    pub response: Value,
    pub duration_ms: i64,
}

#[derive(Debug, Clone)]
pub struct CallError {
    pub message: String,
    pub request: Value,
    pub response: Option<Value>,
    pub duration_ms: i64,
}

/// A `<think>…</think>` block some models put at the start of the content.
fn split_think(content: &str) -> (String, Option<String>) {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            let thought = rest[..end].trim().to_string();
            let answer = rest[end + "</think>".len()..].trim().to_string();
            return (answer, (!thought.is_empty()).then_some(thought));
        }
    }
    (content.trim().to_string(), None)
}

fn openai_body(c: &AiConnection, system: &str, messages: &[(String, String)]) -> Value {
    let mut all = vec![json!({ "role": "system", "content": system })];
    all.extend(messages.iter().map(|(role, content)| json!({ "role": role, "content": content })));
    let mut body = json!({ "model": c.model, "messages": all });
    if let Some(t) = c.temperature {
        body["temperature"] = json!(t);
    }
    body
}

fn anthropic_body(c: &AiConnection, system: &str, messages: &[(String, String)]) -> Value {
    let all: Vec<Value> =
        messages.iter().map(|(role, content)| json!({ "role": role, "content": content })).collect();
    let mut body = json!({
        "model": c.model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": system,
        "messages": all,
    });
    if let Some(t) = c.temperature {
        body["temperature"] = json!(t);
    }
    body
}

fn parse_openai(v: &Value) -> Result<(String, Option<String>, Usage), String> {
    let message = &v["choices"][0]["message"];
    let raw = message["content"].as_str().ok_or("AI response missing message content")?;
    let (content, think) = split_think(raw);
    let reasoning = message["reasoning_content"]
        .as_str()
        .or_else(|| message["reasoning"].as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(think);
    let u = &v["usage"];
    let usage = Usage {
        prompt_tokens: u["prompt_tokens"].as_i64(),
        completion_tokens: u["completion_tokens"].as_i64(),
        reasoning_tokens: u["completion_tokens_details"]["reasoning_tokens"].as_i64(),
        total_tokens: u["total_tokens"].as_i64(),
    };
    Ok((content, reasoning, usage))
}

fn parse_anthropic(v: &Value) -> Result<(String, Option<String>, Usage), String> {
    let blocks = v["content"].as_array().ok_or("AI response missing content")?;
    let text_of = |kind: &str, field: &str| -> String {
        blocks
            .iter()
            .filter(|b| b["type"] == kind)
            .filter_map(|b| b[field].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let content = text_of("text", "text");
    let thinking = text_of("thinking", "thinking");
    let u = &v["usage"];
    let (input, output) = (u["input_tokens"].as_i64(), u["output_tokens"].as_i64());
    let usage = Usage {
        prompt_tokens: input,
        completion_tokens: output,
        reasoning_tokens: None,
        total_tokens: input.zip(output).map(|(a, b)| a + b),
    };
    Ok((content.trim().to_string(), (!thinking.trim().is_empty()).then(|| thinking.trim().to_string()), usage))
}

/// One request: a system prompt plus (role, content) messages. Returns the
/// answer or an error, both with the exact request (and response, when one
/// came) for the agent log.
pub async fn chat(
    c: &AiConnection,
    api_key: &str,
    system: &str,
    messages: &[(String, String)],
) -> Result<Reply, CallError> {
    let anthropic = c.protocol == PROTOCOL_ANTHROPIC;
    let request = if anthropic {
        anthropic_body(c, system, messages)
    } else {
        openai_body(c, system, messages)
    };
    let started = Instant::now();
    let fail = |message: String, response: Option<Value>| CallError {
        message,
        request: request.clone(),
        response,
        duration_ms: started.elapsed().as_millis() as i64,
    };

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| fail(format!("http client init failed: {e}"), None))?;
    let base = c.base_url.trim_end_matches('/');
    let mut req = if anthropic {
        client
            .post(format!("{base}/messages"))
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("x-api-key", api_key)
    } else {
        let r = client.post(format!("{base}/chat/completions"));
        if api_key.is_empty() { r } else { r.bearer_auth(api_key) }
    };
    req = req.json(&request);

    let resp = req.send().await.map_err(|e| fail(format!("AI request failed: {e}"), None))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| fail(format!("AI response read failed: {e}"), None))?;
    let response: Value = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));
    if !status.is_success() {
        return Err(fail(format!("AI provider returned {status}: {text}"), Some(response)));
    }
    let parsed = if anthropic { parse_anthropic(&response) } else { parse_openai(&response) };
    let (content, reasoning, usage) = parsed.map_err(|e| fail(e, Some(response.clone())))?;
    Ok(Reply {
        content,
        reasoning,
        usage,
        request,
        response,
        duration_ms: started.elapsed().as_millis() as i64,
    })
}

/// Send a tiny prompt to validate a connection. Used by the "Test connection"
/// button in settings.
pub async fn ai_test_connection(app: AppHandle, id: i64) -> Result<String, String> {
    let (connection, api_key) = {
        let state = app.db();
        let conn = state.lock().map_err(|e| e.to_string())?;
        let connection = load_connection(&conn, id)?;
        let api_key = resolve_api_key(&connection.api_key)?;
        (connection, api_key)
    };
    let messages = [("user".to_string(), "Reply with exactly: ok".to_string())];
    let reply = chat(&connection, &api_key, "You are a connection check.", &messages)
        .await
        .map_err(|e| e.message)?;
    let snippet: String = reply.content.trim().chars().take(80).collect();
    Ok(format!("{}: {snippet}", connection.model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_literal_key() {
        assert_eq!(resolve_api_key("  sk-123 ").unwrap(), "sk-123");
    }

    #[test]
    fn resolve_missing_env_key_errors() {
        assert!(resolve_api_key("env:A2B_SURELY_UNSET_VAR_42").is_err());
    }

    #[test]
    fn think_block_is_split_off() {
        let (answer, thought) = split_think("<think>hmm\nok</think>\n{\"a\":1}");
        assert_eq!(answer, "{\"a\":1}");
        assert_eq!(thought.as_deref(), Some("hmm\nok"));
        assert_eq!(split_think(" plain ").0, "plain");
    }

    #[test]
    fn openai_reply_with_reasoning_and_usage() {
        let v = json!({
            "choices": [{ "message": { "content": "{}", "reasoning": "because" } }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                       "completion_tokens_details": { "reasoning_tokens": 3 } }
        });
        let (content, reasoning, usage) = parse_openai(&v).unwrap();
        assert_eq!(content, "{}");
        assert_eq!(reasoning.as_deref(), Some("because"));
        assert_eq!(usage.total_tokens, Some(15));
        assert_eq!(usage.reasoning_tokens, Some(3));
    }

    #[test]
    fn anthropic_reply_text_thinking_and_usage() {
        let v = json!({
            "content": [
                { "type": "thinking", "thinking": "let me see" },
                { "type": "text", "text": "{\"categoryId\":1}" }
            ],
            "usage": { "input_tokens": 100, "output_tokens": 20 }
        });
        let (content, reasoning, usage) = parse_anthropic(&v).unwrap();
        assert_eq!(content, "{\"categoryId\":1}");
        assert_eq!(reasoning.as_deref(), Some("let me see"));
        assert_eq!(usage.total_tokens, Some(120));
    }

    #[test]
    fn legacy_config_becomes_a_connection() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('ai_provider_config', ?1)",
            [json!({ "presetId": "openrouter", "baseUrl": "https://openrouter.ai/api/v1",
                     "model": "qwen/qwen3-30b-a3b", "apiKey": "env:OPENROUTER_API_KEY",
                     "temperature": 0 }).to_string()],
        )
        .unwrap();
        migrate_legacy_config(&conn).unwrap();
        let (name, protocol, key): (String, String, String) = conn
            .query_row("SELECT name, protocol, api_key FROM ai_connections", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((name.as_str(), protocol.as_str(), key.as_str()), ("OpenRouter", "openai", "env:OPENROUTER_API_KEY"));
        let legacy: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_settings WHERE key = 'ai_provider_config'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy, 0);
        // Idempotent.
        migrate_legacy_config(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM ai_connections", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
