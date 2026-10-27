//! Document storage: bank slips, receipts and other files the user uploads to
//! annotate transactions.
//!
//! Files are content-addressed on disk — `<data dir>/attachments/<sha256>.<ext>`
//! — and described by rows in `attachments`; every upload action from the UI
//! is recorded in `attachment_uploads` so the user can see when documents were
//! last uploaded. A ZIP (e.g. a Google Drive / Google Photos download) is
//! unpacked server-side: every entry that sniffs as a supported document is
//! ingested, everything else (folders, `__MACOSX/`, sidecar JSON, nested
//! archives) is skipped.
//!
//! Upload protocol (see `http.rs`): the frontend first calls
//! `begin_attachment_upload` to open an upload record, then POSTs each picked
//! file as a raw body to `/api/attachments/upload/<upload id>?name=<file name>`.
//! Per-file requests keep request sizes bounded and let the UI show progress.
//!
//! Heavy work (hashing, unzipping, writing files) runs without the DB lock;
//! the lock is taken once per request only to insert the collected rows.
//!
//! Recognition is a set of independent per-field extractors writing into the
//! `extraction` JSON (`{field: {value, source}}`). The first and cheapest one
//! runs at ingest: the document time from the *file name* (see
//! [`time_from_file_name`]) — enough to offer documents around a transaction's
//! time for manual linking before any OCR has run.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::db::DbState;
use crate::host::State;

pub const ATTACHMENTS_DIR: &str = "attachments";

/// Upper bounds for a single uploaded ZIP — protection against archive bombs.
const MAX_ZIP_ENTRIES: usize = 50_000;
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// How many skipped names an ingest report echoes back to the UI.
const MAX_REPORTED_SKIPS: usize = 50;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUpload {
    pub id: i64,
    pub uploaded_at: String,
    pub source_name: Option<String>,
    pub files_total: i64,
    pub added: i64,
    pub duplicates: i64,
    pub skipped: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i64,
    pub upload_id: i64,
    pub uploaded_at: String,
    pub sha256: String,
    pub original_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub extract_status: String,
    pub extraction: Option<String>,
    pub ocr_text: Option<String>,
    pub transaction_id: Option<i64>,
    pub match_status: String,
}

/// Outcome of ingesting one uploaded file (which may be a whole ZIP).
#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IngestReport {
    pub files_total: i64,
    pub added: i64,
    pub duplicates: i64,
    pub skipped: i64,
    /// First few skipped names (with the reason) for the UI.
    pub skipped_names: Vec<String>,
}

/// A document prepared for insertion: already hashed and written to disk.
struct Prepared {
    sha256: String,
    original_name: String,
    mime_type: &'static str,
    size_bytes: i64,
    extraction: Option<String>,
}

pub fn attachments_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(ATTACHMENTS_DIR)
}

/// Supported document types, detected by content signature — never by the
/// file extension (Bangkok Bank slips, for one, are PNGs named `*.jpeg`).
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else {
        None
    }
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

pub fn stored_file_name(sha256: &str, mime: &str) -> String {
    format!("{sha256}.{}", extension_for(mime))
}

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// ZIP entries that are never documents: folders, macOS resource forks and
/// dot-files.
fn is_junk_entry(name: &str) -> bool {
    name.ends_with('/')
        || name.starts_with("__MACOSX/")
        || name.contains("/__MACOSX/")
        || name.rsplit('/').next().is_some_and(|base| base.starts_with('.'))
}

