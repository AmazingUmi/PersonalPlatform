CREATE TABLE core.agents (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  description text NOT NULL DEFAULT '',
  created_by_user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  requires_explicit_actor boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX agents_owner_idx ON core.agents (created_by_user_id, created_at, id);

CREATE TABLE core.agent_user_grants (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES core.agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['read', 'write', 'delete']::text[]),
  allowed_apps text[] NOT NULL CHECK (array_position(allowed_apps, NULL) IS NULL),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  granted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (agent_id, user_id),
  CONSTRAINT agent_grant_status_check CHECK (
    (status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX agent_user_grants_user_idx ON core.agent_user_grants (user_id, granted_at, id);

CREATE TABLE core.agent_pairing_requests (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES core.agents(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  requested_scopes text[] NOT NULL CHECK (
    cardinality(requested_scopes) BETWEEN 1 AND 3 AND requested_scopes <@ ARRAY['read', 'write', 'delete']::text[]
  ),
  requested_apps text[] NOT NULL CHECK (array_position(requested_apps, NULL) IS NULL),
  created_by_user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NOT NULL OR consumed_by_user_id IS NULL)
);
CREATE INDEX agent_pairing_requests_agent_idx ON core.agent_pairing_requests (agent_id, id);
CREATE INDEX agent_pairing_requests_expires_idx ON core.agent_pairing_requests (expires_at, id);

CREATE TABLE core.agent_audit_logs (
  id uuid PRIMARY KEY,
  agent_id uuid REFERENCES core.agents(id) ON DELETE SET NULL,
  agent_name text NOT NULL,
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  tool_name text NOT NULL,
  action_kind text NOT NULL CHECK (action_kind IN ('write', 'delete')),
  resource_id text,
  status text NOT NULL CHECK (status IN ('ok', 'replayed', 'conflict', 'denied', 'error')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_audit_logs_user_order_idx ON core.agent_audit_logs (user_id, created_at DESC, id DESC);
CREATE INDEX agent_audit_logs_created_idx ON core.agent_audit_logs (created_at, id);
CREATE INDEX agent_audit_logs_agent_idx ON core.agent_audit_logs (agent_id);

CREATE TABLE core.agent_create_receipts (
  grant_id uuid NOT NULL REFERENCES core.agent_user_grants(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, tool_name, idempotency_key)
);
