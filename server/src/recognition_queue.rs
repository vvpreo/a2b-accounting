//! Background recognition queue. Documents are recognised one at a time
//! (PaddleOCR already uses every core for one image) right after upload,
//! newest upload first. As soon as an upload is fully recognised — and
//! whenever the queue runs dry — recognised documents are linked to
//! transactions ([`document_analysis::auto_link_documents`]).
//!
//! The queue is the `extract_status = 'pending'` rows themselves, so it
//! survives restarts. [`wake`] nudges the worker after an upload, a finished
//! upload or a statement import (new transactions may fit waiting slips). An
//! environment problem (`ocr.unavailable` — missing models, LLM endpoint
//! down) pauses the queue until the next wake; the error is shown on the
//! Documents screen.
//!
//! The user can also pause the queue (Documents → Pause): the document being
//! recognised is finished, then nothing more is picked — not even the linking
//! pass — until Resume. The flag lives in `app_settings`, so a restart does
//! not silently resume.

use std::sync::Mutex;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tokio::sync::Notify;

use crate::db::DbState;
use crate::document_analysis::{self, LinkSummary};
use crate::host::{AppHandle, State};

pub const STATUS_EVENT: &str = "recognition-status";
/// `app_settings` key of the user's pause; `"true"` while paused.
const PAUSED_BY_USER_KEY: &str = "recognition.paused_by_user";

static WAKE: Notify = Notify::const_new();
/// Why the queue is paused, if it is.
static PAUSED: Mutex<Option<String>> = Mutex::new(None);
/// The latest linking pass that linked something.
static LAST_LINK: Mutex<Option<LinkSummary>> = Mutex::new(None);

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionStatus {
    /// Documents waiting for recognition.
    pub pending: i64,
    /// Documents automatic linking left for the user (several candidates).
    pub ambiguous: i64,
    pub paused_error: Option<String>,
    /// The user paused the queue (Documents → Pause).
    pub paused_by_user: bool,
    pub last_link: Option<LinkSummary>,
}

/// Nudge the worker; cheap, never blocks. A wake with nobody waiting is kept
/// for the next wait, so none is lost.
pub fn wake() {
    WAKE.notify_one();
}

pub fn spawn(app: AppHandle) {
    tokio::spawn(async move {
        loop {
            loop {
                match step(&app).await {
                    Ok(true) => continue,
                    Ok(false) => break,
                    Err(e) => {
                        eprintln!("recognition queue paused: {e}");
                        *PAUSED.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                        emit_status(&app);
                        break;
                    }
                }
            }
            WAKE.notified().await;
        }
    });
}

/// Recognise the next pending document; `false` when none is left (after a
/// final linking pass). `Err` only for environment problems.
async fn step(app: &AppHandle) -> Result<bool, String> {
    let next: Option<(i64, i64)> = {
        let conn = app.db().lock().map_err(|e| e.to_string())?;
        // Checked before picking the next document: the one in flight (if
        // any) has already finished by now.
        if is_paused_by_user(&conn) {
            return Ok(false);
        }
        conn.query_row(
            "SELECT id, upload_id FROM attachments WHERE extract_status = 'pending'
             ORDER BY upload_id DESC, id LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    let Some((id, upload_id)) = next else {
        link_pass(app)?;
        return Ok(false);
    };
    *PAUSED.lock().unwrap_or_else(|p| p.into_inner()) = None;

    let data_dir = crate::data_dir_context().data_dir.clone();
    let worker = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        document_analysis::recognise_attachment(worker.db(), &data_dir, id, false)
    })
    .await
    .unwrap_or_else(|e| Err(format!("analysis.panicked: {e}")));
    match result {
        Ok(()) => {}
        Err(e) if e.starts_with("ocr.unavailable") => return Err(e),
        // A problem with this document (its file is gone, the decoder
        // panicked): record it so the queue does not retry it forever.
        Err(e) => mark_failed(app.db(), id, &e)?,
    }

    let upload_done = {
        let conn = app.db().lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT NOT EXISTS (SELECT 1 FROM attachments
                                WHERE upload_id = ?1 AND extract_status = 'pending')",
            [upload_id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    };
    if upload_done {
        link_pass(app)?;
    } else {
        emit_status(app);
    }
    Ok(true)
}

fn is_paused_by_user(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [PAUSED_BY_USER_KEY],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|v| v == "true")
}

/// Pause (finish the current document, then stop) or resume the queue.
pub fn set_recognition_paused(
    app: AppHandle,
    state: State<'_, DbState>,
    paused: bool,
) -> Result<RecognitionStatus, String> {
    {
        let conn = state.lock().map_err(|e| e.to_string())?;
        if paused {
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, 'true')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [PAUSED_BY_USER_KEY],
            )
        } else {
            conn.execute("DELETE FROM app_settings WHERE key = ?1", [PAUSED_BY_USER_KEY])
        }
        .map_err(|e| e.to_string())?;
    }
    if !paused {
        wake();
    }
    emit_status(&app);
    recognition_status(state)
}

fn mark_failed(db: &DbState, id: i64, error: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE attachments
         SET extract_status = 'failed',
             extraction = json_set(COALESCE(extraction, '{}'), '$.error', ?2)
         WHERE id = ?1 AND extract_status = 'pending'",
        params![id, error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn link_pass(app: &AppHandle) -> Result<(), String> {
    let summary = {
        let conn = app.db().lock().map_err(|e| e.to_string())?;
        document_analysis::auto_link_documents(&conn)?
    };
    if summary.linked > 0 {
        *LAST_LINK.lock().unwrap_or_else(|p| p.into_inner()) = Some(summary);
    }
    emit_status(app);
    Ok(())
}

fn emit_status(app: &AppHandle) {
    if let Ok(status) = recognition_status(app.db()) {
        let _ = app.emit(STATUS_EVENT, status);
    }
}

pub fn recognition_status(state: State<'_, DbState>) -> Result<RecognitionStatus, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let (pending, ambiguous): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(extract_status = 'pending'), 0),
                    COALESCE(SUM(transaction_id IS NULL AND match_status = 'ambiguous'), 0)
             FROM attachments",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(RecognitionStatus {
        pending,
        ambiguous,
        paused_error: PAUSED.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        paused_by_user: is_paused_by_user(&conn),
        last_link: LAST_LINK.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    })
}
