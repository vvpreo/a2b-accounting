-- Life context: date intervals of what was going on (a trip with the kids,
-- an illness, …). Intervals may overlap. Shown next to transactions and given
-- to the category model. Dates are calendar days, both bounds inclusive.
CREATE TABLE life_contexts (
    id         INTEGER PRIMARY KEY,
    title      TEXT    NOT NULL CHECK (length(trim(title)) > 0),
    starts_on  TEXT    NOT NULL,
    ends_on    TEXT    NOT NULL,
    color      TEXT    NOT NULL,
    note       TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (ends_on >= starts_on)
);

CREATE INDEX idx_life_contexts_dates ON life_contexts(starts_on, ends_on);
