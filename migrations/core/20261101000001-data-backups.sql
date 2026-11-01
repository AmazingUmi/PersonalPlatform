-- Private per-user backup configuration; never exposed through core.settings.
CREATE TABLE core.backup_targets (
  user_id uuid PRIMARY KEY REFERENCES core.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  username text NOT NULL,
  password_ciphertext text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('own', 'all')),
  interval_hours integer NOT NULL DEFAULT 0 CHECK (interval_hours IN (0,1,6,12,24,168)),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.backup_history (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  filename text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('own', 'all')),
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_history_owner_created ON core.backup_history(user_id, created_at DESC);
