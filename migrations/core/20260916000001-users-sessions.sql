-- Core identity (AUTH-1): users + server-side sessions.
-- Only token hashes are stored; the raw session token lives solely in the
-- user's HttpOnly cookie.
CREATE TABLE IF NOT EXISTS core.users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS core.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON core.sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON core.sessions(expires_at);

-- Seed exactly one PLACEHOLDER admin: the deterministic owner that app
-- migrations backfill legacy single-user data to. The password hash is
-- deliberately not an Argon2 hash (a '$argon2…' string), so the account can
-- never log in until bootstrap (BOOTSTRAP_ADMIN_PASSWORD env or
-- `npm run bootstrap:admin`) activates it — no usable password ships in git,
-- and bootstrap never resets an already-activated account.
INSERT INTO core.users (id, username, password_hash, display_name, role)
VALUES (gen_random_uuid(), 'admin', '!bootstrap-pending', 'Administrator', 'admin')
ON CONFLICT (username) DO NOTHING;
