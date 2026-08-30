-- Focus sessions (pomodoro runs with lifecycle states) and settings (key-value store).

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('focus', 'short_break', 'long_break')),
  status text NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'cancelled')),
  planned_duration_seconds integer NOT NULL CHECK (planned_duration_seconds BETWEEN 1 AND 86400),
  elapsed_before_pause_seconds integer NOT NULL DEFAULT 0 CHECK (elapsed_before_pause_seconds >= 0),
  started_at timestamptz NOT NULL,
  last_resumed_at timestamptz,
  paused_at timestamptz,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('natural', 'manual_stop')),
  actual_duration_seconds integer,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one active session across BOTH statuses: partial unique index on a
-- constant expression. Concurrent starts serialize on this index.
CREATE UNIQUE INDEX sessions_one_active_idx ON sessions ((1)) WHERE status IN ('running', 'paused');

CREATE INDEX sessions_started_at_idx ON sessions (started_at DESC);
CREATE INDEX sessions_status_started_idx ON sessions (status, started_at DESC);

CREATE TABLE settings (
  id text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
