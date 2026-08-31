# Clock

The platform's lightweight "time status hub": clock faces (digital + analog),
alarms, world clocks, and a read-only view of what's happening in Tasks.

- Backend: `backend/src/apps/clock/index.ts` (+ `model.ts` pure helpers)
- Frontend: `frontend/src/apps/clock/` (page, dashboard widget, faces, sections)
- Schema: `clock.settings` / `clock.alarms` / `clock.world_clocks`
- Capabilities: `database` only — no scheduler/events/storage.

## What it owns

- **Settings** (single-row jsonb, focus-app pattern): `displayMode`
  (`digital`|`analog`), `showSeconds`, `showDate`, `hourFormat` (12|24). One
  source of truth — the dashboard card and the app page read/write the same
  row via `GET/PUT /api/apps/clock/settings`.
- **Alarms**: `time` ('HH:MM' local wall-clock), `label`, `enabled`,
  `repeatDays` (0=SUN…6=SAT; empty = one-shot). CRUD + enable/disable +
  weekday repeat. One-shot alarms disable themselves after ringing.
- **World clocks**: `city` + IANA `timezone` (never a UTC offset, so DST is
  resolved by Intl at display time) + `sortOrder`, reordered through
  `PUT /world-clocks/order`.

Clock never persists Tasks data or "now" — task state is fetched live from
the [Tasks public API](../tasks/README.md), and the clock runs on browser
system time. Deep links go to the Tasks detail page (`/tasks/:id`).

## Browser limitations (known, by design)

Alarm detection happens in the open Clock app on the local wall clock:

- alarms fire while the app/page is open; a fully closed browser cannot
  reliably wake the page, and that is **not** promised;
- the Notification API is used when permission is granted (button in the
  Alarms window; denied permission degrades to the in-app banner only);
- alarm times are matched in the **browser's local timezone**.

## Tests

- `backend/test/integration/clock.test.ts` — settings, alarm CRUD + repeat
  validation, world-clock CRUD + IANA validation + reorder, disabled lifecycle.
- `backend/test/integration/tasks-public.test.ts` — the Tasks contract matrix.
- `frontend/src/apps/clock/*.test.ts(x)` — pure time math (12/24, hand angles,
  DST offsets/day diffs, alarm scheduling), both faces, the widget and the
  task status zone.
