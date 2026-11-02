-- Own-scope continuous sync metadata. Pairing secrets, when stored later,
-- are ciphertext only. This migration does not change backup rows.
CREATE TABLE core.sync_bindings (
  user_id uuid PRIMARY KEY REFERENCES core.users(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL,
  replica_id uuid NOT NULL,
  destination_endpoint text NOT NULL,
  destination_username text NOT NULL,
  pairing_verifier text NOT NULL,
  pairing_secret_ciphertext text,
  enabled boolean NOT NULL DEFAULT false,
  interval_seconds integer NOT NULL DEFAULT 120 CHECK (interval_seconds IN (0, 60, 120)),
  phase text NOT NULL DEFAULT 'unlinked' CHECK (phase IN ('unlinked', 'probing', 'bootstrap', 'linked', 'publication_unknown')),
  baseline_hash text,
  lease_token uuid,
  lease_until timestamptz,
  pending_op_token uuid,
  pending_content_hash text,
  pending_capture_hash text,
  pending_applied boolean NOT NULL DEFAULT false,
  last_error text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One cloud identity maps to one local account on this deployment.
CREATE UNIQUE INDEX sync_bindings_identity ON core.sync_bindings(identity_id);

CREATE TABLE core.sync_row_state (
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  sync_key text NOT NULL,
  base_hash text,
  tombstoned boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, sync_key)
);

CREATE TABLE core.sync_conflicts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  sync_key text NOT NULL,
  reason text NOT NULL,
  local_image jsonb,
  remote_image jsonb,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_conflicts_open ON core.sync_conflicts(user_id, sync_key) WHERE state = 'open';

CREATE TABLE core.sync_guards (
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  sync_key text NOT NULL,
  remote_image jsonb NOT NULL,
  applied_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sync_key)
);
