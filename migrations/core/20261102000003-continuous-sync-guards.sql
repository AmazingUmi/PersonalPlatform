-- Forward-only guards for join origin, conflict choice, and real remote object names.
-- Does not rewrite backup rows or historical snapshot fingerprints.
ALTER TABLE core.sync_bindings
  ADD COLUMN origin text NOT NULL DEFAULT 'create' CHECK (origin IN ('create', 'join'));

ALTER TABLE core.sync_conflicts
  ADD COLUMN resolution text CHECK (resolution IS NULL OR resolution IN ('keep-local', 'keep-remote'));

ALTER TABLE core.sync_remote_objects
  ADD COLUMN filename text;

CREATE UNIQUE INDEX sync_remote_objects_filename
  ON core.sync_remote_objects (user_id, filename)
  WHERE filename IS NOT NULL;
