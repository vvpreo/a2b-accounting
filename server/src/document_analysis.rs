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
//! Since documents are recognised in the background right after upload
//! (`recognition_queue.rs`), linking is also done from the document side —
//! [`auto_link_documents`] — once a whole upload is recognised; this
//! per-transaction step remains for re-running by hand.
//!
//! Recognition is local by default (PaddleOCR, see `ocr.rs`); Settings →
//! Recognition can switch it to a vision LLM (`llm_ocr.rs`), in which case the
//! image goes to the configured endpoint. Work runs on a blocking thread; the
//! DB lock is only taken for short reads/writes, never across recognition.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Datelike, Duration, FixedOffset, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::attachments::{
    apply_slip_qr, attachment_candidates_in, attachments_dir, extraction_time, offer_time, stored_file_name,
    DocTime,
};
use crate::db::DbState;
use crate::host::AppHandle;
use crate::{llm_ocr, money, ocr, slip_extract};

pub const AUTO_MATCH_WINDOW_MINUTES: i64 = 5;

/// An upload still open after this long is treated as finished — one the
/// browser abandoned must not hold its documents back from linking forever.
const STALE_UPLOAD_HOURS: i64 = 1;

/// Pre-selecting transactions by SQL around a zone-less document time: wide
/// enough for any zone offset; the exact check follows in Rust.
const MAX_OFFSET_HOURS: i64 = 15;

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
    // Keep what was read at ingest (file name, EXIF, QR); everything else is
    // recomputed.
    doc.retain(|_, v| {
        matches!(v.get("source").and_then(Value::as_str), Some("filename" | "exif" | "qr"))
    });

    let config = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        llm_ocr::load_config(&conn)?
    };
    let path = attachments_dir(data_dir).join(stored_file_name(&sha256, &mime));
    let bytes = std::fs::read(&path).map_err(|e| format!("attachments.file_missing: {e}"))?;
    let (result, source) = if config.uses_llm() {
        // We are on a blocking thread of the runtime: block on the request.
        let result = tokio::runtime::Handle::current()
            .block_on(llm_ocr::recognise(&config, &bytes, &mime))
            .map(|(fields, text)| (fields, ocr::qr_from_image(&bytes), text));
        (result, "llm")
    } else {
        (recognise_fields(&bytes, &mime), "ocr")
    };
    let (new_status, ocr_text) = match result {
        Err(e) if e.starts_with("ocr.unavailable") => return Err(e),
        Err(e) => {
            doc.insert("error".into(), json!(e));
            ("failed", None)
        }
        Ok((fields, qr, text)) => (apply_fields(&mut doc, &fields, qr.as_deref(), source), Some(text)),
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE attachments SET extract_status = ?2, extraction = ?3, ocr_text = ?4 WHERE id = ?1",
        params![id, new_status, Value::Object(doc).to_string(), ocr_text],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// OCR (layout-aware text) + field extractors. Returns the fields, the QR
/// payload and the text kept for troubleshooting.
fn recognise_fields(
    bytes: &[u8],
    mime: &str,
) -> Result<(slip_extract::TextFields, Option<String>, String), String> {
    let found = ocr::recognise(bytes, mime)?;
    Ok((slip_extract::extract(&found.text), found.qr, found.text))
}

/// Merge recognised fields into the extraction JSON; returns the status.
fn apply_fields(
    doc: &mut Map<String, Value>,
    fields: &slip_extract::TextFields,
    qr: Option<&str>,
    source: &str,
) -> &'static str {
    let ocr = |value: Value| json!({ "value": value, "source": source });

    if let Some(t) = fields.occurred_at {
        offer_time(doc, DocTime::Local(t), source);
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
    // A K PLUS reference carries a one-digit year: take the decade from the
    // time already known (printed date, file name), else from today.
    let ref_year = doc
        .get("occurredAt")
        .and_then(|v| v.get("value"))
        .and_then(Value::as_str)
        .and_then(|v| v.get(0..4)?.parse().ok())
        .unwrap_or_else(|| Utc::now().year());
    let slip_qr = qr.is_some_and(|payload| apply_slip_qr(doc, payload, ref_year));
    if !slip_qr {
        if let Some(b) = &fields.bank {
            doc.insert("bank".into(), ocr(json!(b)));
        }
        if let Some(r) = &fields.reference {
            doc.insert("reference".into(), ocr(json!(r)));
        }
    }

    if fields.amount_minor.is_none() && fields.memo.is_none() && fields.occurred_at.is_none() && !slip_qr {
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
            .filter(|c| c.attachment.transaction_id.is_none() && c.attachment.match_status != "detached")
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

/// Result of one automatic linking pass.
#[derive(Debug, Serialize, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkSummary {
    /// Documents linked in this pass.
    pub linked: usize,
    /// Documents that fit several transactions, or share one with another
    /// document — left for the user.
    pub ambiguous: usize,
}

/// Link recognised documents to transactions, document by document. Only
/// documents of uploads that are complete and fully recognised take part, so
/// every slip of a batch is known before uniqueness is judged. A document is
/// linked when it fits exactly one *outgoing* transaction (slips exist only
/// for those) without a document — time within ±[`AUTO_MATCH_WINDOW_MINUTES`],
/// amount, direction, and the sender account printed on the slip (see
/// [`account_masks`]) — and no other document fits that transaction.
/// Documents the user linked or unlinked by hand (`manual`, `detached`) are
/// never touched, and nothing is written to transactions (user comments stay
/// as they are).
pub fn auto_link_documents(conn: &Connection) -> Result<LinkSummary, String> {
    let fmt = |t: DateTime<Utc>| t.to_rfc3339_opts(SecondsFormat::Millis, true);
    let cutoff = fmt(Utc::now() - Duration::hours(STALE_UPLOAD_HOURS));
    let docs: Vec<(i64, String)> = conn
        .prepare(
            "SELECT a.id, a.extraction
             FROM attachments a JOIN attachment_uploads u ON u.id = a.upload_id
             WHERE a.transaction_id IS NULL
               AND a.match_status IN ('unmatched', 'ambiguous')
               AND a.extract_status IN ('done', 'partial')
               AND a.extraction IS NOT NULL
               AND (u.finished_at IS NOT NULL OR u.uploaded_at < ?1)
               AND NOT EXISTS (SELECT 1 FROM attachments p
                               WHERE p.upload_id = a.upload_id AND p.extract_status = 'pending')
             ORDER BY a.id",
        )
        .and_then(|mut s| s.query_map([&cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .map_err(|e| e.to_string())?;

    let mut txn_stmt = conn
        .prepare(
            "SELECT t.id, t.occurred_at_utc, t.debit, t.account_id,
                    COALESCE(b.timezone_offset,
                             (SELECT timezone_offset FROM import_batches
                              WHERE account_id = t.account_id ORDER BY id DESC LIMIT 1))
             FROM transactions t
             LEFT JOIN import_batches b ON b.id = t.import_batch_id
             WHERE t.debit > 0 AND t.occurred_at_utc BETWEEN ?1 AND ?2
               AND NOT EXISTS (SELECT 1 FROM attachments x WHERE x.transaction_id = t.id)",
        )
        .map_err(|e| e.to_string())?;
    let masks = account_masks(conn)?;
    let utc = FixedOffset::east_opt(0).expect("zero offset");
    let window = AUTO_MATCH_WINDOW_MINUTES * 60;
    let span = Duration::hours(MAX_OFFSET_HOURS) + Duration::seconds(window);

    // Document → the transactions it fits.
    let mut fitting: Vec<(i64, Vec<i64>)> = Vec::with_capacity(docs.len());
    for (doc_id, extraction) in &docs {
        let mut txns = Vec::new();
        let slip_mask = serde_json::from_str::<Value>(extraction)
            .ok()
            .and_then(|v| v.get("account")?.get("value")?.as_str().map(str::to_string));
        if let Some(time) = extraction_time(Some(extraction)) {
            let guess = time.to_utc(utc);
            let rows: Vec<(i64, String, i64, i64, Option<String>)> = txn_stmt
                .query_map(params![fmt(guess - span), fmt(guess + span)], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .and_then(|rows| rows.collect())
                .map_err(|e| e.to_string())?;
            for (txn_id, occurred, debit, account_id, offset) in rows {
                let known = masks.get(&account_id).into_iter().flatten();
                if !known.into_iter().all(|k| account_fits(slip_mask.as_deref(), Some(k))) {
                    continue;
                }
                let Ok(txn_time) = DateTime::parse_from_rfc3339(&occurred) else { continue };
                let offset = offset.and_then(|o| o.parse::<FixedOffset>().ok()).unwrap_or(utc);
                let delta = (time.to_utc(offset) - txn_time.with_timezone(&Utc)).num_seconds();
                if delta.abs() <= window && fits(Some(extraction), debit, "debit") {
                    txns.push(txn_id);
                }
            }
        }
        fitting.push((*doc_id, txns));
    }
    let mut docs_per_txn: HashMap<i64, usize> = HashMap::new();
    for txn in fitting.iter().flat_map(|(_, txns)| txns) {
        *docs_per_txn.entry(*txn).or_default() += 1;
    }

    let mut summary = LinkSummary::default();
    for (doc_id, txns) in fitting {
        let status = match txns.as_slice() {
            [] => "unmatched",
            [txn] if docs_per_txn[txn] == 1 => {
                conn.execute(
                    "UPDATE attachments SET transaction_id = ?2, match_status = 'auto'
                     WHERE id = ?1 AND transaction_id IS NULL",
                    params![doc_id, txn],
                )
                .map_err(|e| e.to_string())?;
                summary.linked += 1;
                continue;
            }
            _ => {
                summary.ambiguous += 1;
                "ambiguous"
            }
        };
        conn.execute(
            "UPDATE attachments SET match_status = ?2 WHERE id = ?1 AND transaction_id IS NULL",
            params![doc_id, status],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(summary)
}

/// What each account looks like on a slip: its number, if known, and the
/// sender mask (`xxx-x-x6813-x`) most of its linked slips carry — at least
/// [`MIN_MASK_SLIPS`] and a [`MIN_MASK_SHARE`] majority, so a few wrong links
/// do not teach a wrong mask. A slip must agree with each of them. Without this, a payment made from
/// another own account right after a transfer to it (same minute, same
/// amount, also outgoing) would take that transfer's place.
fn account_masks(conn: &Connection) -> Result<HashMap<i64, Vec<String>>, String> {
    let numbers: Vec<(i64, String)> = conn
        .prepare("SELECT id, account_number FROM accounts WHERE account_number IS NOT NULL")
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .map_err(|e| e.to_string())?;
    let mut masks: HashMap<i64, Vec<String>> = HashMap::new();
    for (account_id, number) in numbers {
        masks.entry(account_id).or_default().push(number);
    }
    let learned: Vec<(i64, String, i64, i64)> = conn
        .prepare(
            "SELECT t.account_id, json_extract(a.extraction, '$.account.value') AS mask, COUNT(*),
                    SUM(COUNT(*)) OVER (PARTITION BY t.account_id)
             FROM attachments a JOIN transactions t ON t.id = a.transaction_id
             WHERE a.match_status IN ('auto', 'manual') AND mask IS NOT NULL
             GROUP BY t.account_id, mask
             ORDER BY COUNT(*) DESC",
        )
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect())
        .map_err(|e| e.to_string())?;
    for (account_id, mask, count, total) in learned {
        if count >= MIN_MASK_SLIPS && count as f64 >= MIN_MASK_SHARE * total as f64 {
            masks.entry(account_id).or_default().push(mask);
        }
    }
    Ok(masks)
}

const MIN_MASK_SLIPS: i64 = 3;
const MIN_MASK_SHARE: f64 = 0.8;

/// Can a slip whose sender is `slip` (a mask such as `xxx-x-x6813-x`) come
/// from an account known as `known` (a number or a mask)? Digits shown on
/// both sides must agree position by position; anything unknown — no mask,
/// a different layout — does not disqualify.
fn account_fits(slip: Option<&str>, known: Option<&str>) -> bool {
    let (Some(slip), Some(known)) = (slip, known) else {
        return true;
    };
    let chars = |s: &str| s.chars().filter(char::is_ascii_alphanumeric).collect::<Vec<_>>();
    let (a, b) = (chars(slip), chars(known));
    a.len() != b.len()
        || a.iter().zip(&b).all(|(x, y)| !x.is_ascii_digit() || !y.is_ascii_digit() || x == y)
}

pub async fn analyze_transaction_documents(app: AppHandle, transaction_id: i64) -> Result<DocumentAnalysis, String> {
    let data_dir = crate::data_dir_context().data_dir.clone();
    tokio::task::spawn_blocking(move || analyze_blocking(app.db(), &data_dir, transaction_id))
        .await
        .map_err(|e| format!("analysis.panicked: {e}"))?
}

/// Re-run recognition of one document (Documents screen / document viewer).
/// Settings → Recognition "Test": a tiny request to the configured LLM.
pub async fn recognition_test_connection(app: AppHandle) -> Result<String, String> {
    let config = {
        let conn = app.db().lock().map_err(|e| e.to_string())?;
        llm_ocr::load_config(&conn)?
    };
    llm_ocr::test_connection(&config).await
}

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
        apply_fields(doc, &slip_extract::extract(text), None, "ocr")
    }

    #[test]
    fn printed_time_beats_file_name_and_qr_beats_both() {
        let mut doc: Map<String, Value> = serde_json::from_str(
            r#"{"occurredAt": {"value": "2026-10-27T11:58:55", "source": "filename"}}"#,
        )
        .unwrap();
        let status = apply_text(
            &mut doc,
            "Payment Completed\n27 Oct 26 11:58 AM\nAmount:\n360.00 Baht\nFee: 0.00 Baht\nMemo: штраф\n",
        );
        assert_eq!(status, "done");
        assert_eq!(doc["occurredAt"]["source"], "ocr");
        assert_eq!(doc["occurredAt"]["value"], "2026-10-27T11:58:00");
        assert_eq!(doc["amount"]["value"], "360.00");
        assert_eq!(doc["memo"]["value"], "штраф");
        assert_eq!(doc["direction"]["value"], "debit");
        assert!(fits(Some(&Value::Object(doc.clone()).to_string()), 36000, "debit"));
        assert!(!fits(Some(&Value::Object(doc.clone()).to_string()), 36000, "credit"));
        assert!(!fits(Some(&Value::Object(doc.clone()).to_string()), 36100, "debit"));

        // K PLUS slip QR: the reference carries the exact time (year digit 6,
        // day 300 = 27 Oct, 11:58:55), the decade comes from the printed date.
        let qr = "0041000600000101030040220016300115855CPM098665102TH9104E58C";
        apply_fields(&mut doc, &slip_extract::extract("27 Oct 26 11:58 AM\n"), Some(qr), "ocr");
        assert_eq!(doc["occurredAt"]["source"], "qr");
        assert_eq!(doc["occurredAt"]["value"], "2026-10-27T11:58:55");
        assert_eq!(doc["bank"]["value"], "Kasikorn Bank");
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

    fn debit_txn(conn: &Connection, at_utc: &str, debit: i64, credit: i64) -> i64 {
        let account: i64 = match conn.query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0)) {
            Ok(id) => id,
            Err(_) => conn
                .query_row(
                    "INSERT INTO accounts (bank, currency, account_number) VALUES ('K','THB','1') RETURNING id",
                    [],
                    |r| r.get(0),
                )
                .unwrap(),
        };
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
             VALUES (?1, ?2, ?3, ?4, ?5, 0) RETURNING id",
            params![account, batch, at_utc, credit, debit],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Document-side linking: a unique fit is linked, two slips fitting one
    /// transaction are both left `ambiguous`, an incoming transaction is
    /// never a target, an unfinished upload waits, a document the user
    /// unlinked stays unlinked.
    #[test]
    fn auto_link_documents_links_unique_outgoing_fits_only() {
        use crate::attachments::{
            begin_attachment_upload, finish_attachment_upload, ingest_upload, list_attachments,
            unlink_attachment,
        };
        let dir = tempfile::TempDir::new().unwrap();
        let db: DbState = std::sync::Mutex::new(crate::db::open(dir.path()).unwrap());
        let upload = begin_attachment_upload(&db, None).unwrap();
        // K PLUS names: 2026, day 300 (27 Oct), local +07:00.
        for (i, name) in [
            "016300115855CPM09866.jpeg", // 11:58:55 — 360.00, fits txn A only
            "016300140000CPM00001.jpeg", // 14:00:00 — 120.00, twin of the next
            "016300140100CPM00002.jpeg", // 14:01:00 — 120.00
            "016300160000CPM00003.jpeg", // 16:00:00 — 75.00, only an incoming 75.00 nearby
        ]
        .iter()
        .enumerate()
        {
            ingest_upload(&db, dir.path(), upload, name, &[0xFF, 0xD8, 0xFF, i as u8]).unwrap();
        }
        let (txn_a, txn_b) = {
            let conn = db.lock().unwrap();
            for (name, amounts) in [
                ("016300115855CPM09866.jpeg", "[36000]"),
                ("016300140000CPM00001.jpeg", "[12000]"),
                ("016300140100CPM00002.jpeg", "[12000]"),
                ("016300160000CPM00003.jpeg", "[7500]"),
            ] {
                conn.execute(
                    "UPDATE attachments SET extract_status = 'done',
                       extraction = json_set(extraction, '$.amountsMinor', json(?2))
                     WHERE original_name = ?1",
                    params![name, amounts],
                )
                .unwrap();
            }
            let a = debit_txn(&conn, "2026-10-27T04:58:00.000Z", 36000, 0);
            let b = debit_txn(&conn, "2026-10-27T07:00:00.000Z", 12000, 0);
            debit_txn(&conn, "2026-10-27T09:00:00.000Z", 0, 7500);
            // The upload is still open: nothing is linked yet.
            assert_eq!(auto_link_documents(&conn).unwrap(), LinkSummary::default());
            (a, b)
        };
        finish_attachment_upload(&db, upload).unwrap();
        let summary = auto_link_documents(&db.lock().unwrap()).unwrap();
        assert_eq!(summary, LinkSummary { linked: 1, ambiguous: 2 });

        let docs = list_attachments(&db).unwrap();
        let by_name = |n: &str| docs.iter().find(|d| d.original_name == n).unwrap().clone();
        let a_doc = by_name("016300115855CPM09866.jpeg");
        assert_eq!((a_doc.transaction_id, a_doc.match_status.as_str()), (Some(txn_a), "auto"));
        assert_eq!(by_name("016300140000CPM00001.jpeg").match_status, "ambiguous");
        assert_eq!(by_name("016300140100CPM00002.jpeg").transaction_id, None);
        assert_eq!(by_name("016300160000CPM00003.jpeg").match_status, "unmatched");

        // The user takes the auto link off: it is not re-made.
        unlink_attachment(&db, a_doc.id).unwrap();
        assert_eq!(auto_link_documents(&db.lock().unwrap()).unwrap().linked, 0);
        let a_doc = list_attachments(&db).unwrap().into_iter().find(|d| d.id == a_doc.id).unwrap();
        assert_eq!((a_doc.transaction_id, a_doc.match_status.as_str()), (None, "detached"));

        // One twin deleted → the other now fits txn B alone.
        db.lock()
            .unwrap()
            .execute("DELETE FROM attachments WHERE original_name = '016300140100CPM00002.jpeg'", [])
            .unwrap();
        assert_eq!(auto_link_documents(&db.lock().unwrap()).unwrap().linked, 1);
        let twin = list_attachments(&db).unwrap().into_iter().find(|d| d.original_name == "016300140000CPM00001.jpeg").unwrap();
        assert_eq!(twin.transaction_id, Some(txn_b));
    }

    #[test]
    fn slip_account_mask_must_agree_with_the_account() {
        assert!(account_fits(Some("xxx-x-x6813-x"), Some("xxx-x-x6813-x")));
        assert!(account_fits(Some("xxx-x-x6813-x"), Some("123-4-56813-6")));
        assert!(!account_fits(Some("xxx-x-x0330-x"), Some("xxx-x-x6813-x")));
        assert!(!account_fits(Some("953-7-xxx734"), Some("xxx-x-x6813-x")));
        assert!(account_fits(None, Some("xxx-x-x6813-x")));
        assert!(account_fits(Some("xxx-x-x0330-x"), None));
    }

    /// The account's usual slip mask is learned from its links: three x6813
    /// slips teach it, so an x0330 slip (a payment from another own account
    /// right after a transfer to it) is not linked to its outgoing transfer.
    #[test]
    fn learned_mask_keeps_other_accounts_slips_away() {
        let dir = tempfile::TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO attachment_uploads (uploaded_at, finished_at) VALUES ('2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')",
            [],
        )
        .unwrap();
        let doc = |name: &str, mask: &str, at: &str, amount: i64, txn: Option<i64>, status: &str| {
            let extraction = json!({
                "occurredAt": { "value": at, "source": "qr" },
                "account": { "value": mask, "source": "ocr" },
                "amountsMinor": [amount],
            });
            conn.execute(
                "INSERT INTO attachments (upload_id, sha256, original_name, mime_type, size_bytes,
                                          extract_status, extraction, transaction_id, match_status)
                 VALUES (1, ?1, ?1, 'image/jpeg', 1, 'done', ?2, ?3, ?4)",
                params![name, extraction.to_string(), txn, status],
            )
            .unwrap();
        };
        for (i, h) in ["01", "02", "03"].iter().enumerate() {
            let txn = debit_txn(&conn, &format!("2026-10-01T{h}:00:00.000Z"), 100 + i as i64, 0);
            doc(&format!("own{i}"), "xxx-x-x6813-x", &format!("2026-10-01T{}:00:00", 7 + i), 100 + i as i64, Some(txn), "manual");
        }
        let transfer = debit_txn(&conn, "2026-10-10T09:02:00.000Z", 450000, 0);
        doc("other", "xxx-x-x0330-x", "2026-10-10T16:03:03", 450000, None, "unmatched");
        assert_eq!(auto_link_documents(&conn).unwrap().linked, 0);

        // A slip of the account itself does link.
        doc("mine", "xxx-x-x6813-x", "2026-10-10T16:02:30", 450000, None, "unmatched");
        conn.execute("DELETE FROM attachments WHERE original_name = 'other'", []).unwrap();
        assert_eq!(auto_link_documents(&conn).unwrap().linked, 1);
        let linked: i64 = conn
            .query_row("SELECT transaction_id FROM attachments WHERE original_name = 'mine'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, transfer);
    }

    #[test]
    fn empty_text_is_not_a_document() {
        let mut doc = Map::new();
        assert_eq!(apply_text(&mut doc, "Scan QR\n"), "not_document");
    }
}
