-- Messages left for review in the Telegram import wizard, kept so that they can
-- be sorted out later without the file. `rows_json` is the wizard's own draft of
-- the message's rows, corrections included; the server does not read it.
CREATE TABLE telegram_pending (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    text       TEXT NOT NULL,
    date       TEXT NOT NULL,
    time       TEXT NOT NULL,
    rows_json  TEXT NOT NULL,
    PRIMARY KEY (account_id, message_id)
);
