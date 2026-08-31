CREATE TABLE settings (
  id text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alarms (
  id uuid PRIMARY KEY,
  time text NOT NULL,
  label text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  repeat_days integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alarms_time_format_check CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT alarms_repeat_days_check CHECK (
    repeat_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::integer[]
  )
);

CREATE TABLE world_clocks (
  id uuid PRIMARY KEY,
  city text NOT NULL,
  timezone text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX world_clocks_sort_idx ON world_clocks(sort_order);
