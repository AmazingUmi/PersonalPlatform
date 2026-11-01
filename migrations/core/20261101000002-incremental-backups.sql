-- Preserve old full snapshots while adding incremental manifest metadata.
ALTER TABLE core.backup_history
  ADD COLUMN kind text NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'incremental')),
  ADD COLUMN namespace text,
  ADD COLUMN content_fingerprint text,
  ADD COLUMN destination_username text,
  ADD COLUMN logical_size_bytes integer NOT NULL DEFAULT 0,
  ADD COLUMN uploaded_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN uploaded_objects integer NOT NULL DEFAULT 0,
  ADD COLUMN sequence bigserial;
UPDATE core.backup_history SET logical_size_bytes=size_bytes,
  uploaded_bytes=size_bytes, uploaded_objects=1;
CREATE UNIQUE INDEX backup_history_sequence ON core.backup_history(sequence);
CREATE INDEX backup_history_namespace ON core.backup_history(user_id, namespace, sequence DESC)
  WHERE kind='incremental';
