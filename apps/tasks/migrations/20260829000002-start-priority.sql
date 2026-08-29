-- FP-4.1: task start time and priority.
-- priority: 0 Low, 1 Normal, 2 High, 3 Urgent.
ALTER TABLE tasks ADD COLUMN start_at timestamptz NULL;
ALTER TABLE tasks ADD COLUMN priority smallint NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check CHECK (priority BETWEEN 0 AND 3);

-- Query paths: priority filtering/sorting combined with deadlines, and
-- start-at range filters. status and due_at already have single-column indexes.
CREATE INDEX tasks_priority_due_at_idx ON tasks(priority, due_at);
CREATE INDEX tasks_start_at_idx ON tasks(start_at);
