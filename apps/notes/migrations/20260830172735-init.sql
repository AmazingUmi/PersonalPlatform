-- migration: init (scope: notes)
-- Bare table names: the runner creates the `notes` schema (doc/APP_DEVELOPMENT.md §Migrations).
CREATE TABLE notes (
  id uuid PRIMARY KEY,
  title text,
  content text NOT NULL,
  mood text CHECK (mood IN ('great', 'good', 'neutral', 'low', 'bad')),
  occurred_at timestamptz NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE note_tags (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX notes_occurred_at_idx ON notes(occurred_at DESC, created_at DESC);
CREATE INDEX notes_pinned_idx ON notes(pinned) WHERE pinned;
CREATE INDEX note_tags_tag_idx ON note_tags(tag_id);
