-- Journal and progress for continuous sync. Does not rewrite backup rows or
-- the binding identity created by 20261102000001.
ALTER TABLE core.sync_bindings
  ADD COLUMN head_etag text,
  ADD COLUMN head_generation bigint,
  ADD COLUMN head_document jsonb,
  ADD COLUMN remote_op_token uuid,
  ADD COLUMN remote_content_hash text,
  ADD COLUMN parent_op_token uuid,
  ADD COLUMN parent_content_hash text,
  ADD COLUMN parent_etag text,
  ADD COLUMN pending_head jsonb,
  ADD COLUMN pending_tombstones jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN pending_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN backoff_until timestamptz,
  ADD COLUMN backoff_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN baseline_generation bigint;

ALTER TABLE core.sync_row_state
  ADD COLUMN high_score integer;

ALTER TABLE core.sync_conflicts
  ADD COLUMN base_image jsonb,
  ADD COLUMN base_hash text,
  ADD COLUMN local_content_sha256 text,
  ADD COLUMN remote_content_sha256 text;

-- Hashes confirmed present on the remote collection. Skips repeat verification
-- so a later cycle can upload the objects that did not fit in the last budget.
CREATE TABLE core.sync_remote_objects (
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  PRIMARY KEY (user_id, sha256)
);
