-- System categories: created and kept by the app, not by the user. The only
-- ones so far are the two "transfer between own accounts" categories
-- (`transfer_income`, `transfer_expense`) that every newly linked transfer
-- or cash withdrawal gets by default. They cannot be deleted or moved; the
-- rows themselves are created at startup (`transfer_categories.rs`), so the
-- name and description follow the app language.
ALTER TABLE categories ADD COLUMN system_key TEXT;
CREATE UNIQUE INDEX idx_categories_system_key ON categories(system_key) WHERE system_key IS NOT NULL;
