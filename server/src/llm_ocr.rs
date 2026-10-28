//! Alternative document recognition through a vision-capable LLM (any
//! OpenAI-compatible chat endpoint: OpenRouter, OpenAI, a local Ollama /
//! LM Studio …). Chosen in Settings → Recognition; the default is the local
//! PaddleOCR pipeline (`ocr.rs`).
//!
//! The document image is sent to the configured endpoint — when that is a
//! cloud service, the image leaves the machine (the settings page says so).
//!
//! The model is asked for the full transcription plus the fields we use, as a
//! JSON object. Fields it does not return are filled in by the regular text
//! extractors (`slip_extract.rs`) run over its transcription.

use std::time::Duration;

use base64::Engine as _;
use chrono::NaiveDateTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::slip_extract::{self, TextFields};

pub const CONFIG_KEY: &str = "document_recognition_config";

/// Settings → Recognition, stored as JSON under [`CONFIG_KEY`].
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RecognitionConfig {
    /// `"local"` (PaddleOCR, default) or `"llm"`.
    pub engine: String,
    pub base_url: String,
    pub model: String,
    /// Literal key or `env:VAR_NAME` (see `ai::resolve_api_key`).
    pub api_key: String,
    pub temperature: Option<f64>,
}

impl RecognitionConfig {
    pub fn uses_llm(&self) -> bool {
        self.engine == "llm"
    }
}

pub fn load_config(conn: &Connection) -> Result<RecognitionConfig, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![CONFIG_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

const PROMPT: &str = r#"You read a single payment document: a bank transfer slip, a receipt or a payment screenshot. It may be in English, Russian, Thai or a mix.

Answer with ONE JSON object and nothing else:
{
  "text": "<every piece of text you see, top to bottom, one visual line per line; separate a label from its value on the same line with ' | '>",
  "occurredAt": "<date and time as printed, as YYYY-MM-DDTHH:MM:SS (no time zone; convert Buddhist-era years to AD), or null>",
  "amount": "<the main paid/received amount as digits with a dot, e.g. 1234.50, or null>",
  "currency": "<ISO currency code if shown, else null>",
  "direction": "<\"debit\" if money left the payer's account shown as the sender, \"credit\" if it was received, or null>",
  "account": "<the sender's masked account number exactly as printed, or null>",
  "memo": "<the payer's own note — the text after a label such as Memo, Note, Remark, Заметка, บันทึกช่วยจำ — exactly as written, or null>",
  "bank": "<sending bank name, or null>",
  "reference": "<transaction ID / reference number, or null>"
}
Copy text exactly as printed — do not translate or correct it. Use null for anything that is not on the document."#;

/// Recognise one document with the configured LLM. Errors that would repeat
/// for every document (missing key, wrong endpoint/model, auth) are prefixed
/// `ocr.unavailable` so a bulk run stops at the first one.
pub async fn recognise(
    config: &RecognitionConfig,
    bytes: &[u8],
    mime: &str,
) -> Result<(TextFields, String), String> {
    if !mime.starts_with("image/") {
        return Err("ocr.unsupported_type".into());
    }
    if config.base_url.trim().is_empty() || config.model.trim().is_empty() {
        return Err("ocr.unavailable: LLM recognition: base URL and model must be set".into());
    }
    let api_key = crate::ai::resolve_api_key(&config.api_key)
        .map_err(|e| format!("ocr.unavailable: LLM recognition: {e}"))?;
    let image_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    let messages = json!([{
        "role": "user",
        "content": [
            { "type": "text", "text": PROMPT },
            { "type": "image_url", "image_url": { "url": image_url } }
        ]
    }]);
    let reply = chat(config, &api_key, messages).await?;
    let parsed = parse_reply(&reply)
        .ok_or_else(|| format!("llm.bad_reply: {}", reply.chars().take(200).collect::<String>()))?;
    Ok(to_fields(&parsed))
}

/// Tiny request to validate endpoint, key and model (Settings → Test).
pub async fn test_connection(config: &RecognitionConfig) -> Result<String, String> {
    let api_key = crate::ai::resolve_api_key(&config.api_key)?;
    let reply = chat(config, &api_key, json!([{ "role": "user", "content": "Reply with exactly: ok" }])).await?;
    Ok(format!("{}: {}", config.model, reply.trim().chars().take(80).collect::<String>()))
}

async fn chat(config: &RecognitionConfig, api_key: &str, messages: Value) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let body = json!({
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature.unwrap_or(0.0),
    });
    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("ocr.unavailable: LLM request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let body: String = body.chars().take(300).collect();
        // 4xx = configuration (key, model, endpoint) — the same for every
        // document; 5xx may be transient but would usually repeat as well.
        return Err(format!("ocr.unavailable: LLM provider returned {status}: {body}"));
    }
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("llm.bad_reply: {e}"))?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "llm.bad_reply: no message content".to_string())
}