/// Hash `bytes`, write them under `dir` (once — the name is the hash) and
/// return the row to insert, or `None` when the content is not a supported
/// document.
fn prepare(dir: &Path, name: &str, bytes: &[u8]) -> Result<Option<Prepared>, String> {
    let Some(mime) = sniff_mime(bytes) else {
        return Ok(None);
    };
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    let path = dir.join(stored_file_name(&sha256, mime));
    if !path.exists() {
        // Write to a temp name first so a crash never leaves a truncated file
        // under the final (content-addressed) name.
        let tmp = dir.join(format!(".{sha256}.part"));
        fs::write(&tmp, bytes).map_err(|e| format!("attachments.write: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("attachments.write: {e}"))?;
    }
    Ok(Some(Prepared {
        sha256,
        original_name: name.to_string(),
        mime_type: mime,
        size_bytes: bytes.len() as i64,
        extraction: filename_extraction(name, Utc::now().year()),
    }))
}

fn note_skip(report: &mut IngestReport, name: &str, reason: &str) {
    report.skipped += 1;
    if report.skipped_names.len() < MAX_REPORTED_SKIPS {
        report.skipped_names.push(format!("{name} — {reason}"));
    }
}

/// Unpack and prepare one uploaded file. ZIPs are expanded (one level — a ZIP
/// inside a ZIP is skipped), anything else is treated as a single document.
fn prepare_upload(
    dir: &Path,
    name: &str,
    bytes: &[u8],
    report: &mut IngestReport,
) -> Result<Vec<Prepared>, String> {
    fs::create_dir_all(dir).map_err(|e| format!("attachments.mkdir: {e}"))?;
    let mut out = Vec::new();

    if !is_zip(bytes) {
        report.files_total += 1;
        match prepare(dir, name, bytes)? {
            Some(p) => out.push(p),
            None => note_skip(report, name, "unsupported"),
        }
        return Ok(out);
    }

    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("attachments.bad_zip: {e}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err("attachments.zip_too_many_entries".into());
    }
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("attachments.bad_zip: {e}"))?;
        let entry_name = entry.name().to_string();
        if entry.is_dir() || is_junk_entry(&entry_name) {
            continue;
        }
        report.files_total += 1;
        if entry.size() > MAX_ENTRY_BYTES {
            note_skip(report, &entry_name, "too large");
            continue;
        }
        total += entry.size();
        if total > MAX_ZIP_TOTAL_BYTES {
            return Err("attachments.zip_too_large".into());
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        // `take` guards against a lying size header.
        (&mut entry)
            .take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("attachments.bad_zip: {e}"))?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            note_skip(report, &entry_name, "too large");
            continue;
        }
        if is_zip(&buf) {
            note_skip(report, &entry_name, "nested archive");
            continue;
        }
        match prepare(dir, &entry_name, &buf)? {
            Some(p) => out.push(p),
            None => note_skip(report, &entry_name, "unsupported"),
        }
    }
    Ok(out)
}

