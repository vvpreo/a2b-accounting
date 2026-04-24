CREATE TABLE accounts (
    id             INTEGER PRIMARY KEY,
    bank           TEXT NOT NULL,
    currency       TEXT NOT NULL,
    account_number TEXT NOT NULL,
    owner_name     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(bank, account_number)
);

CREATE TABLE import_batches (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    imported_at     TEXT NOT NULL,
    source_filename TEXT,
    row_count       INTEGER NOT NULL
);
CREATE INDEX idx_batches_account ON import_batches(account_id);

CREATE TABLE transactions (
    id               INTEGER PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_batch_id  INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    occurred_at_utc  TEXT    NOT NULL,
    occurred_at_tz   TEXT    NOT NULL,
    credit           INTEGER NOT NULL DEFAULT 0,
    debit            INTEGER NOT NULL DEFAULT 0,
    balance          INTEGER NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    CHECK (credit >= 0),
    CHECK (debit  >= 0),
    CHECK (credit = 0 OR debit = 0)
);
CREATE INDEX idx_txn_account_time ON transactions(account_id, occurred_at_utc, id);
CREATE INDEX idx_txn_batch ON transactions(import_batch_id);
