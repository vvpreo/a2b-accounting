-- Document storage (bank slips, receipts, …). Files live on disk under
-- $FINANCES_DATA_DIR/attachments/<sha256>.<ext>; these tables hold metadata.

-- One row per upload action in the UI (a batch of files or a ZIP), so the
-- user can see when documents were last uploaded and spot gaps.
CREATE TABLE attachment_uploads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uploaded_at TEXT    NOT NULL,
    source_name TEXT,
    files_total INTEGER NOT NULL DEFAULT 0,
    added       INTEGER NOT NULL DEFAULT 0,
    duplicates  INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0
);

-- Statuses are free-form TEXT on purpose (no CHECK): the recognition
-- pipeline is expected to grow new states, and SQLite cannot alter a CHECK
-- without rebuilding the table.
--   extract_status: pending | done | partial | failed | not_document
--   match_status:   unmatched | auto | probable | manual | ambiguous
-- `extraction` is the recognition result as JSON (per-field value + source),
-- `ocr_text` the raw recognised text kept for troubleshooting.
CREATE TABLE attachments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id      INTEGER NOT NULL REFERENCES attachment_uploads(id) ON DELETE CASCADE,
    sha256         TEXT    NOT NULL UNIQUE,
    original_name  TEXT    NOT NULL,
    mime_type      TEXT    NOT NULL,
    size_bytes     INTEGER NOT NULL,
    extract_status TEXT    NOT NULL DEFAULT 'pending',
    extraction     TEXT,
    ocr_text       TEXT,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    match_status   TEXT    NOT NULL DEFAULT 'unmatched'
);

CREATE INDEX idx_attachments_upload ON attachments(upload_id);
CREATE INDEX idx_attachments_transaction ON attachments(transaction_id);
