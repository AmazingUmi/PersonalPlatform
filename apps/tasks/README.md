# Tasks

Personal task management app. Verifies status management, time fields, query
filtering, a scheduled overdue-check job and events on the platform.

- Backend: `backend/src/apps/tasks/index.ts`
- Frontend: `frontend/src/apps/tasks/index.tsx`
- Schema: `tasks.*`

## Public status API (cross-app read surface)

`GET /api/apps/tasks/public/status` is the only sanctioned way for another app
(Clock today; Calendar / Statistics later) to consume task timing. It is a
read-only HTTP contract — consumers must never touch `tasks.*` tables or
import this app's internals, and they must tolerate `404` whenever the Tasks
app is disabled (platform lifecycle guard).

Response (camelCase, timestamptz as ISO UTC):

```json
{
  "current": { "id": "…", "title": "…", "startAt": "…" },
  "next": { "id": "…", "title": "…", "startAt": "…" },
  "today": { "remainingCount": 3 }
}
```

Semantics (frozen):

- `current` — the most recently started `todo` task with `start_at <= now`
  (`ORDER BY start_at DESC`). `due_at` is the target deadline and **never**
  ends current-ness: an overdue, unfinished task stays current until it is
  done. At `now == start_at` the task is already current (start-inclusive
  boundary); several started tasks resolve to the most recently started one.
  `null` when none.
- `next` — the `todo` task with the earliest strictly-future `start_at`
  (`start_at > now`, so the `now == start_at` case belongs to `current`,
  never both). `null` when none.
- `today.remainingCount` — additional `todo` tasks **starting** later in the
  platform-local day (`ctx.time.todayRangeUtc()`, `start_at > now`), excluding
  `next` (which is displayed on its own). The current task is excluded by
  `start_at > now`; tasks without `start_at` never count, regardless of
  `due_at`.

Breaking changes to this response require a new route version
(e.g. `/public/v2/status`), never an in-place semantic change.
