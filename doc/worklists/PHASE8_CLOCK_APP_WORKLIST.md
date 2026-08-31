# Phase 8 — Clock App Worklist

## Objective

Ship a Clock app ("时间状态中心"): current time (digital + analog), alarms, world
clocks, and Tasks integration (current / next / remaining today) — plus a formal,
reusable Tasks public read API.

## Current gap

- No clock app exists; the platform has no wall-clock widget.
- Tasks has no cross-app read surface and no task detail URL (editing is a modal
  on `/tasks`), so nothing can deep-link to "the current task".
- No alarm / world-clock data anywhere.

## Review conclusions (Phase A)

- **Cross-app access**: Contract V1 has **no server-side cross-app channel**.
  `isolation.test.ts` bans importing other apps and cross-schema SQL;
  `AppContext` never exposes a sibling app. The sanctioned composition point is
  the browser calling app HTTP APIs (same pattern the shell uses for
  `/api/core/apps`). ⇒ Tasks public API = a documented, read-only HTTP endpoint
  on the Tasks app; Clock's frontend consumes it. Disabling Tasks ⇒ 404 via the
  lifecycle guard ⇒ Clock hides the Task Status zone. No Core change, no
  Contract V1 evolution.
- **Settings precedent**: focus already ships the single-row `settings`
  (jsonb) table + `GET/PUT /settings` pattern — Clock copies it.
- **Task semantics**: statuses are only `todo`/`done`; there is no
  `started_at`. "Current" is derived from the planned window
  `start_at <= now AND (due_at IS NULL OR due_at > now)`.
- **Ids**: apps generate uuids client-side (`node:crypto.randomUUID()`).
- **E2E**: platform.spec asserts presence (not exhaustive sets); a new app does
  not break it.

## Architecture decisions

### Tasks Public API (Tasks-owned, additive)

`GET /api/apps/tasks/public/status` → camelCase view:

```json
{
  "current": { "id": "…", "title": "…", "startAt": "ISO" } | null,
  "next":    { "id": "…", "title": "…", "startAt": "ISO" } | null,
  "today":   { "remainingCount": 3 }
}
```

Boundary rule (explicit): at `now == start_at` a task is **current**
(start-inclusive); `next` requires `start_at > now` strictly. `current` picks
the most recently started candidate (`start_at DESC`); `today.remainingCount` =
`todo` tasks with `due_at` inside `ctx.time.todayRangeUtc()` minus current and
next (same "today = due date" semantic as the existing `/summary`).

Internal helpers in `backend/src/apps/tasks/index.ts`:
`getCurrentTask(now)`, `getNextTask(now)`, `getTodayRemaining(now, exclude)`
— reusable by future consumers (Calendar, Statistics) at the HTTP contract
level. Documented in `apps/tasks/README.md`.

### Clock data model (schema `clock`, one forward-only migration)

```sql
settings (id text PK, value jsonb NOT NULL, updated_at timestamptz)   -- single row "current"
alarms (id uuid PK, time text 'HH:MM', label text '', enabled bool true,
        repeat_days integer[] CHECK 0-6 (0=Sunday), created_at, updated_at)
world_clocks (id uuid PK, city text, timezone text (IANA),
        sort_order int, created_at, updated_at)
```

ClockSettings: `{ displayMode: "digital"|"analog", showSeconds: bool,
showDate: bool, hourFormat: 12|24 }` — one source of truth; dashboard card and
detail page both read/write it (never mounted together, so no cache needed).

Alarms and world clocks are Clock-owned only. Clock never persists task data
or "now". Alarm firing is detected in the browser while the app is open
(MVP, documented limitation); Notification API used when permitted.

### Frontend structure

```
frontend/src/apps/clock/
  index.tsx            module: route "" → ClockPage, widget clock → ClockWidget
  ClockPage.tsx        page: Main Clock / Task Status / Alarms / World Clock
  ClockWidget.tsx      dashboard card (same settings + faces as the page)
  DigitalClock.tsx     pixel digital face (card + page sizes)
  AnalogClock.tsx      SVG analog face (scales with container)
  useClockNow.ts       tick hook (1s when seconds shown, else minute-aligned; cleanup)
  timeMath.ts          PURE: formatting, hand angles, zone offsets, next alarm
  useClockSettings.ts  load/save settings hook
  tasksPublic.ts       typed client for GET /api/apps/tasks/public/status
  TaskStatusSection.tsx / AlarmSection.tsx / WorldClockSection.tsx
```

