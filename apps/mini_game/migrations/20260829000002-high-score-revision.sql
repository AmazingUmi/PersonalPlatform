-- FP-2A.3 / FP-2A.4: persistent historical high score + monotonic revision
-- for stale-save rejection. Existing rows keep their current score as the
-- starting high score so no history is lost.
ALTER TABLE saves ADD COLUMN high_score integer NOT NULL DEFAULT 0;
ALTER TABLE saves ADD COLUMN revision integer NOT NULL DEFAULT 0;
UPDATE saves SET high_score = score WHERE score > high_score;
