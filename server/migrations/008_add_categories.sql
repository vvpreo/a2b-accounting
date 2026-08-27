CREATE TABLE categories (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('income', 'expense')),
    parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (parent_id, name)
);

CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_kind ON categories(kind);
