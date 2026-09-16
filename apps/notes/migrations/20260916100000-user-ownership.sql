-- AUTH-3: notes ownership. Valid ONLY as a single-user → multi-user upgrade:
-- existing rows are backfilled to the single bootstrap user (core.users is
-- seeded with exactly one placeholder admin before app migrations run).
-- note_tags carries no user_id: ownership derives from the owned parent rows.
ALTER TABLE notes ADD COLUMN user_id uuid;
ALTER TABLE tags ADD COLUMN user_id uuid;

UPDATE notes SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);
UPDATE tags SET user_id = (SELECT id FROM core.users ORDER BY created_at, id LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM notes WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'notes ownership backfill failed: no core.users row to own existing notes';
  END IF;
  IF EXISTS (SELECT 1 FROM tags WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'tags ownership backfill failed: no core.users row to own existing tags';
  END IF;
END $$;

ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE tags ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE notes
  ADD CONSTRAINT notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;
ALTER TABLE tags
  ADD CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE;

-- Per-user tag names: User A's "Work" and User B's "Work" coexist.
ALTER TABLE tags DROP CONSTRAINT tags_name_key;
CREATE UNIQUE INDEX tags_user_name_uidx ON tags(user_id, name);

CREATE INDEX notes_user_occurred_idx ON notes(user_id, occurred_at DESC, created_at DESC);
