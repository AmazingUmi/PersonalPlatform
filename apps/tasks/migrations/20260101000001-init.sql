CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'todo',
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_due_at_idx ON tasks(due_at);
