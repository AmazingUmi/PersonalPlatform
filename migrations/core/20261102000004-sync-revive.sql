-- Explicit keep-local resurrection. A revived key must be published before it is a baseline.
ALTER TABLE core.sync_row_state
  ADD COLUMN revive boolean NOT NULL DEFAULT false;
