-- Import of a Telegram channel export into a cash account.
--
-- One channel feeds one account, and the HTML export carries no channel id, so
-- a message is identified by (account_id, message_id). `title` and
-- `timezone_offset` only prefill the wizard: the title notices a file from
-- another channel, the offset is what the owner chose last time.
CREATE TABLE telegram_channels (
    account_id      INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    timezone_offset TEXT NOT NULL
);

-- Every message the owner has decided on, so it is not offered again; `text`
-- notices a message edited after that. Forgotten with its batch on rollback.
CREATE TABLE telegram_messages (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('imported', 'skipped')),
    text       TEXT NOT NULL,
    batch_id   INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, message_id)
);
CREATE INDEX idx_telegram_messages_batch ON telegram_messages(batch_id);
