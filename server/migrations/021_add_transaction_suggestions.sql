-- Suggestions on what to do with a transaction: put it into a category, link
-- it with a transfer partner on another own bank account, or turn it into a
-- withdrawal to a cash account. Nothing here touches categories or links by
-- itself — a suggestion is applied only by an explicit user action.
--
-- One row per (transaction, kind); recomputing replaces it. A transfer pair
-- is stored on both sides (each row points at the other via partner_txn_id)
-- and both rows share the same input_hash, so applying or dismissing one side
-- closes the other. input_hash identifies what the suggestion was computed
-- from: a dismissed suggestion is not offered again until it changes.
CREATE TABLE transaction_suggestions (
    id              INTEGER PRIMARY KEY,
    transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    kind            TEXT    NOT NULL CHECK (kind IN ('category', 'transfer', 'cash_withdrawal')),
    source          TEXT    NOT NULL CHECK (source IN ('llm', 'rule', 'history')),
    category_id     INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    partner_txn_id  INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    cash_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    confidence      INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 10),
    rationale       TEXT    NOT NULL,
    reasoning       TEXT,
    prompt          TEXT,
    model           TEXT,
    input_hash      TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'dismissed')),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (transaction_id, kind)
);

CREATE INDEX idx_suggestions_partner ON transaction_suggestions(partner_txn_id);

-- The dialog agent (016) is replaced by suggestions; its per-transaction
-- chat blob goes away.
ALTER TABLE transactions DROP COLUMN agent;
