-- FP-3.1: item target location + query-supporting index.
-- created_at stays the canonical "added time"; no second timestamp column.
ALTER TABLE items ADD COLUMN target_location text;

-- Default list ordering is newest-added first.
CREATE INDEX items_created_at_idx ON items(created_at DESC);
