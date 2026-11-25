-- Archive mappings contain only canonical, owner-relative Trash keys.
CREATE FUNCTION core.valid_trash_attachment_keys(archive_id uuid, files jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(files) = 'array' THEN (
    SELECT coalesce(bool_and((CASE WHEN jsonb_typeof(file) = 'object' THEN
      file - ARRAY['attachmentId', 'key', 'size', 'sha256'] = '{}'::jsonb
      AND jsonb_typeof(file->'attachmentId') = 'string'
      AND file->>'attachmentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(file->'key') = 'string'
      AND file->>'key' = 'trash/' || archive_id::text || '/' || (file->>'attachmentId')
      AND jsonb_typeof(file->'size') = 'number'
      AND file->>'size' ~ '^(0|[1-9][0-9]*)$'
      AND file->'size' < '9007199254740992'::jsonb
      AND jsonb_typeof(file->'sha256') = 'string'
      AND file->>'sha256' ~ '^[0-9a-f]{64}$'
    END) IS TRUE), true)
    AND count(*) = count(DISTINCT file->>'attachmentId')
    FROM jsonb_array_elements(files) AS attachment(file)
  ) ELSE false END;
$$;

CREATE TABLE core.trash_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  app_id text NOT NULL CHECK (app_id ~ '^[a-z][a-z0-9_]*$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id uuid NOT NULL,
  title text NOT NULL,
  summary text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  attachment_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_by_type text NOT NULL,
  deleted_by_agent_id uuid,
  deleted_by_label text NOT NULL,
  deleted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > deleted_at),
  CONSTRAINT trash_items_attachment_keys_check CHECK (core.valid_trash_attachment_keys(id, attachment_keys)),
  CONSTRAINT trash_items_actor_check CHECK (
    (deleted_by_type = 'user' AND deleted_by_agent_id IS NULL)
    OR (deleted_by_type = 'agent' AND deleted_by_agent_id IS NOT NULL)
  )
);

CREATE INDEX trash_items_user_deleted_idx ON core.trash_items (user_id, deleted_at DESC, id DESC);
CREATE INDEX trash_items_user_app_deleted_idx ON core.trash_items (user_id, app_id, deleted_at DESC, id DESC);
CREATE INDEX trash_items_expires_idx ON core.trash_items (expires_at, id);

-- One durable row reserves all paths for one copy operation. Owner and archive
-- IDs are historical locators so recovery can continue after either is deleted.
CREATE TABLE core.trash_blob_intents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  app_id text NOT NULL CHECK (app_id ~ '^[a-z][a-z0-9_]*$'),
  trash_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('delete', 'restore')),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array' AND files <> '[]'::jsonb),
  created_at timestamptz NOT NULL,
  abandon_after timestamptz NOT NULL CHECK (abandon_after > created_at),
  committed_at timestamptz
);

CREATE INDEX trash_blob_intents_owner_idx ON core.trash_blob_intents (user_id, trash_id, id);
CREATE INDEX trash_blob_intents_pending_idx ON core.trash_blob_intents (abandon_after, id) WHERE committed_at IS NULL;
CREATE INDEX trash_blob_intents_committed_idx ON core.trash_blob_intents (committed_at, id) WHERE committed_at IS NOT NULL;

-- Owner-relative keys are unique per user. Keep the origin for cleanup after
-- the user and archive are gone. The worker still rechecks committed references.
CREATE TABLE core.trash_blob_cleanup (
  user_id uuid NOT NULL,
  storage_key text NOT NULL,
  app_id text NOT NULL CHECK (app_id ~ '^[a-z][a-z0-9_]*$'),
  trash_id uuid NOT NULL,
  kind text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, storage_key),
  CONSTRAINT trash_blob_cleanup_key_check CHECK (
    position(chr(92) in storage_key) = 0
    AND storage_key !~ '(^|/)\.{1,2}(/|$)|//|/$'
    AND (
      (kind = 'trash' AND storage_key ~ (
        '^trash/' || trash_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ))
      OR (kind = 'live' AND starts_with(storage_key, 'apps/' || app_id || '/'))
    )
  )
);

CREATE INDEX trash_blob_cleanup_due_idx ON core.trash_blob_cleanup (next_attempt_at, user_id, storage_key);

CREATE FUNCTION core.enqueue_trash_blob_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO core.trash_blob_cleanup (user_id, storage_key, app_id, trash_id, kind)
  SELECT OLD.user_id, 'trash/' || OLD.id::text || '/' || (file->>'attachmentId'), OLD.app_id, OLD.id, 'trash'
  FROM jsonb_array_elements(OLD.attachment_keys) AS attachment(file)
  ON CONFLICT (user_id, storage_key) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trash_items_enqueue_blob_cleanup
AFTER DELETE ON core.trash_items
FOR EACH ROW EXECUTE FUNCTION core.enqueue_trash_blob_cleanup();
