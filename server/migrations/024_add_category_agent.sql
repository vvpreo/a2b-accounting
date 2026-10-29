-- The category agent (docs/plans/category-agent.md).
--
-- LLM connections: the user creates any number of them from the presets
-- (OpenAI, Anthropic, OpenRouter, Custom) and picks one for the agent
-- (`app_settings.agent.connection_id`). `protocol` is how the app talks to
-- the endpoint: an OpenAI-compatible chat-completions API or Anthropic's
-- Messages API. The key may be a literal or an `env:VAR` reference.
CREATE TABLE ai_connections (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    preset      TEXT    NOT NULL,
    protocol    TEXT    NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
    base_url    TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    api_key     TEXT    NOT NULL DEFAULT '',
    temperature REAL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Transactions the user marked as examples of how they categorise. The
-- category is read live from transaction_categories, so recategorising an
-- example changes what the agent learns.
CREATE TABLE category_examples (
    transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Everything that happens between the user and the agent, kept for evals:
-- every model call with the full exchange and token usage, and every user
-- decision (accepting, dismissing, categorising differently, marking
-- examples). Rows outlive the transactions and suggestions they mention —
-- no foreign keys on purpose.
CREATE TABLE agent_log (
    id                INTEGER PRIMARY KEY,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    event             TEXT    NOT NULL,
    transaction_id    INTEGER,
    suggestion_id     INTEGER,
    -- The category the agent suggested / the user chose.
    suggested_category_id INTEGER,
    chosen_category_id    INTEGER,
    connection_name   TEXT,
    protocol          TEXT,
    base_url          TEXT,
    model             TEXT,
    -- Hash of the user's instructions: which prompt version produced it.
    prompt_hash       TEXT,
    -- JSON: exactly what was sent / received.
    request           TEXT,
    response          TEXT,
    -- JSON: the parsed answer, or NULL.
    result            TEXT,
    error             TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    reasoning_tokens  INTEGER,
    total_tokens      INTEGER,
    duration_ms       INTEGER,
    -- JSON: free-form extras (example ids, attempt number, …).
    details           TEXT
);

CREATE INDEX idx_agent_log_event ON agent_log(event, created_at);
CREATE INDEX idx_agent_log_txn ON agent_log(transaction_id);