/// The first balanced `{…}` in the reply (models like to wrap JSON in code
/// fences or add a sentence around it).
fn parse_reply(reply: &str) -> Option<Value> {
    let start = reply.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, c) in reply[start..].char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' if in_str => escaped = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&reply[start..=start + i]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str().map(str::trim).filter(|s| !s.is_empty() && *s != "null")
}

/// Model answer → fields; whatever it left out comes from the text
/// extractors over its own transcription.
fn to_fields(v: &Value) -> (TextFields, String) {
    let text = str_field(v, "text").unwrap_or_default().to_string();
    let mut fields = slip_extract::extract(&text);
    if let Some(t) = str_field(v, "occurredAt").and_then(|s| {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
            .ok()
    }) {
        fields.occurred_at = Some(t);
    }
    if let Some(a) = str_field(v, "amount").and_then(|s| crate::money::parse_minor(&s.replace(',', "")).ok()) {
        fields.amount_minor = Some(a);
        if !fields.all_amounts_minor.contains(&a) {
            fields.all_amounts_minor.push(a);
        }
    }
    match str_field(v, "direction") {
        Some("debit") => fields.direction = Some("debit"),
        Some("credit") => fields.direction = Some("credit"),
        _ => {}
    }
    if let Some(a) = str_field(v, "account") {
        fields.account_mask = Some(a.to_lowercase());
    }
    if let Some(m) = str_field(v, "memo") {
        fields.memo = Some(m.to_string());
    }
    fields.bank = str_field(v, "bank").map(str::to_string);
    fields.reference = str_field(v, "reference").map(str::to_string);
    (fields, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_parsing_tolerates_fences_and_prose() {
        let reply = "Here you go:\n```json\n{\"text\": \"Memo: {x}\", \"memo\": \"латте Насте\", \"amount\": \"55.00\"}\n```";
        let v = parse_reply(reply).unwrap();
        assert_eq!(v["memo"], "латте Насте");
        assert!(parse_reply("no json here").is_none());
    }

    #[test]
    fn model_fields_win_and_gaps_come_from_the_transcript() {
        let v = json!({
            "text": "Payment Completed\n27 Oct 26 11:58 AM\nAmount: | 360.00 Baht\nMemo: штраф",
            "occurredAt": null,
            "amount": "360.00",
            "direction": "debit",
            "account": "XXX-X-X1234-X",
            "memo": "штраф за неоплату",
            "bank": "Kasikorn Bank",
            "reference": "016300115855CPM09866"
        });
        let (f, text) = to_fields(&v);
        assert!(text.starts_with("Payment Completed"));
        // occurredAt null → taken from the transcript.
        assert_eq!(f.occurred_at.unwrap().to_string(), "2026-10-27 11:58:00");
        assert_eq!(f.amount_minor, Some(36000));
        assert_eq!(f.memo.as_deref(), Some("штраф за неоплату"));
        assert_eq!(f.account_mask.as_deref(), Some("xxx-x-x1234-x"));
        assert_eq!(f.bank.as_deref(), Some("Kasikorn Bank"));
        assert_eq!(f.reference.as_deref(), Some("016300115855CPM09866"));
    }

    #[test]
    fn config_defaults_to_local() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        assert!(!load_config(&conn).unwrap().uses_llm());
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
            params![CONFIG_KEY, r#"{"engine":"llm","baseUrl":"http://x/v1","model":"m"}"#],
        )
        .unwrap();
        let c = load_config(&conn).unwrap();
        assert!(c.uses_llm());
        assert_eq!(c.model, "m");
    }
}
