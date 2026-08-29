-- Storage/DB consistency compensation queue (FP-12.1). Neither "storage
-- first" nor "DB first" can be atomic across PostgreSQL and the filesystem,
-- so failures enqueue a retryable, idempotent cleanup job instead.
CREATE TABLE cleanup_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('delete_storage', 'drop_dangling_attachment')),
  storage_key text,
  attachment_id uuid,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cleanup_jobs_pending_idx ON cleanup_jobs(status, created_at);
