//! AI provider settings and the connection check.
//!
//! Talks to any OpenAI-compatible chat-completions endpoint (a local Ollama on
//! the DGX Spark, OpenRouter, … — see `src/lib/ai-presets.ts`). Provider
//! config lives in `app_settings` under the `ai_provider_config` key as a JSON
//! blob; the API key may be a literal value or an `env:VAR_NAME` reference
//! resolved from the process environment at call time, so the secret never
//! has to be stored in the database.
//!
//! The former per-transaction dialog agent is gone: suggestions
//! (`suggestions.rs`) ask for an answer, not a conversation.
//!
//! HTTP follows the `frankfurter.rs` precedent (per-call reqwest client, 60s
//! timeout). Async commands take `AppHandle` and grab the DB lock only to read
//! owned data, dropping the guard before any `.await` — the same rule the
//! `exchange_rates.rs` background jobs follow (a `std::sync::Mutex` guard is
//! not `Send`).

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::host::AppHandle;

const CONFIG_KEY: &str = "ai_provider_config";

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

/// One POST to `{base_url}/chat/completions`. Returns the assistant message
/// content as plain text. We intentionally do NOT send `response_format` — many
/// local/OpenAI-compatible servers don't support JSON mode.
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
pub async fn ai_test_connection(app: AppHandle) -> Result<String, String> {
    let (config, api_key) = {
        let state = app.db();
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
}