/// Insert prepared rows (duplicates by content hash are counted, not
/// re-inserted) and add the counters to the upload record.
fn insert_prepared(
    conn: &Connection,
    upload_id: i64,
    prepared: Vec<Prepared>,
    report: &mut IngestReport,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM attachment_uploads WHERE id = ?1",
            [upload_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !exists {
        return Err(format!("attachments.upload_not_found: {upload_id}"));
    }
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO attachments
                 (upload_id, sha256, original_name, mime_type, size_bytes, extraction)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;
        for p in prepared {
            let n = stmt
                .execute(params![
                    upload_id,
                    p.sha256,
                    p.original_name,
                    p.mime_type,
                    p.size_bytes,
                    p.extraction
                ])
                .map_err(|e| e.to_string())?;
            if n == 1 {
                report.added += 1;
            } else {
                report.duplicates += 1;
            }
        }
    }
    tx.execute(
        "UPDATE attachment_uploads
         SET files_total = files_total + ?2, added = added + ?3,
             duplicates = duplicates + ?4, skipped = skipped + ?5
         WHERE id = ?1",
        params![upload_id, report.files_total, report.added, report.duplicates, report.skipped],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Ingest one uploaded file into upload `upload_id`. Called from the HTTP
/// handler on a blocking thread.
pub fn ingest_upload(
    db: &DbState,
    data_dir: &Path,
    upload_id: i64,
    name: &str,
    bytes: &[u8],
) -> Result<IngestReport, String> {
    let mut report = IngestReport::default();
    let prepared = prepare_upload(&attachments_dir(data_dir), name, bytes, &mut report)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    insert_prepared(&conn, upload_id, prepared, &mut report)?;
    Ok(report)
}

/// Open a new upload record; files are then posted against its id.
pub fn begin_attachment_upload(
    state: State<'_, DbState>,
    source_name: Option<String>,
) -> Result<i64, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let source_name = source_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    conn.query_row(
        "INSERT INTO attachment_uploads (uploaded_at, source_name) VALUES (?1, ?2) RETURNING id",
        params![now_utc(), source_name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn list_attachment_uploads(state: State<'_, DbState>) -> Result<Vec<AttachmentUpload>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, uploaded_at, source_name, files_total, added, duplicates, skipped
             FROM attachment_uploads ORDER BY uploaded_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AttachmentUpload {
                id: r.get(0)?,
                uploaded_at: r.get(1)?,
                source_name: r.get(2)?,
                files_total: r.get(3)?,
                added: r.get(4)?,
                duplicates: r.get(5)?,
                skipped: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn list_attachments(state: State<'_, DbState>) -> Result<Vec<Attachment>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "{ATTACHMENT_SELECT}
             ORDER BY u.uploaded_at DESC, a.original_name COLLATE NOCASE ASC, a.id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], attachment_from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Delete a document row and its file. The upload record keeps its counters
/// — it is a log of what happened, not a live tally.
pub fn delete_attachment(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    delete_attachment_in(&conn, &crate::data_dir_context().data_dir, id)
}

fn delete_attachment_in(conn: &Connection, data_dir: &Path, id: i64) -> Result<(), String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "DELETE FROM attachments WHERE id = ?1 RETURNING sha256, mime_type",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((sha256, mime)) = row else {
        return Err(format!("attachment {id} does not exist"));
    };
    let path = attachments_dir(data_dir).join(stored_file_name(&sha256, &mime));
    // A missing file is not an error — the row is what the user sees.
    let _ = fs::remove_file(path);
    Ok(())
}

/// Resolve a document id to its MIME type and on-disk path (for serving).
pub fn attachment_file(db: &DbState, data_dir: &Path, id: i64) -> Result<(String, PathBuf), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let (sha256, mime): (String, String) = conn
        .query_row(
            "SELECT sha256, mime_type FROM attachments WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("attachment {id} does not exist"))?;
    let path = attachments_dir(data_dir).join(stored_file_name(&sha256, &mime));
    Ok((mime, path))
}

// ---------------------------------------------------------------------------
// Document time from the file name

/// When a document says it happened. Slips print local wall time without a
/// zone (`Local`); an epoch timestamp in a screenshot name is absolute (`Utc`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DocTime {
    Local(NaiveDateTime),
    Utc(DateTime<Utc>),
}

impl DocTime {
    /// `Local` → `2026-10-27T11:58:55`, `Utc` → `2025-02-04T08:23:22Z`.
    fn to_value(self) -> String {
        match self {
            DocTime::Local(t) => t.format("%Y-%m-%dT%H:%M:%S").to_string(),
            DocTime::Utc(t) => t.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        }
    }

    fn parse(value: &str) -> Option<DocTime> {
        if let Some(naive) = value.strip_suffix('Z') {
            return NaiveDateTime::parse_from_str(naive, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|t| DocTime::Utc(t.and_utc()));
        }
        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
            .ok()
            .map(DocTime::Local)
    }

    /// Absolute instant, interpreting local wall time in `offset`.
    fn to_utc(self, offset: FixedOffset) -> DateTime<Utc> {
        match self {
            DocTime::Utc(t) => t,
            DocTime::Local(t) => (t - Duration::seconds(offset.local_minus_utc() as i64)).and_utc(),
        }
    }
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Time encoded in a file name, tried from most to least specific:
/// 1. a bank transaction reference that embeds the time — K PLUS
///    `0 1 Y DDD HHMMSS <3 letters><5 digits>` or, in older slips,
///    `0 1 Y DDD HHMMSS <6 digits>` (one-digit year; the decade is taken from
///    `ref_year`, the year the file was uploaded);
/// 2. a calendar date-time — `20250823_114627`, `2025-08-23 at 11.46.27`,
///    `Screenshot_20250823-114627` (camera / screenshot names);
/// 3. a 13-digit epoch-milliseconds stamp — `BBl-Screenshot-1738657402211`.
pub fn time_from_file_name(name: &str, ref_year: i32) -> Option<DocTime> {
    static KPLUS: OnceLock<Regex> = OnceLock::new();
    static CALENDAR: OnceLock<Regex> = OnceLock::new();
    static EPOCH_MS: OnceLock<Regex> = OnceLock::new();
    let base = name.rsplit('/').next().unwrap_or(name);

    let kplus = regex(&KPLUS, r"(?:^|[^0-9])0\d(\d)(\d{3})(\d{2})(\d{2})(\d{2})(?:[A-Z]{3}\d{5}|\d{6}(?:[^0-9]|$))");
    let from_kplus = kplus.captures(base).and_then(|c| {
        let digit: i32 = c[1].parse().ok()?;
        // Latest year ≤ ref_year whose last digit matches.
        let mut year = ref_year - ref_year.rem_euclid(10) + digit;
        if year > ref_year {
            year -= 10;
        }
        let day: u32 = c[2].parse().ok()?;
        let (h, m, s): (u32, u32, u32) = (c[3].parse().ok()?, c[4].parse().ok()?, c[5].parse().ok()?);
        NaiveDate::from_yo_opt(year, day)?.and_hms_opt(h, m, s)
    });
    if let Some(t) = from_kplus {
        return Some(DocTime::Local(t));
    }

    let calendar = regex(
        &CALENDAR,
        r"(?:^|[^0-9])(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T-]+(?:at )?)(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?:[^0-9]|$)",
    );
    let from_calendar = calendar.captures(base).and_then(|c| {
        let n = |i: usize| c[i].parse::<u32>().ok();
        NaiveDate::from_ymd_opt(c[1].parse().ok()?, n(2)?, n(3)?)?.and_hms_opt(n(4)?, n(5)?, n(6)?)
    });
    if let Some(t) = from_calendar {
        return Some(DocTime::Local(t));
    }

    let epoch = regex(&EPOCH_MS, r"(?:^|[^0-9])(1[5-9]\d{11}|20\d{11})(?:[^0-9]|$)");
    if let Some(c) = epoch.captures(base) {
        let ms: i64 = c[1].parse().ok()?;
        return DateTime::from_timestamp_millis(ms).map(DocTime::Utc);
    }
    None
}

/// Initial `extraction` JSON for a freshly uploaded file, or `None` when the
/// name carries nothing.
fn filename_extraction(name: &str, ref_year: i32) -> Option<String> {
    let time = time_from_file_name(name, ref_year)?;
    Some(json!({ "occurredAt": { "value": time.to_value(), "source": "filename" } }).to_string())
}

/// The document time recorded in an `extraction` JSON, if any.
fn extraction_time(extraction: Option<&str>) -> Option<DocTime> {
    let v: Value = serde_json::from_str(extraction?).ok()?;
    DocTime::parse(v.get("occurredAt")?.get("value")?.as_str()?)
}

/// Fill the file-name time for documents that have no extraction yet (rows
/// uploaded before this extractor existed). Runs at startup; cheap.
pub fn backfill_filename_times(conn: &Connection) -> rusqlite::Result<usize> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.original_name, u.uploaded_at
             FROM attachments a JOIN attachment_uploads u ON u.id = a.upload_id
             WHERE a.extraction IS NULL",
        )?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        it.collect::<rusqlite::Result<_>>()?
    };
    let mut updated = 0;
    for (id, name, uploaded_at) in rows {
        let year = DateTime::parse_from_rfc3339(&uploaded_at)
            .map(|t| t.year())
            .unwrap_or_else(|_| Utc::now().year());
        if let Some(extraction) = filename_extraction(&name, year) {
            updated += conn.execute(
                "UPDATE attachments SET extraction = ?2 WHERE id = ?1",
                params![id, extraction],
            )?;
        }
    }
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Linking documents to transactions

/// A document offered for linking to a transaction, with its time distance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCandidate {
    pub attachment: Attachment,
    /// Document time minus transaction time, in seconds.
    pub delta_seconds: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCandidates {
    pub candidates: Vec<AttachmentCandidate>,
    /// Documents that have no known time yet (cannot be placed in a window).
    pub undated_count: i64,
}

/// transaction id ↔ document id, for the Transactions table column.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentLink {
    pub transaction_id: i64,
    pub attachment_id: i64,
    pub original_name: String,
    pub mime_type: String,
    /// The user's note recognised on the document, if any.
    pub memo: Option<String>,
}

const ATTACHMENT_SELECT: &str = "SELECT a.id, a.upload_id, u.uploaded_at, a.sha256, a.original_name,
            a.mime_type, a.size_bytes, a.extract_status, a.extraction, a.ocr_text,
            a.transaction_id, a.match_status
     FROM attachments a
     JOIN attachment_uploads u ON u.id = a.upload_id";

fn attachment_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: r.get(0)?,
        upload_id: r.get(1)?,
        uploaded_at: r.get(2)?,
        sha256: r.get(3)?,
        original_name: r.get(4)?,
        mime_type: r.get(5)?,
        size_bytes: r.get(6)?,
        extract_status: r.get(7)?,
        extraction: r.get(8)?,
        ocr_text: r.get(9)?,
        transaction_id: r.get(10)?,
        match_status: r.get(11)?,
    })
}

