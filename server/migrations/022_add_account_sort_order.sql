-- User-defined order of accounts (Accounts screen, drag & drop). Every
-- account list in the app follows it. Existing accounts keep their creation
-- order; new ones go to the end.
ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET sort_order = id;
