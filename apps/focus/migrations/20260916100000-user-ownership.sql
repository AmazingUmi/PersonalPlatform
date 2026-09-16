-- AUTH-3: focus ownership. Valid ONLY as a single-user → multi-user upgrade:
-- existing rows are backfilled to the single bootstrap user (core.users is
-- seeded with exactly one placeholder admin before app migrations run).
ALTER TABLE sessions ADD COLUMN user_id uuid;
ALTER TABLE settings ADD COLUMN user_id uuid;

UPDATE sessions SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE settings SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sessions WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'sessions ownership backfill failed: no core.users row to own existing rows';
  END IF;
  IF EXISTS (SELECT 1 FROM settings WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'settings ownership backfill failed: no core.users row to own existing rows';
  END IF;
END $$;

ALTER TABLE sessions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE settings ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE settings
  ADD CONSTRAINT settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;

-- The single-active-session invariant becomes PER USER: one running/paused
-- session each. Concurrent starts by different users no longer conflict.
DROP INDEX sessions_one_active_idx;
CREATE UNIQUE INDEX sessions_one_active_idx ON sessions(user_id) WHERE status IN ('running', 'paused');

-- Per-user settings slot: PK becomes (user_id, id) so every user has their own 'current' row.
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (user_id, id);

CREATE INDEX sessions_user_started_idx ON sessions(user_id, started_at DESC);
