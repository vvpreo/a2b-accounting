-- Subcategory colours follow their parent unless set by hand: `color_auto`
-- = 1 means `color` is derived (see category_colors.rs) and recomputed
-- whenever the parent's colour or the tree changes. Root categories always
-- keep the colour the user picked; the flag is ignored for them.
-- Existing subcategories switch to automatic colours (user decision,
-- 2026-11-01); their colours are recomputed at startup.
ALTER TABLE categories ADD COLUMN color_auto INTEGER NOT NULL DEFAULT 1;
UPDATE categories SET color_auto = 0 WHERE parent_id IS NULL;
