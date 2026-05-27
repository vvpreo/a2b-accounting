//! Database backup, restore and runtime data-directory switching.
//!
//! All three commands share the same coarse-grained model: the DB connection
//! is reopened only after the user explicitly confirms and the app restarts.
//! That keeps file-level operations (copy / replace / move) safe — there's
//! no other writer touching the data dir while we work.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};
use zip::{
    write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter,
};

use crate::db::DbState;
use crate::{data_dir_context, DataDirSource, DATA_DIR_POINTER_FILE};

const DB_FILENAME: &str = "finances.db";

/// Public-facing snapshot of where the DB currently lives and how that path
/// was decided. Returned by `data_dir_info` so the Settings page can show
/// the current path and decide whether the "change directory" UI should be
/// active (env override locks it out).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub path: String,
    pub default_path: String,
    pub source: &'static str,
    pub env_override: bool,
}

#[tauri::command]
pub fn data_dir_info() -> DataDirInfo {
    let ctx = data_dir_context();
    DataDirInfo {
        path: ctx.data_dir.to_string_lossy().into_owned(),
        default_path: ctx.appdata_default.to_string_lossy().into_owned(),
        source: match ctx.source {
            DataDirSource::Default => "default",
            DataDirSource::Env => "env",
            DataDirSource::Pointer => "pointer",
        },
        env_override: matches!(ctx.source, DataDirSource::Env),
    }
}

/// Pointer-file location: always the platform-default appdata directory.
/// Independent of where the actual DB lives — that's the whole point of a
/// pointer.
pub fn pointer_path(appdata_default: &Path) -> PathBuf {
    appdata_default.join(DATA_DIR_POINTER_FILE)
}

#[tauri::command]
pub fn set_data_dir(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("set_data_dir.empty_path".into());
    }
    let new_path = PathBuf::from(trimmed);
    if !new_path.is_absolute() {
        return Err("set_data_dir.not_absolute".into());
    }

    let ctx = data_dir_context();
    if matches!(ctx.source, DataDirSource::Env) {
        return Err("set_data_dir.env_override".into());
    }

    // Same path → nothing to do. We treat this as success so the UI doesn't
    // have to disambiguate.
    if new_path == ctx.data_dir {
        return Ok(());
    }

    // Make sure the destination can be created. We don't *create* the DB
    // here — on restart, `db::open` will handle either an existing DB or a
    // fresh empty directory (which it'll initialise with migrations).
    fs::create_dir_all(&new_path)
        .map_err(|e| format!("set_data_dir.create_dir: {e}"))?;

    let pointer = pointer_path(&ctx.appdata_default);
    // Pointer always lives in the platform-default location, even if the
    // user is switching *away* from it. Write atomically (write to .tmp
    // then rename) so a crash mid-write can't leave a half-corrupt file.
    let tmp = pointer.with_extension("txt.tmp");
    fs::write(&tmp, new_path.to_string_lossy().as_bytes())
        .map_err(|e| format!("set_data_dir.write_pointer: {e}"))?;
    fs::rename(&tmp, &pointer)
        .map_err(|e| format!("set_data_dir.commit_pointer: {e}"))?;
    Ok(())
}

/// Clear the pointer file, returning to the platform-default data dir on
/// next launch. No-op (and Ok) if the pointer doesn't exist.
#[tauri::command]
pub fn reset_data_dir() -> Result<(), String> {
    let ctx = data_dir_context();
    if matches!(ctx.source, DataDirSource::Env) {
        return Err("set_data_dir.env_override".into());
    }
    let pointer = pointer_path(&ctx.appdata_default);
    match fs::remove_file(&pointer) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("reset_data_dir: {e}")),
    }
}

