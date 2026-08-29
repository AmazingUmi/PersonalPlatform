-- acquired_at (获得时间, user-supplied, optional) now backs range filters
-- (acquiredAfter/acquiredBefore). created_at (入库时间, auto) already has
-- items_created_at_idx for the default sort; this covers the acquired window.
CREATE INDEX items_acquired_at_idx ON items(acquired_at);
