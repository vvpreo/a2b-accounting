-- Mark synthetic transactions inserted to bridge a discrepancy between an
-- imported batch and existing DB chain. They keep the balance chain locally
-- consistent and are intended to be replaced by real records later, when
-- the user identifies what actually happened.
ALTER TABLE transactions ADD COLUMN is_correcting INTEGER NOT NULL DEFAULT 0;