Tasks app gains `frontend/src/apps/tasks/TaskDetailPage.tsx` + route `:id`
(reuses the exported `TaskEditor`); Clock deep-links to `/tasks/:id`.

### API contracts (Clock)

- `GET/PUT /api/apps/clock/settings` (full-replace PUT, focus pattern)
- `GET/POST /api/apps/clock/alarms`, `PATCH/DELETE /api/apps/clock/alarms/:id`
  (three-state PATCH: absent=keep, null=clear-to-default, value=set)
- `GET/POST /api/apps/clock/world-clocks`, `PATCH/DELETE …/:id`,
  `PUT /api/apps/clock/world-clocks/order` `{ ids: [] }` → sort_order 1..n
- Errors: `422 invalid_timezone` (IANA check via Intl), `400 validation_error`,
  `404 not_found`. Views are camelCase.

### Visual identity

Accent `warning` (amber — LED clock); new 16×16 `clock` glyph in
`pixelIcons`; `[data-app="clock"] { --app-accent: var(--px-warning) }`;
app-specific CSS section in `apps.css`. Analog clock = pure SVG (crispEdges,
blocky hands), no third-party libs. All animation gated by the existing
`prefers-reduced-motion` global override; tick rate is 1s only when seconds
are shown.

## Task breakdown

1. Scaffold (done: `npm run create:app -- clock "Clock"`), manifest edit.
2. `apps/clock/migrations/20260831120000-init.sql`.
3. `backend/src/apps/clock/index.ts` (settings/alarms/world-clocks + healthcheck).
4. Tasks: `GET /public/status` + helpers + README note.
5. Frontend Tasks: `TaskDetailPage` + `:id` route.
6. Clock frontend: module, page, widget, faces, sections, hooks, pure utils.
7. Shared wiring: icons glyph, appIcons entries, tokens accent, apps.css.
8. Tests:
   - backend integration `clock.test.ts` (settings defaults/persist, alarm
     CRUD + repeat validation, world-clock CRUD + tz validation + reorder)
   - backend integration `tasks-public.test.ts` (matrix: none / future-only /
     current / current+next / multiple future / cross-day / `now == start_at`)
   - frontend unit: `timeMath` (12/24, seconds, hand angles, DST day offset,
     zone diff, next alarm), `ClockWidget` (settings fetch + toggle), digital /
     analog faces, `TaskStatusSection` (render + links + unavailable state)
   - helpers: `clock` → `APP_SCHEMAS`
9. Docs: `apps/clock/README.md`, worklist status.

## Allowed file scope

`apps/clock/**`, `backend/src/apps/clock/`, `frontend/src/apps/clock/`,
`backend/src/apps/tasks/index.ts` (additive public status), `apps/tasks/README.md`,
`frontend/src/apps/tasks/` (detail page + export TaskEditor + route entry),
generated registries, `backend/test/helpers/db.ts` (APP_SCHEMAS),
`backend/test/integration/{clock,tasks-public}.test.ts`,
`frontend/src/shared/ui/{appIcons.ts,icons.tsx}` (clock entries),
`frontend/src/styles/{tokens.css,apps.css}` (clock section), this worklist,
`apps/clock/README.md`.

## Non-goals

Stopwatch, countdown, pomodoro, calendar, task auto-start/complete, task data
copy, background alarm workers, notification sound/sleep features, Core or
Contract V1 changes, Dashboard/shell refactors, Tasks app redesign.

## Acceptance criteria

See task brief §16 checklist; additionally every canonical gate
(`check`, `build`, `test`, `test:integration`, `e2e`, `verify.sh`,
`git diff --check`) passes and no existing test is weakened.

## Regression matrix

| Risk | Check |
|---|---|
| Tasks API drift | existing tasks/timezone/apps integration suites unchanged |
| Dashboard layout | e2e platform spec (presence-based) green |
| New schema leaks | `resetDatabase` covers `clock` (APP_SCHEMAS) |
| Isolation | `backend/test/unit/isolation.test.ts` green (no cross-app imports) |
| Contract | `app-contract.test.ts` (manifest↔module, schema per app) green |
