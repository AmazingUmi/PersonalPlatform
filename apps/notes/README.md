# Notes

Low-friction personal notes — capture first, organize later. A timeline of
short records (ideas, what happened today, takeaways) with optional tags,
mood and a capture time; not a knowledge base or folder system.

- Backend: `backend/src/apps/notes/index.ts` (+ `model.ts` pure helpers)
- Frontend: `frontend/src/apps/notes/` (timeline page, full editor at
  `/notes/new` and `/notes/:id`, dashboard `quick_note` widget)
- Schema: `notes.notes`, `notes.tags`, `notes.note_tags` (many-to-many;
  deleting a tag keeps its notes, deleting a note cascades the links)

Key semantics: `content` is the only required field; `occurred_at` defaults
to the platform clock (`ctx.time.now()`, no DB default) and drives the
server-computed `dayKey`/`todayKey`/`yesterdayKey` grouping via a
parameterized `AT TIME ZONE` (never `CURRENT_DATE`); PATCH uses three-state
nullable semantics with `tagIds` replaced wholesale inside the note's
transaction; multi-tag list filtering is AND semantics. `events` is
deliberately not declared — there are no consumers yet.
