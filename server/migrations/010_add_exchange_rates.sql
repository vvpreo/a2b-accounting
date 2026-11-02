CREATE TABLE exchange_rates (
    id            INTEGER PRIMARY KEY,
    currency      TEXT    NOT NULL,
    rate_date     TEXT    NOT NULL,
    rate_to_base  TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(currency, rate_date)
);
CREATE INDEX idx_rates_lookup ON exchange_rates(currency, rate_date);
