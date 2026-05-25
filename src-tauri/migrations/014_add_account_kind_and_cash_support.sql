-- Add an `accounts.kind` column so we can distinguish "bank" (imported via
-- statements, balance authoritative) from "cash" (manually entered, balance
-- auto-computed as a running sum). Loosen the schema accordingly:
--   * accounts.account_number / owner_name become nullable (cash has neither);
--   * the UNIQUE(bank, account_number) constraint is replaced by a *partial*
--     unique index that only applies to bank accounts — otherwise multiple
--     cash accounts under the synthetic "Cash" bank with NULL account_number
--     would clash;
--   * transactions.import_batch_id becomes nullable so manually-entered cash
--     transactions can exist without belonging to any import batch.
-- SQLite cannot drop a NOT NULL or UNIQUE constraint via ALTER, so both
-- tables are rebuilt in-place. Done in one transaction by the migration runner.

-- --- accounts ---------------------------------------------------------------

CREATE TABLE accounts_new (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank', 'cash')),
    bank           TEXT NOT NULL,
    currency       TEXT NOT NULL,
    account_number TEXT,
    owner_name     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO accounts_new (id, name, kind, bank, currency, account_number, owner_name, created_at)
SELECT id,
       name,
       'bank',
       bank,
       currency,
       NULLIF(account_number, ''),
       NULLIF(owner_name, ''),
       created_at
  FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- UNIQUE was previously a table-level constraint on (bank, account_number).
-- Replace with a partial unique index scoped to bank accounts with a real
-- account number. Cash accounts (and any future kind without a number) are
-- exempt and can coexist freely.
CREATE UNIQUE INDEX accounts_bank_acctno_uniq
    ON accounts(bank, account_number)
    WHERE kind = 'bank' AND account_number IS NOT NULL;

-- --- transactions -----------------------------------------------------------

DROP INDEX IF EXISTS idx_txn_account_time;
DROP INDEX IF EXISTS idx_txn_batch;

CREATE TABLE transactions_new (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_batch_id   INTEGER          REFERENCES import_batches(id) ON DELETE CASCADE,
    occurred_at_utc   TEXT    NOT NULL,
    credit            INTEGER NOT NULL DEFAULT 0,
    debit             INTEGER NOT NULL DEFAULT 0,
    balance           INTEGER NOT NULL,
    peer              TEXT,
    bank_description  TEXT,
    comment           TEXT,
    is_correcting     INTEGER NOT NULL DEFAULT 0,
    CHECK (credit >= 0),
    CHECK (debit  >= 0),
    CHECK (credit = 0 OR debit = 0)
);

INSERT INTO transactions_new
    (id, account_id, import_batch_id, occurred_at_utc, credit, debit, balance,
     peer, bank_description, comment, is_correcting)
SELECT id, account_id, import_batch_id, occurred_at_utc, credit, debit, balance,
       peer, bank_description, comment, is_correcting
  FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_txn_account_time ON transactions(account_id, occurred_at_utc, id);
CREATE INDEX idx_txn_batch ON transactions(import_batch_id);
