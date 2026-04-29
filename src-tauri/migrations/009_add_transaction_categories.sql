CREATE TABLE transaction_categories (
    transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id     INTEGER NOT NULL REFERENCES categories(id)   ON DELETE CASCADE,
    share_minor     INTEGER NOT NULL CHECK (share_minor > 0),
    position        INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, category_id)
);

CREATE INDEX idx_txc_txn ON transaction_categories(transaction_id);
CREATE INDEX idx_txc_cat ON transaction_categories(category_id);
