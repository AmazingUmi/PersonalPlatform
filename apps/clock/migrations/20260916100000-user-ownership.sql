-- AUTH-3: clock ownership. Valid ONLY as a single-user → multi-user upgrade:
-- existing rows are backfilled to the single bootstrap user (core.users is
-- seeded with exactly one placeholder admin before app migrations run).
ALTER TABLE alarms ADD COLUMN user_id uuid;
ALTER TABLE world_clocks ADD COLUMN user_id uuid;
ALTER TABLE settings ADD COLUMN user_id uuid;

UPDATE alarms SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE world_clocks SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE settings SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alarms WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'alarms ownership backfill failed: no core.users row to own existing rows';
  END IF;
  IF EXISTS (SELECT 1 FROM world_clocks WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'world_clocks ownership backfill failed: no core.users row to own existing rows';
  END IF;
  IF EXISTS (SELECT 1 FROM settings WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'settings ownership backfill failed: no core.users row to own existing rows';
  END IF;
END $$;

ALTER TABLE alarms ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE world_clocks ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE settings ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE alarms
  ADD CONSTRAINT alarms_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE world_clocks
  ADD CONSTRAINT world_clocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE settings
  ADD CONSTRAINT settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;

-- Per-user settings slot: PK becomes (user_id, id) so every user has their own 'current' row.
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (user_id, id);

CREATE INDEX alarms_user_idx ON alarms(user_id);
CREATE INDEX world_clocks_user_sort_idx ON world_clocks(user_id, sort_order);
