-- P7A2-01/02: items <-> categories becomes many-to-many. Backfill from the
-- legacy single-category column inside the same migration, then drop it:
-- one relation table, one source of truth, no dual-write drift.
CREATE TABLE item_categories (
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);

INSERT INTO item_categories (item_id, category_id)
SELECT id, category_id FROM items WHERE category_id IS NOT NULL;

CREATE INDEX item_categories_category_idx ON item_categories(category_id);

ALTER TABLE items DROP COLUMN category_id;
