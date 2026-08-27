//! Database backup and restore for the web build.
//!
//! Backup streams the DB to the browser as a ZIP download; restore accepts an
//! uploaded ZIP, validates it, installs it and reopens the DB connection
//! in-process (the frontend then reloads the page). There is no runtime
//! data-directory switching any more — the directory is fixed for the process
//! lifetime via `FINANCES_DATA_DIR` (Docker volume) or the platform default.

use std::fs;
use std::io::Cursor;
use std::path::Path;

use chrono::Utc;
use rusqlite::Connection;
use serde::Serialize;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::db::DbState;
use crate::host::AppHandle;
use crate::{data_dir_context, DataDirSource};

const DB_FILENAME: &str = "finances.db";

/// Public-facing snapshot of where the DB lives and how that path was
/// decided. Returned by `data_dir_info` so the Settings page can display the
/// current path. `default_path` is kept for frontend-type compatibility and
/// always mirrors `path` in the web build.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub path: String,
    pub default_path: String,
    pub source: &'static str,
    pub env_override: bool,
}

pub fn data_dir_info() -> DataDirInfo {
    let ctx = data_dir_context();
    let path = ctx.data_dir.to_string_lossy().into_owned();
    DataDirInfo {
        default_path: path.clone(),
        path,
        source: match ctx.source {
            DataDirSource::Default => "default",
            DataDirSource::Env => "env",
        },
        env_override: matches!(ctx.source, DataDirSource::Env),
    }
}

/// Build a single-entry ZIP containing `finances.db`, in memory. Before
/// reading the source DB we issue a WAL checkpoint so the latest commits are
/// merged into the main file — otherwise the resulting backup could be
/// missing recent writes that still sit in the WAL. The DbState lock is held
/// across checkpoint + read so no other command sneaks in between.
pub fn backup_zip_bytes(db_state: &DbState) -> Result<Vec<u8>, String> {
    let dir = data_dir_context().data_dir.clone();
    let db_path = dir.join(DB_FILENAME);
    if !db_path.exists() {
        return Err("backup.no_db".into());
    }

    let conn = db_state
        .lock()
        .map_err(|e| format!("backup.lock_poisoned: {e}"))?;
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
        .map_err(|e| format!("backup.wal_checkpoint: {e}"))?;

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(DB_FILENAME, options)
        .map_err(|e| format!("backup.zip_entry: {e}"))?;
    let mut src = fs::File::open(&db_path).map_err(|e| format!("backup.open_db: {e}"))?;
    std::io::copy(&mut src, &mut zip).map_err(|e| format!("backup.write_zip: {e}"))?;
    let cursor = zip.finish().map_err(|e| format!("backup.finish_zip: {e}"))?;
    Ok(cursor.into_inner())
}

/// Restore the DB from an uploaded ZIP. Validates the archive first (must
/// contain `finances.db` that opens as a valid SQLite with our
/// `schema_migrations` table), auto-renames the current DB to
/// `finances.db.bak-<utc-timestamp>`, installs the new file and reopens the
/// in-process connection so the app keeps working without a restart.
pub fn restore_from_zip_bytes(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    let dir = data_dir_context().data_dir.clone();
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("restore.read_zip: {e}"))?;

    let candidate = dir.join("finances.db.restore-candidate");
    // Stale candidate from a previous interrupted attempt — clean it up.
    let _ = fs::remove_file(&candidate);

    {
        let mut entry = archive
            .by_name(DB_FILENAME)
            .map_err(|_| "restore.missing_db_in_zip".to_string())?;
        let mut out = fs::File::create(&candidate)
            .map_err(|e| format!("restore.create_candidate: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("restore.extract: {e}"))?;
    }

    // Validate: must be a SQLite file with our migrations table. The version
    // check is intentionally loose — migrations catch up on reopen.
    if let Err(e) = validate_candidate(&candidate) {
        let _ = fs::remove_file(&candidate);
        return Err(e);
    }

    let mut guard = app
        .db()
        .lock()
        .map_err(|e| format!("restore.lock_poisoned: {e}"))?;
    // Flush the current WAL so the .bak file is self-contained.
    let _ = guard.pragma_update(None, "wal_checkpoint", "TRUNCATE");
    // Close the live connection by swapping in a throwaway in-memory one —
    // the file swap below must not race an open handle.
    let placeholder =
        Connection::open_in_memory().map_err(|e| format!("restore.placeholder: {e}"))?;
    drop(std::mem::replace(&mut *guard, placeholder));

    let install_result = install_candidate(&dir, &candidate);

    // Whatever happened above, reopen the DB now on disk so the app stays
    // usable; an install error still wins the error report.
    match crate::open_and_init(&dir) {
        Ok(conn) => *guard = conn,
        Err(reopen_err) => {
            return Err(install_result
                .err()
                .unwrap_or_else(|| format!("restore.reopen: {reopen_err}")));
        }
    }
    install_result
}

fn install_candidate(dir: &Path, candidate: &Path) -> Result<(), String> {
    // Back up the current DB before clobbering. UTC timestamp so two restores
    // in quick succession don't collide.
    let cur = dir.join(DB_FILENAME);
    if cur.exists() {
        let ts = Utc::now().format("%Y%m%dT%H%M%SZ");
        let bak = dir.join(format!("finances.db.bak-{ts}"));
        fs::rename(&cur, &bak).map_err(|e| format!("restore.backup_current: {e}"))?;
    }

    // The old WAL/SHM belong to the previous DB and would corrupt the new
    // one if we left them. Safe to remove — the current DB file has been
    // moved aside (or never existed).
    let _ = fs::remove_file(dir.join("finances.db-wal"));
    let _ = fs::remove_file(dir.join("finances.db-shm"));

    fs::rename(candidate, &cur).map_err(|e| format!("restore.install_candidate: {e}"))
}

fn validate_candidate(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| format!("restore.invalid_sqlite: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::TempDir;

    /// End-to-end test of validate_candidate using a real SQLite file with
    /// our schema applied — establishes that a freshly-opened DB satisfies
    /// the restore-side check.
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

    /// Round-trip the ZIP layer: write a DB to an in-memory zip the same way
    /// `backup_zip_bytes` does, extract it back, and confirm both sides match
    /// byte-for-byte.
    #[test]
    fn zip_round_trip_preserves_db_contents() {
        let dir = TempDir::new().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        drop(conn);
        let src = dir.path().join("finances.db");
        let original = fs::read(&src).unwrap();

        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("finances.db", options).unwrap();
        std::io::copy(&mut fs::File::open(&src).unwrap(), &mut zip).unwrap();
        let bytes = zip.finish().unwrap().into_inner();

        let mut archive = ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();
        let mut entry = archive.by_name("finances.db").unwrap();
        let mut extracted = Vec::new();
        entry.read_to_end(&mut extracted).unwrap();
        assert_eq!(extracted, original);
    }
}
