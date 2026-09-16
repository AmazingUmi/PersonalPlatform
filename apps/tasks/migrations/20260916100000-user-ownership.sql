-- AUTH-3: task ownership. Valid ONLY as a single-user → multi-user upgrade:
-- existing rows are backfilled to the single bootstrap user (core.users is
-- seeded with exactly one placeholder admin before app migrations run).
ALTER TABLE tasks ADD COLUMN user_id uuid;

UPDATE tasks SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'tasks ownership backfill failed: no core.users row to own existing tasks';
  END IF;
END $$;

ALTER TABLE tasks ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;

CREATE INDEX tasks_user_status_idx ON tasks(user_id, status);
CREATE INDEX tasks_user_due_at_idx ON tasks(user_id, due_at);
