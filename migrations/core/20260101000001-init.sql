-- Core platform schema: app registry state and platform settings.
CREATE TABLE IF NOT EXISTS core.apps (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'installed',
  enabled boolean NOT NULL DEFAULT false,
  error_message text,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
