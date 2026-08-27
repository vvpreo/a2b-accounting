-- Reshape `transactions`:
--   * `description` -> `bank_description` (free-form line from the bank export, nullable)
--   * add `comment` (user-authored note, nullable)
--   * `peer` becomes nullable
-- SQLite cannot drop a NOT NULL constraint via ALTER, so the table is recreated.
-- Confirmed safe: no production data exists yet.

DELETE FROM transactions;
DELETE FROM import_batches;

DROP INDEX IF EXISTS idx_txn_account_time;
DROP INDEX IF EXISTS idx_txn_batch;
DROP TABLE transactions;

CREATE TABLE transactions (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_batch_id   INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    occurred_at_utc   TEXT    NOT NULL,
    credit            INTEGER NOT NULL DEFAULT 0,
    debit             INTEGER NOT NULL DEFAULT 0,
    balance           INTEGER NOT NULL,
    peer              TEXT,
    bank_description  TEXT,
    comment           TEXT,
    CHECK (credit >= 0),
    CHECK (debit  >= 0),
    CHECK (credit = 0 OR debit = 0)
);
CREATE INDEX idx_txn_account_time ON transactions(account_id, occurred_at_utc, id);
CREATE INDEX idx_txn_batch ON transactions(import_batch_id);
