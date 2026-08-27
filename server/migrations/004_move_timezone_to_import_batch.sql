-- Move timezone offset from per-transaction column to a single batch-level column.
-- All rows imported from one bank statement share the same offset, so storing it
-- once per batch removes redundancy.

ALTER TABLE import_batches ADD COLUMN timezone_offset TEXT NOT NULL DEFAULT '';

UPDATE import_batches
SET timezone_offset = COALESCE(
    (SELECT occurred_at_tz
     FROM transactions
     WHERE transactions.import_batch_id = import_batches.id
     LIMIT 1),
    ''
);

ALTER TABLE transactions DROP COLUMN occurred_at_tz;
