-- Pairs of transactions that the user has marked as two sides of an internal
-- transfer between own accounts. The pair is stored as a single row with the
-- id pair canonicalised so `txn_a_id < txn_b_id`; this gives a stable order
-- for indexing but the link is logically undirected.
--
-- "Each transaction participates in at most one link" is enforced at
-- application level via a SELECT-then-INSERT inside a transaction — the
-- per-column UNIQUE indexes below catch the easy case (same id appearing
-- twice as txn_a or twice as txn_b) but cannot enforce the cross-column
-- constraint without a trigger.
CREATE TABLE transaction_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_a_id    INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    txn_b_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (txn_a_id < txn_b_id)
);

CREATE UNIQUE INDEX idx_txnlinks_a ON transaction_links(txn_a_id);
CREATE UNIQUE INDEX idx_txnlinks_b ON transaction_links(txn_b_id);
