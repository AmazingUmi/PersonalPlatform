CREATE TABLE saves (
  id text PRIMARY KEY,
  score integer NOT NULL DEFAULT 0,
  board jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