/// Link a document to a transaction by hand (re-linking moves it). A
/// transaction may carry several documents; a document belongs to at most
/// one transaction.
pub fn link_attachment(
    state: State<'_, DbState>,
    attachment_id: i64,
    transaction_id: i64,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    link_attachment_in(&conn, attachment_id, transaction_id)
}

fn link_attachment_in(conn: &Connection, attachment_id: i64, transaction_id: i64) -> Result<(), String> {
    let txn_exists: bool = conn
        .query_row("SELECT 1 FROM transactions WHERE id = ?1", [transaction_id], |_| Ok(true))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !txn_exists {
        return Err(format!("transaction {transaction_id} does not exist"));
    }
    let n = conn
        .execute(
            "UPDATE attachments SET transaction_id = ?2, match_status = 'manual' WHERE id = ?1",
            params![attachment_id, transaction_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("attachment {attachment_id} does not exist"));
    }
    Ok(())
}

/// Unlink a document; the status reset is done by the
/// `attachments_reset_match_on_unlink` trigger.
pub fn unlink_attachment(state: State<'_, DbState>, attachment_id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE attachments SET transaction_id = NULL WHERE id = ?1",
        [attachment_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_transaction_attachments(
    state: State<'_, DbState>,
    transaction_id: i64,
) -> Result<Vec<Attachment>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{ATTACHMENT_SELECT} WHERE a.transaction_id = ?1 ORDER BY a.id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([transaction_id], attachment_from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn list_attachment_links(state: State<'_, DbState>) -> Result<Vec<AttachmentLink>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT transaction_id, id, original_name, mime_type,
                    json_extract(extraction, '$.memo.value')
             FROM attachments
             WHERE transaction_id IS NOT NULL ORDER BY transaction_id, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AttachmentLink {
                transaction_id: r.get(0)?,
                attachment_id: r.get(1)?,
                original_name: r.get(2)?,
                mime_type: r.get(3)?,
                memo: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Documents whose time falls within ±`window_minutes` of the transaction,
/// nearest first — for picking the right slip by eye. Local (zone-less)
/// document times are read in the transaction's import-batch offset.
pub fn list_attachment_candidates(
    state: State<'_, DbState>,
    transaction_id: i64,
    window_minutes: i64,
) -> Result<AttachmentCandidates, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    attachment_candidates_in(&conn, transaction_id, window_minutes)
}

pub(crate) fn attachment_candidates_in(
    conn: &Connection,
    transaction_id: i64,
    window_minutes: i64,
) -> Result<AttachmentCandidates, String> {
    let (occurred, offset): (String, Option<String>) = conn
        .query_row(
            "SELECT t.occurred_at_utc,
                    COALESCE(b.timezone_offset,
                             (SELECT timezone_offset FROM import_batches
                              WHERE account_id = t.account_id ORDER BY id DESC LIMIT 1))
             FROM transactions t
             LEFT JOIN import_batches b ON b.id = t.import_batch_id
             WHERE t.id = ?1",
            [transaction_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("transaction {transaction_id} does not exist"))?;
    let txn_time = DateTime::parse_from_rfc3339(&occurred)
        .map_err(|e| format!("bad transaction time {occurred}: {e}"))?
        .with_timezone(&Utc);
    let offset = offset
        .and_then(|o| o.parse::<FixedOffset>().ok())
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero offset"));
    let window = window_minutes.clamp(1, 60 * 24 * 7) * 60;

    let mut stmt = conn.prepare(ATTACHMENT_SELECT).map_err(|e| e.to_string())?;
    let all = stmt
        .query_map([], attachment_from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut undated_count = 0;
    let mut candidates = Vec::new();
    for attachment in all {
        let Some(time) = extraction_time(attachment.extraction.as_deref()) else {
            undated_count += 1;
            continue;
        };
        let delta_seconds = (time.to_utc(offset) - txn_time).num_seconds();
        if delta_seconds.abs() <= window {
            candidates.push(AttachmentCandidate { attachment, delta_seconds });
        }
    }
    candidates.sort_by_key(|c| (c.delta_seconds.abs(), c.attachment.id));
    Ok(AttachmentCandidates { candidates, undated_count })
}

/// Names of stored files for the backup archive: only well-formed
/// content-addressed names, so stray temp files never travel along.
pub fn stored_files(data_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(attachments_dir(data_dir)) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_stored_file_name)
        })
        .collect();
    files.sort();
    files
}

/// `<64 hex>.<ext>` — the only names we ever write or accept from a backup.
pub fn is_stored_file_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    stem.len() == 64
        && stem.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && ["jpg", "png", "webp", "pdf"].contains(&ext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest-of-png";

    fn setup() -> (TempDir, DbState) {
        let dir = TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        (dir, Mutex::new(conn))
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            if name.ends_with('/') {
                zip.add_directory(*name, SimpleFileOptions::default()).unwrap();
            } else {
                zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                zip.write_all(data).unwrap();
            }
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn sniffs_by_content_not_extension() {
        assert_eq!(sniff_mime(JPEG), Some("image/jpeg"));
        assert_eq!(sniff_mime(PNG), Some("image/png"));
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_mime(b"%PDF-1.7"), Some("application/pdf"));
        assert_eq!(sniff_mime(b"{\"json\": true}"), None);
    }

    #[test]
    fn single_file_is_stored_and_counted() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, Some("slip.jpeg".into())).unwrap();
        let report = ingest_upload(&db, dir.path(), upload, "slip.jpeg", JPEG).unwrap();
        assert_eq!((report.files_total, report.added, report.duplicates, report.skipped), (1, 1, 0, 0));

        let docs = list_attachments(&db).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].mime_type, "image/jpeg");
        assert_eq!(docs[0].extract_status, "pending");
        let (_, path) = attachment_file(&db, dir.path(), docs[0].id).unwrap();
        assert_eq!(fs::read(path).unwrap(), JPEG);
    }

    #[test]
    fn png_named_jpeg_is_stored_as_png() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "BBl-Screenshot-1.jpeg", PNG).unwrap();
        let docs = list_attachments(&db).unwrap();
        assert_eq!(docs[0].mime_type, "image/png");
        assert_eq!(docs[0].original_name, "BBl-Screenshot-1.jpeg");
    }

    #[test]
    fn zip_is_unpacked_recursively_and_junk_skipped() {
        let (dir, db) = setup();
        let zip = zip_of(&[
            ("vvpreo/", b""),
            ("vvpreo/KSK/a.jpeg", JPEG),
            ("vvpreo/BBK/b.jpeg", PNG),
            ("vvpreo/KSK/a.jpeg.json", b"{}"),
            ("__MACOSX/vvpreo/._a.jpeg", b"junk"),
            ("vvpreo/.DS_Store", b"junk"),
        ]);
        let upload = begin_attachment_upload(&db, Some("drive.zip".into())).unwrap();
        let report = ingest_upload(&db, dir.path(), upload, "drive.zip", &zip).unwrap();
        // Folders, __MACOSX and dot-files are ignored entirely; the JSON
        // sidecar counts as a skipped file.
        assert_eq!((report.files_total, report.added, report.skipped), (3, 2, 1));
        assert_eq!(report.skipped_names.len(), 1);

        let uploads = list_attachment_uploads(&db).unwrap();
        assert_eq!(uploads[0].added, 2);
        assert_eq!(uploads[0].skipped, 1);
        assert_eq!(uploads[0].source_name.as_deref(), Some("drive.zip"));
    }

    #[test]
    fn duplicates_are_detected_by_content_across_uploads() {
        let (dir, db) = setup();
        let u1 = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), u1, "a.jpeg", JPEG).unwrap();
        // Same bytes under another name, inside a ZIP, in a later upload —
        // and twice within the same archive.
        let zip = zip_of(&[("x/renamed.jpg", JPEG), ("y/again.jpg", JPEG), ("b.png", PNG)]);
        let u2 = begin_attachment_upload(&db, None).unwrap();
        let report = ingest_upload(&db, dir.path(), u2, "z.zip", &zip).unwrap();
        assert_eq!((report.added, report.duplicates), (1, 2));
        assert_eq!(list_attachments(&db).unwrap().len(), 2);
    }

    #[test]
    fn nested_zip_and_unknown_files_are_skipped() {
        let (dir, db) = setup();
        let inner = zip_of(&[("a.jpeg", JPEG)]);
        let outer = zip_of(&[("inner.zip", &inner), ("notes.txt", b"hello")]);
        let upload = begin_attachment_upload(&db, None).unwrap();
        let report = ingest_upload(&db, dir.path(), upload, "outer.zip", &outer).unwrap();
        assert_eq!((report.files_total, report.added, report.skipped), (2, 0, 2));
    }

    #[test]
    fn unknown_upload_id_is_rejected() {
        let (dir, db) = setup();
        assert!(ingest_upload(&db, dir.path(), 999, "a.jpeg", JPEG).is_err());
    }

    #[test]
    fn delete_removes_row_and_file() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "a.jpeg", JPEG).unwrap();
        let id = list_attachments(&db).unwrap()[0].id;
        let (_, path) = attachment_file(&db, dir.path(), id).unwrap();
        assert!(path.exists());
        delete_attachment_in(&db.lock().unwrap(), dir.path(), id).unwrap();
        assert!(!path.exists());
        assert!(list_attachments(&db).unwrap().is_empty());
        // The upload log keeps its counters.
        assert_eq!(list_attachment_uploads(&db).unwrap()[0].added, 1);
    }

    #[test]
    fn deleting_a_transaction_unlinks_its_document() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "a.jpeg", JPEG).unwrap();
        let conn = db.lock().unwrap();
        let account: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number) VALUES ('B', 'THB', '1')
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, row_count, timezone_offset)
                 VALUES (?1, '2026-01-01T00:00:00Z', 1, '+07:00') RETURNING id",
                [account],
                |r| r.get(0),
            )
            .unwrap();
        let txn: i64 = conn
            .query_row(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-01-01T00:00:00Z', 0, 100, 0) RETURNING id",
                params![account, batch],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE attachments SET transaction_id = ?1, match_status = 'manual'",
            [txn],
        )
        .unwrap();
        conn.execute("DELETE FROM import_batches WHERE id = ?1", [batch]).unwrap();
        // The document survives, unlinked, and its status resets (trigger).
        let (linked, status): (Option<i64>, String) = conn
            .query_row("SELECT transaction_id, match_status FROM attachments", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(linked, None);
        assert_eq!(status, "unmatched");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn stored_file_names_are_strict() {
        let sha = "a".repeat(64);
        assert!(is_stored_file_name(&format!("{sha}.jpg")));
        assert!(!is_stored_file_name(&format!("{sha}.exe")));
        assert!(!is_stored_file_name("../etc/passwd"));
        assert!(!is_stored_file_name(&format!(".{sha}.part")));
        assert!(!is_stored_file_name(&format!("{}.jpg", "A".repeat(64))));
    }

    fn local(s: &str) -> DocTime {
        DocTime::Local(NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap())
    }

    #[test]
    fn file_name_times() {
        // K PLUS transaction reference: 2026, day 300 = 27 Oct, 11:58:55.
        assert_eq!(
            time_from_file_name("vvpreo/KSK/016300115855CPM09866.jpeg", 2026),
            Some(local("2026-10-27T11:58:55"))
        );
        // One-digit year: uploaded in 2026, digit 5 means 2025.
        assert_eq!(
            time_from_file_name("015035124315AQR09716.jpeg", 2026),
            Some(local("2025-02-04T12:43:15"))
        );
        // Older K PLUS reference: six digits instead of channel letters.
        assert_eq!(
            time_from_file_name("015074124709214540.jpeg", 2026),
            Some(local("2025-03-15T12:47:09"))
        );
        // Camera / screenshot style names.
        assert_eq!(
            time_from_file_name("004999119321015_20250823_114627.jpeg", 2026),
            Some(local("2025-08-23T11:46:27"))
        );
        assert_eq!(
            time_from_file_name("Screenshot 2025-08-23 at 11.46.27.png", 2026),
            Some(local("2025-08-23T11:46:27"))
        );
        // Epoch milliseconds (Bangkok Bank screenshot) is an absolute instant.
        assert_eq!(
            time_from_file_name("BBl-Screenshot-1738657402211.jpeg", 2026),
            Some(DocTime::Utc(DateTime::from_timestamp_millis(1738657402211).unwrap()))
        );
        assert_eq!(time_from_file_name("receipt.jpg", 2026), None);
        // A reference-shaped name with an impossible day falls through to
        // the next pattern instead of giving up.
        assert_eq!(
            time_from_file_name("016999115855CPM09866_20250823_114627.jpeg", 2026),
            Some(local("2025-08-23T11:46:27"))
        );
        // A long digit run (account number) is not an epoch.
        assert_eq!(time_from_file_name("12345678901234567.jpg", 2026), None);
    }

    #[test]
    fn doc_time_round_trips_through_extraction_json() {
        for t in [
            local("2026-10-27T11:58:55"),
            DocTime::Utc(DateTime::from_timestamp_millis(1738657402000).unwrap()),
        ] {
            let json = json!({ "occurredAt": { "value": t.to_value(), "source": "filename" } });
            assert_eq!(extraction_time(Some(&json.to_string())), Some(t));
        }
    }

    /// One account with a +07:00 batch and a transaction at 11:58 local
    /// (04:58 UTC); returns its id.
    fn insert_txn(conn: &Connection) -> i64 {
        let account: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number) VALUES ('K', 'THB', '8136')
                 RETURNING id",
                [],
                |r| r.get(0),
            )
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
    }

    #[test]
    fn candidates_are_found_by_time_in_the_batch_offset() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        // 11:58:55 local (+07:00) — 55 s after the transaction.
        ingest_upload(&db, dir.path(), upload, "016300115855CPM09866.jpeg", JPEG).unwrap();
        // 12:10 local — 12 minutes away.
        ingest_upload(&db, dir.path(), upload, "016300121000CPM00001.jpeg", PNG).unwrap();
        // No time at all.
        ingest_upload(&db, dir.path(), upload, "receipt.pdf", b"%PDF-1.4").unwrap();
        let conn = db.lock().unwrap();
        let txn = insert_txn(&conn);

        let found = attachment_candidates_in(&conn, txn, 5).unwrap();
        assert_eq!(found.candidates.len(), 1);
        assert_eq!(found.candidates[0].delta_seconds, 55);
        assert_eq!(found.candidates[0].attachment.original_name, "016300115855CPM09866.jpeg");
        assert_eq!(found.undated_count, 1);

        let wider = attachment_candidates_in(&conn, txn, 15).unwrap();
        assert_eq!(wider.candidates.len(), 2);
        assert_eq!(wider.candidates[1].delta_seconds, 12 * 60);
    }

    #[test]
    fn link_and_unlink() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "a.jpeg", JPEG).unwrap();
        let doc = list_attachments(&db).unwrap()[0].id;
        let txn = insert_txn(&db.lock().unwrap());

        assert!(link_attachment(&db, doc, 9999).is_err());
        link_attachment(&db, doc, txn).unwrap();
        let linked = list_transaction_attachments(&db, txn).unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].match_status, "manual");
        assert_eq!(list_attachment_links(&db).unwrap()[0].transaction_id, txn);

        unlink_attachment(&db, doc).unwrap();
        assert!(list_transaction_attachments(&db, txn).unwrap().is_empty());
        assert_eq!(list_attachments(&db).unwrap()[0].match_status, "unmatched");
    }

    #[test]
    fn deleting_a_linked_document_keeps_the_transaction() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "a.jpeg", JPEG).unwrap();
        let doc = list_attachments(&db).unwrap()[0].id;
        let txn = insert_txn(&db.lock().unwrap());
        link_attachment(&db, doc, txn).unwrap();

        delete_attachment_in(&db.lock().unwrap(), dir.path(), doc).unwrap();
        let conn = db.lock().unwrap();
        let still_there: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE id = ?1", [txn], |r| r.get(0))
            .unwrap();
        assert_eq!(still_there, 1);
    }

    #[test]
    fn backfill_fills_only_missing_extractions() {
        let (dir, db) = setup();
        let upload = begin_attachment_upload(&db, None).unwrap();
        ingest_upload(&db, dir.path(), upload, "016300115855CPM09866.jpeg", JPEG).unwrap();
        let conn = db.lock().unwrap();
        conn.execute("UPDATE attachments SET extraction = NULL", []).unwrap();
        assert_eq!(backfill_filename_times(&conn).unwrap(), 1);
        assert_eq!(backfill_filename_times(&conn).unwrap(), 0);
        let extraction: String = conn
            .query_row("SELECT extraction FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert!(extraction.contains("2026-10-27T11:58:55"));
    }
}
