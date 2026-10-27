//! The "Analyze" step for documents of one transaction — run by hand from the
//! Transactions screen (one row or a whole selected month):
//!
//! 1. If the transaction already has a linked document, recognise it (OCR +
//!    field extractors) unless that was done before.
//! 2. Otherwise take the documents whose time is within ±[`AUTO_MATCH_WINDOW_MINUTES`]
//!    of the transaction and are not linked elsewhere, recognise them, and
//!    **auto-link** when exactly one of them carries the transaction's amount
//!    with a compatible direction. Account and bank are not required — time +
//!    amount + direction + uniqueness is the rule agreed with the user.
//! 3. Report what happened and the document's memo — the note the user wrote
//!    on the slip, which is what categorisation needs.
//!
//! Recognition is local (see `ocr.rs`); nothing is sent anywhere. Work runs on
//! a blocking thread; the DB lock is only taken for short reads/writes, never
//! across OCR.

use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::attachments::{attachment_candidates_in, attachments_dir, stored_file_name};
use crate::db::DbState;
use crate::host::AppHandle;
use crate::{money, ocr, slip_extract};

pub const AUTO_MATCH_WINDOW_MINUTES: i64 = 5;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAnalysis {
    /// `linked` (already had a document), `auto_linked`, `ambiguous` (several
    /// documents fit), `no_match` (documents nearby, none with this amount),
    /// `no_candidates` (no free document in the time window).
    pub status: &'static str,
    pub attachment_id: Option<i64>,
    pub memo: Option<String>,
    /// Free documents that were in the time window.
    pub candidates: usize,
}

/// Recognise one document if it has not been recognised yet (or always, with
/// `force`). Environment problems (no OCR binary) are returned as errors;
/// problems with the document itself are recorded on it (`failed`).
pub fn recognise_attachment(db: &DbState, data_dir: &Path, id: i64, force: bool) -> Result<(), String> {
    let (sha256, mime, status, extraction): (String, String, String, Option<String>) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sha256, mime_type, extract_status, extraction FROM attachments WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("attachment {id} does not exist"))?
    };
    if !force && status != "pending" {
        return Ok(());
    }

    let mut doc: Map<String, Value> = extraction
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    // Keep only what does not come from OCR (the file-name time); everything
    // else is recomputed.
    doc.retain(|_, v| v.get("source").and_then(Value::as_str) == Some("filename"));

    let path = attachments_dir(data_dir).join(stored_file_name(&sha256, &mime));
    let bytes = std::fs::read(&path).map_err(|e| format!("attachments.file_missing: {e}"))?;
    let (new_status, ocr_text) = match recognise_fields(&bytes, &mime) {
        Err(e) if e.starts_with("ocr.unavailable") => return Err(e),
        Err(e) => {
            doc.insert("error".into(), json!(e));
            ("failed", None)
        }
        Ok((fields, qr, text)) => (apply_fields(&mut doc, &fields, qr.as_deref()), Some(text)),
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE attachments SET extract_status = ?2, extraction = ?3, ocr_text = ?4 WHERE id = ?1",
        params![id, new_status, Value::Object(doc).to_string(), ocr_text],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// OCR at ×1.5; when the amount was missed, once more at ×2 — amount fields
/// from the second pass, everything else from whichever pass found it.
/// Returns the fields, the QR payload and the text kept for troubleshooting.
fn recognise_fields(
    bytes: &[u8],
    mime: &str,
) -> Result<(slip_extract::TextFields, Option<String>, String), String> {
    let first = ocr::recognise(bytes, mime, 150)?;
    let mut fields = slip_extract::extract(&first.text);
    if fields.amount_minor.is_some() {
        return Ok((fields, first.qr, first.text));
    }
    let second = ocr::recognise(bytes, mime, 200)?;
    let retry = slip_extract::extract(&second.text);
    if retry.amount_minor.is_none() {
        return Ok((fields, first.qr, first.text));
    }
    fields.amount_minor = retry.amount_minor;
    fields.all_amounts_minor = retry.all_amounts_minor;
    fields.occurred_at = fields.occurred_at.or(retry.occurred_at);
    fields.direction = fields.direction.or(retry.direction);
    fields.account_mask = fields.account_mask.or(retry.account_mask);
    fields.memo = fields.memo.or(retry.memo);
    Ok((fields, first.qr.or(second.qr), second.text))
}

/// Merge recognised fields into the extraction JSON; returns the status.
fn apply_fields(
    doc: &mut Map<String, Value>,
    fields: &slip_extract::TextFields,
    qr: Option<&str>,
) -> &'static str {
    let ocr = |value: Value| json!({ "value": value, "source": "ocr" });

    if !doc.contains_key("occurredAt") {
        if let Some(t) = fields.occurred_at {
            doc.insert("occurredAt".into(), ocr(json!(t.format("%Y-%m-%dT%H:%M:%S").to_string())));
        }
    }
    if let Some(a) = fields.amount_minor {
        doc.insert("amount".into(), ocr(json!(money::format_minor(a))));
    }
    if !fields.all_amounts_minor.is_empty() {
        doc.insert("amountsMinor".into(), json!(fields.all_amounts_minor));
    }
    if let Some(d) = fields.direction {
        doc.insert("direction".into(), ocr(json!(d)));
    }
    if let Some(m) = &fields.account_mask {
        doc.insert("account".into(), ocr(json!(m)));
    }
    if let Some(m) = &fields.memo {
        doc.insert("memo".into(), ocr(json!(m)));
    }
    let slip_qr = qr.and_then(ocr::parse_slip_verify_qr);
    if let Some((code, reference)) = &slip_qr {
        let bank = ocr::thai_bank_name(code).map(str::to_string).unwrap_or_else(|| code.clone());
        doc.insert("bank".into(), json!({ "value": bank, "source": "qr" }));
        doc.insert("reference".into(), json!({ "value": reference, "source": "qr" }));
    }

    if fields.amount_minor.is_none() && fields.memo.is_none() && fields.occurred_at.is_none() && slip_qr.is_none() {
        "not_document"
    } else if fields.amount_minor.is_some() {
        "done"
    } else {
        "partial"
    }
}

