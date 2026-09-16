-- AUTH-3/4: assets ownership + user-scoped attachment storage. Valid ONLY as
-- a single-user → multi-user upgrade: existing rows are backfilled to the
-- single bootstrap user (core.users is seeded with exactly one placeholder
-- admin before app migrations run).
-- item_categories carries no user_id: ownership derives from the owned
-- parent rows (items/categories).
ALTER TABLE categories ADD COLUMN user_id uuid;
ALTER TABLE items ADD COLUMN user_id uuid;
ALTER TABLE attachments ADD COLUMN user_id uuid;
ALTER TABLE cleanup_jobs ADD COLUMN user_id uuid;

UPDATE categories SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE items SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE attachments SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE cleanup_jobs SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'categories ownership backfill failed: no core.users row to own existing rows';
  END IF;
  IF EXISTS (SELECT 1 FROM items WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'items ownership backfill failed: no core.users row to own existing rows';
  END IF;
  IF EXISTS (SELECT 1 FROM attachments WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'attachments ownership backfill failed: no core.users row to own existing rows';
  END IF;
  IF EXISTS (SELECT 1 FROM cleanup_jobs WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'cleanup_jobs ownership backfill failed: no core.users row to own existing rows';
  END IF;
END $$;

ALTER TABLE categories ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE items ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE cleanup_jobs ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE categories
  ADD CONSTRAINT categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE items
  ADD CONSTRAINT items_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE cleanup_jobs
  ADD CONSTRAINT cleanup_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;

-- Per-user category names: User A's "Work" and User B's "Work" coexist.
ALTER TABLE categories DROP CONSTRAINT categories_name_key;
CREATE UNIQUE INDEX categories_user_name_uidx ON categories(user_id, name);

-- cleanup_jobs resolve the storage scope of their storage_key through
-- user_id (delete_storage must know WHICH user's storage root to target).
CREATE INDEX items_user_created_idx ON items(user_id, created_at DESC);
CREATE INDEX attachments_user_item_idx ON attachments(user_id, item_id);
CREATE INDEX cleanup_jobs_user_status_idx ON cleanup_jobs(user_id, status, created_at);
