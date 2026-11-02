-- Remember each cloud object by its real filename. One SHA-256 can be a
-- .json row object and a .bin attachment; the old primary key kept only one.
-- Rows recorded before filenames existed are not given a guessed extension.
DROP INDEX IF EXISTS core.sync_remote_objects_filename;
DELETE FROM core.sync_remote_objects WHERE filename IS NULL;
ALTER TABLE core.sync_remote_objects DROP CONSTRAINT sync_remote_objects_pkey;
ALTER TABLE core.sync_remote_objects ALTER COLUMN filename SET NOT NULL;
ALTER TABLE core.sync_remote_objects ADD PRIMARY KEY (user_id, filename);
