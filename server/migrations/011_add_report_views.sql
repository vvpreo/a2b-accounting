CREATE TABLE report_views (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    config      TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_report_views_sort ON report_views(sort_order, id);
