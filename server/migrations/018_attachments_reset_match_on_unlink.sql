-- When a document loses its transaction — explicitly, or because the
-- transaction (its import batch, its account) was deleted and the FK
-- `ON DELETE SET NULL` fired — its match status must fall back to
-- 'unmatched'. SQLite runs UPDATE triggers for FK SET NULL actions too.
CREATE TRIGGER attachments_reset_match_on_unlink
AFTER UPDATE OF transaction_id ON attachments
WHEN NEW.transaction_id IS NULL AND OLD.transaction_id IS NOT NULL
BEGIN
    UPDATE attachments SET match_status = 'unmatched' WHERE id = NEW.id;
END;

-- Repair rows orphaned before the trigger existed.
UPDATE attachments SET match_status = 'unmatched'
WHERE transaction_id IS NULL AND match_status <> 'unmatched';