fn memo_of(extraction: Option<&str>) -> Option<String> {
    let v: Value = serde_json::from_str(extraction?).ok()?;
    v.get("memo")?.get("value")?.as_str().map(str::to_string)
}

/// Does a recognised document fit a transaction of `amount_minor` going in
/// `direction` (`debit`/`credit`)? Unknown direction does not disqualify.
fn fits(extraction: Option<&str>, amount_minor: i64, direction: &str) -> bool {
    let Some(v) = extraction.and_then(|s| serde_json::from_str::<Value>(s).ok()) else {
        return false;
    };
    let has_amount = v
        .get("amountsMinor")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(amount_minor)));
    let doc_dir = v.get("direction").and_then(|d| d.get("value")).and_then(Value::as_str);
    has_amount && doc_dir.is_none_or(|d| d == direction)
}

pub fn analyze_blocking(db: &DbState, data_dir: &Path, transaction_id: i64) -> Result<DocumentAnalysis, String> {
    let (linked, amount_minor, direction, candidates) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let (credit, debit): (i64, i64) = conn
            .query_row(
                "SELECT credit, debit FROM transactions WHERE id = ?1",
                [transaction_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("transaction {transaction_id} does not exist"))?;
        let linked: Vec<i64> = conn
            .prepare("SELECT id FROM attachments WHERE transaction_id = ?1 ORDER BY id")
            .and_then(|mut s| s.query_map([transaction_id], |r| r.get(0))?.collect())
            .map_err(|e| e.to_string())?;
        let candidates: Vec<i64> = attachment_candidates_in(&conn, transaction_id, AUTO_MATCH_WINDOW_MINUTES)?
            .candidates
            .into_iter()
            .filter(|c| c.attachment.transaction_id.is_none())
            .map(|c| c.attachment.id)
            .collect();
        let (amount, dir) = if credit > 0 { (credit, "credit") } else { (debit, "debit") };
        (linked, amount, dir, candidates)
    };

    let read_extraction = |id: i64| -> Result<Option<String>, String> {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT extraction FROM attachments WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|e| e.to_string())
    };

    if let Some(&first) = linked.first() {
        for &id in &linked {
            recognise_attachment(db, data_dir, id, false)?;
        }
        return Ok(DocumentAnalysis {
            status: "linked",
            attachment_id: Some(first),
            memo: memo_of(read_extraction(first)?.as_deref()),
            candidates: 0,
        });
    }

    let mut fitting = Vec::new();
    for &id in &candidates {
        recognise_attachment(db, data_dir, id, false)?;
        if fits(read_extraction(id)?.as_deref(), amount_minor, direction) {
            fitting.push(id);
        }
    }
    let status = match (candidates.len(), fitting.len()) {
        (0, _) => "no_candidates",
        (_, 0) => "no_match",
        (_, 1) => "auto_linked",
        _ => "ambiguous",
    };
    if status != "auto_linked" {
        return Ok(DocumentAnalysis { status, attachment_id: None, memo: None, candidates: candidates.len() });
    }
    let id = fitting[0];
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        // Only if still free — a parallel run may have taken it.
        conn.execute(
            "UPDATE attachments SET transaction_id = ?2, match_status = 'auto'
             WHERE id = ?1 AND transaction_id IS NULL",
            params![id, transaction_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(DocumentAnalysis {
        status,
        attachment_id: Some(id),
        memo: memo_of(read_extraction(id)?.as_deref()),
        candidates: candidates.len(),
    })
}

pub async fn analyze_transaction_documents(app: AppHandle, transaction_id: i64) -> Result<DocumentAnalysis, String> {
    let data_dir = crate::data_dir_context().data_dir.clone();
    tokio::task::spawn_blocking(move || analyze_blocking(app.db(), &data_dir, transaction_id))
        .await
        .map_err(|e| format!("analysis.panicked: {e}"))?
}

/// Re-run recognition of one document (Documents screen / document viewer).
pub async fn recognise_document(app: AppHandle, attachment_id: i64) -> Result<(), String> {
    let data_dir = crate::data_dir_context().data_dir.clone();
    tokio::task::spawn_blocking(move || recognise_attachment(app.db(), &data_dir, attachment_id, true))
        .await
        .map_err(|e| format!("analysis.panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_text(doc: &mut Map<String, Value>, text: &str) -> &'static str {
        apply_fields(doc, &slip_extract::extract(text), None)
    }

    #[test]
    fn fields_merge_keeps_file_name_time() {
        let mut doc: Map<String, Value> = serde_json::from_str(
            r#"{"occurredAt": {"value": "2026-10-27T11:58:55", "source": "filename"}}"#,
        )
        .unwrap();
        let status = apply_text(
            &mut doc,
            "Payment Completed\n27 Oct 26 11:58 AM\nAmount:\n360.00 Baht\nFee: 0.00 Baht\nMemo: штраф\n",
        );
        assert_eq!(status, "done");
        assert_eq!(doc["occurredAt"]["source"], "filename");
        assert_eq!(doc["amount"]["value"], "360.00");
        assert_eq!(doc["memo"]["value"], "штраф");
        assert_eq!(doc["direction"]["value"], "debit");
        assert!(fits(Some(&Value::Object(doc.clone()).to_string()), 36000, "debit"));
        assert!(!fits(Some(&Value::Object(doc.clone()).to_string()), 36000, "credit"));
        assert!(!fits(Some(&Value::Object(doc).to_string()), 36100, "debit"));
    }

    /// Two recognised slips near a 360.00 debit at 11:58 (+07:00): only one
    /// carries the amount → it is auto-linked; a second identical run finds
    /// the transaction already linked.
    #[test]
    fn auto_links_the_single_fitting_document() {
        use crate::attachments::{begin_attachment_upload, ingest_upload, list_attachments};
        let dir = tempfile::TempDir::new().unwrap();
        let db: DbState = std::sync::Mutex::new(crate::db::open(dir.path()).unwrap());
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "016300115855CPM09866.jpeg", &[0xFF, 0xD8, 0xFF, 1]).unwrap();
        ingest_upload(&db, dir.path(), upload, "016300115930CPM09999.jpeg", &[0xFF, 0xD8, 0xFF, 2]).unwrap();
        let txn: i64 = {
            let conn = db.lock().unwrap();
            for (name, amounts, memo) in [
                ("016300115855CPM09866.jpeg", "[36000, 0]", "штраф"),
                ("016300115930CPM09999.jpeg", "[5500, 0]", "латте"),
            ] {
                conn.execute(
                    "UPDATE attachments SET extract_status = 'done',
                       extraction = json_set(extraction, '$.amountsMinor', json(?2),
                                             '$.memo', json_object('value', ?3, 'source', 'ocr'))
                     WHERE original_name = ?1",
                    params![name, amounts, memo],
                )
                .unwrap();
            }
            let account: i64 = conn
                .query_row("INSERT INTO accounts (bank, currency, account_number) VALUES ('K','THB','1') RETURNING id", [], |r| r.get(0))
                .unwrap();
            let batch: i64 = conn
                .query_row(
                    "INSERT INTO import_batches (account_id, imported_at, row_count, timezone_offset)
                     VALUES (?1, '2026-10-27T00:00:00Z', 1, '+07:00') RETURNING id",
                    [account],
                    |r| r.get(0),
                )
                .unwrap();
            conn.query_row(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-10-27T04:58:00.000Z', 0, 36000, 0) RETURNING id",
                params![account, batch],
                |r| r.get(0),
            )
            .unwrap()
        };

        let first = analyze_blocking(&db, dir.path(), txn).unwrap();
        assert_eq!(first.status, "auto_linked");
        assert_eq!(first.candidates, 2);
        assert_eq!(first.memo.as_deref(), Some("штраф"));
        let docs = list_attachments(&db).unwrap();
        let linked: Vec<_> = docs.iter().filter(|d| d.transaction_id == Some(txn)).collect();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].match_status, "auto");

        let again = analyze_blocking(&db, dir.path(), txn).unwrap();
        assert_eq!(again.status, "linked");
        assert_eq!(again.memo.as_deref(), Some("штраф"));
    }

    #[test]
    fn empty_text_is_not_a_document() {
        let mut doc = Map::new();
        assert_eq!(apply_text(&mut doc, "Scan QR\n"), "not_document");
    }
}