/// Writes a single-entry ZIP containing `finances.db`. Before reading the
/// source DB we issue a WAL checkpoint so the latest commits are merged
/// into the main file — otherwise the resulting backup could be missing
/// recent writes that still sit in the WAL.
#[tauri::command]
pub fn backup_to_zip(
    zip_path: String,
    db_state: State<DbState>,
) -> Result<(), String> {
    let dir = data_dir_context().data_dir.clone();
    let db_path = dir.join(DB_FILENAME);
    if !db_path.exists() {
        return Err("backup.no_db".into());
    }

    // TRUNCATE merges WAL into the main file and shrinks it to zero. We
    // hold the DbState lock across the call so no other command sneaks in
    // between checkpoint and file read.
    {
        let conn = db_state
            .lock()
            .map_err(|e| format!("backup.lock_poisoned: {e}"))?;
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .map_err(|e| format!("backup.wal_checkpoint: {e}"))?;
    }

    let zip_path_buf = PathBuf::from(&zip_path);
    if let Some(parent) = zip_path_buf.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("backup.create_parent: {e}"))?;
    }

    let file = fs::File::create(&zip_path_buf)
        .map_err(|e| format!("backup.create_zip: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(DB_FILENAME, options)
        .map_err(|e| format!("backup.zip_entry: {e}"))?;

    let mut src = fs::File::open(&db_path)
        .map_err(|e| format!("backup.open_db: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = src
            .read(&mut buf)
            .map_err(|e| format!("backup.read_db: {e}"))?;
        if n == 0 {
            break;
        }
        zip.write_all(&buf[..n])
            .map_err(|e| format!("backup.write_zip: {e}"))?;
    }
    zip.finish()
        .map_err(|e| format!("backup.finish_zip: {e}"))?;
    Ok(())
}

/// Restore the DB from a previously-created ZIP. Validates the archive
/// first (must contain `finances.db` that opens as a valid SQLite with our
/// `schema_migrations` table), then auto-renames the current DB to
/// `finances.db.bak-<utc-timestamp>` before installing the new file. The
/// caller is expected to restart the app right after; we deliberately do
/// not reopen the DB in-process to keep this operation atomic from the
/// perspective of the running app.
#[tauri::command]
pub fn restore_from_zip(zip_path: String) -> Result<(), String> {
    let dir = data_dir_context().data_dir.clone();
    let file = fs::File::open(&zip_path)
        .map_err(|e| format!("restore.open_zip: {e}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("restore.read_zip: {e}"))?;

    let candidate = dir.join("finances.db.restore-candidate");
    // Stale candidate from a previous interrupted attempt — clean it up
    // before writing a fresh one, otherwise create() would just truncate
    // it and we'd lose nothing real, but explicit removal makes the
    // intent clearer.
    let _ = fs::remove_file(&candidate);

    {
        let mut entry = archive
            .by_name(DB_FILENAME)
            .map_err(|_| "restore.missing_db_in_zip".to_string())?;
        let mut out = fs::File::create(&candidate)
            .map_err(|e| format!("restore.create_candidate: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("restore.extract: {e}"))?;
    }

    // Validate: must be a SQLite file with our migrations table. The
    // version check is intentionally loose — we accept any version of the
    // schema; migrations will catch up on next open.
    let validation = validate_candidate(&candidate);
    if let Err(e) = validation {
        let _ = fs::remove_file(&candidate);
        return Err(e);
    }

    // Back up the current DB before clobbering. Use a UTC timestamp so two
    // restores in quick succession don't collide.
    let cur = dir.join(DB_FILENAME);
    if cur.exists() {
        let ts = Utc::now().format("%Y%m%dT%H%M%SZ");
        let bak = dir.join(format!("finances.db.bak-{ts}"));
        fs::rename(&cur, &bak)
            .map_err(|e| format!("restore.backup_current: {e}"))?;
    }

    // The old WAL/SHM belong to the previous DB and would corrupt the new
    // one if we left them. Safe to remove — by this point the current DB
    // file has been moved aside (or never existed).
    let _ = fs::remove_file(dir.join("finances.db-wal"));
    let _ = fs::remove_file(dir.join("finances.db-shm"));

    fs::rename(&candidate, &cur)
        .map_err(|e| format!("restore.install_candidate: {e}"))?;
    Ok(())
}

fn validate_candidate(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path)
        .map_err(|e| format!("restore.invalid_sqlite: {e}"))?;
    // Quick smoke test: should have schema_migrations populated. We don't
    // demand a specific version — older / newer archives are fine, the
    // normal migration runner will fix them up on next open.
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !has_table {
        return Err("restore.no_schema_migrations".into());
    }
    Ok(())
}

#[tauri::command]
pub fn restart_app(app_handle: AppHandle) {
    app_handle.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// End-to-end test of validate_candidate using a real SQLite file with
    /// our schema applied — establishes that a freshly-opened DB satisfies
    /// the restore-side check without touching tauri internals.
    #[test]
    fn validate_candidate_accepts_real_db() {
        let dir = TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        drop(conn);
        let db_path = dir.path().join("finances.db");
        assert!(validate_candidate(&db_path).is_ok());
    }

    #[test]
    fn validate_candidate_rejects_random_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("garbage.db");
        fs::write(&path, b"not a sqlite file").unwrap();
        assert!(validate_candidate(&path).is_err());
    }

    /// A SQLite file that opens fine but doesn't have our schema must not
    /// be accepted — restoring it would leave the app in a state where
    /// every command immediately errors out.
    #[test]
    fn validate_candidate_rejects_empty_sqlite() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        drop(conn);
        assert!(validate_candidate(&path).is_err());
    }

    /// Round-trip the ZIP layer: write a DB to zip, extract it back, and
    /// confirm both sides match byte-for-byte. Uses the same SimpleFileOptions
    /// as the production path so any API drift in the `zip` crate would
    /// be caught here.
    #[test]
    fn zip_round_trip_preserves_db_contents() {
        let dir = TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        drop(conn);
        let src = dir.path().join("finances.db");
        let original = fs::read(&src).unwrap();

        let zip_path = dir.path().join("backup.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated);
        zip.start_file("finances.db", options).unwrap();
        zip.write_all(&original).unwrap();
        zip.finish().unwrap();

        let mut archive = ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
        let mut entry = archive.by_name("finances.db").unwrap();
        let mut extracted = Vec::new();
        entry.read_to_end(&mut extracted).unwrap();
        assert_eq!(extracted, original);
    }
}

