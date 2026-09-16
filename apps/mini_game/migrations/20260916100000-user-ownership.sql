-- AUTH-3: save ownership. Valid ONLY as a single-user → multi-user upgrade:
-- existing rows are backfilled to the single bootstrap user (core.users is
-- seeded with exactly one placeholder admin before app migrations run).
ALTER TABLE saves ADD COLUMN user_id uuid;

UPDATE saves SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM saves WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'saves ownership backfill failed: no core.users row to own existing rows';
  END IF;
END $$;

ALTER TABLE saves ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE saves
  ADD CONSTRAINT saves_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;

-- Per-user save slot: PK becomes (user_id, id) so every user has their own 'current' save.
ALTER TABLE saves DROP CONSTRAINT saves_pkey;
ALTER TABLE saves ADD PRIMARY KEY (user_id, id);
