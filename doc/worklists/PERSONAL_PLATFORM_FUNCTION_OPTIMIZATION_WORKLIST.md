# PersonalPlatform Function Optimization Worklist

> Repository: `https://github.com/AmazingUmi/PersonalPlatform`
>
> Baseline: `main` after pixel UI completion
>
> Goal: close confirmed correctness bugs, complete the first functional CRUD/query loop for Assets and Tasks, make Dashboard layout interactive, add App presentation customization, and harden platform lifecycle behavior.
>
> Principle: **correctness first, business features second, interaction polish last**.

---

## 0. Scope and Rules

### 0.1 In scope

This worklist covers:

- Core App lifecycle / migration correctness
- 2048 input, high-score, and save consistency bugs
- Assets CRUD/category/attachment completion
- Tasks model/query/editing expansion
- Dashboard navigation and drag/reorder
- App Center display-name/accent customization
- Query-state, error handling, tests, and deployment hardening

### 0.2 Out of scope

Do not introduce:

- microservices
- authentication / multi-user account system
- plugin hot-loading
- cross-App business table coupling
- global generic entity tables
- large frontend state-management frameworks unless clearly necessary
- destructive migration rewrites of existing initial migrations

### 0.3 General implementation requirements

1. Preserve Modular Monolith boundaries.
2. Keep each App's business data inside its own PostgreSQL schema.
3. All new DB changes must use **new forward migrations**.
4. App disable must not delete App data.
5. Runtime user customization must be stored in `core.settings`, not written back into `app.yaml`.
6. API sort fields must use explicit allowlists; never interpolate arbitrary request values into SQL.
7. Nullable PATCH semantics must distinguish:
   - property absent → unchanged
   - property present with `null` → clear field
   - property present with value → update field
8. Every confirmed bug must receive a regression test.
9. Extend existing unit/integration/E2E tests rather than replacing the current validation system.
10. Preserve the pixel UI visual language and shared UI components.

---

# FP-1 — Core Lifecycle Correctness

**Priority: P0**

**Status: DONE** — migrations now follow installation (not the enabled flag); runtime enable applies pending migrations before activation; `enabled` records user intent and `status` the actual runtime state (`error` keeps `enabled=true`); `PUT /enabled` returns the registry's final record; App Center shows error state with Retry/Disable. Regression: `backend/test/integration/lifecycle-errors.test.ts`, updated `migrations.test.ts`.

## FP-1.1 App migration lifecycle

### Problem

App migrations currently run only for Apps that are enabled during backend startup.

Runtime App Center enable follows roughly:

```text
setEnabled()
→ activateApp()
```

without running pending App migrations.

This can cause:

```text
Installed/Disabled App
→ user clicks Enable
→ API/jobs activate
→ required table/column does not exist
→ runtime failure
```

### Required design

Change migration semantics from:

```text
migration == App enabled
```

to:

```text
migration == App installed/valid
```

Pending migrations for every valid installed App should be applied before App activation.

### Tasks

- [ ] Change startup App migration target selection to include every valid installed App that ships migrations.
- [ ] Do not skip migrations solely because an App is disabled.
- [ ] Preserve per-App schema isolation.
- [ ] Preserve stable migration ordering.
- [ ] Ensure runtime enable cannot activate an App against an outdated schema.
- [ ] Update comments/docs that currently state disabled Apps do not migrate.

### Acceptance

- [ ] Install/register a valid App in disabled state with a migration.
- [ ] Start platform.
- [ ] Verify its schema/migration is applied.
- [ ] Verify business API remains unavailable while disabled.
- [ ] Enable App at runtime.
- [ ] Verify it activates successfully without restart.

---

## FP-1.2 App state model consistency

### Target semantics

Use:

```text
enabled = user desired enable state
status  = actual runtime state
```

Recommended meanings:

```text
installed  valid App exists but cannot currently be considered active
enabled    requested enabled and runtime activation succeeded
disabled   requested disabled
error      requested state could not be fulfilled because activation/runtime setup failed
```

### Tasks

- [ ] Audit `AppRegistry.setEnabled()`.
- [ ] Audit `markError()`.
- [ ] Audit `persistApp()`.
- [ ] Ensure `enabled` is persisted consistently on conflict/update.
- [ ] Ensure activation failure cannot return a stale `"enabled"` record to the frontend.
- [ ] After activation attempt, return the registry's final current record.
- [ ] Decide and document whether `enabled` remains `true` when status becomes `error`.
- [ ] Prefer preserving user intent: `enabled=true`, `status=error`.
- [ ] Make App Center display Error independently from requested enable state.
- [ ] Review whether `installed` is actually reachable/useful; either define it correctly or simplify the state machine deliberately.

### Acceptance

Add integration coverage for:

- [ ] successful enable
- [ ] successful disable
- [ ] registerEvents failure
- [ ] registerJobs failure
- [ ] error persistence across API reads
- [ ] `core.apps.enabled` and `core.apps.status` consistent with API response
- [ ] disable after error
- [ ] re-enable after recoverable error

---

# FP-2 — Existing Bug Closure

**Priority: P0/P1**

# FP-2A — 2048

## FP-2A.1 Fix vertical controls

### Problem

`ArrowUp` and `ArrowDown` movement effects are reversed.

### Tasks

- [ ] Correct board rotation/movement transformation.
- [ ] Add deterministic unit tests for `moveBoard()`:
  - [ ] left
  - [ ] right
  - [ ] up
  - [ ] down
  - [ ] merge behavior
  - [ ] no double merge
  - [ ] unchanged board reports `moved=false`

### Acceptance

A tile in the lower area moves upward for Up and downward for Down.

---

## FP-2A.2 Implement advertised WASD input

### Tasks

Map:

```text
W / w → up
A / a → left
S / s → down
D / d → right
```

- [ ] Keep arrow keys.
- [ ] Ignore unrelated keys.
- [ ] Prevent default only for recognized game controls.
- [ ] Add frontend/E2E coverage.

---

## FP-2A.3 Separate current score from high score

### Problem

Dashboard "High Score" currently reads the current save score and resets after New Game.

### Migration

Add persistent high-score state.

Preferred model:

```text
mini_game.saves
- id
- score/current_score
- high_score
- board
- revision (optional; see FP-2A.4)
- updated_at
```

### Tasks

- [ ] Create forward migration.
- [ ] Preserve existing save data.
- [ ] On save: `high_score = max(previous high_score, new score)`.
- [ ] `/summary` must return historical high score.
- [ ] New Game resets current board/score only.
- [ ] Publish `mini_game.highscore.beaten.v1` only when the historical record is actually exceeded.

### Acceptance

- [ ] Reach score N.
- [ ] Start New Game.
- [ ] current score becomes 0.
- [ ] Dashboard high score remains N.

---

## FP-2A.4 Prevent stale save overwrite

### Problem

Every move immediately sends an async PUT. Rapid moves can produce overlapping writes.

### Preferred solution

Implement one of:

1. **serialized frontend save queue**, or
2. **monotonic revision with backend stale-write rejection**

Prefer revision if implementation stays simple and testable.

### Acceptance

- [ ] Rapid consecutive moves cannot leave the DB with an older board than the last accepted local state.
- [ ] Add deterministic backend or frontend regression coverage.

---

# FP-2B — Assets correctness bugs

## FP-2B.1 Real nullable PATCH semantics

Affected fields include:

```text
description
categoryId
acquiredAt
targetLocation (after FP-3)
```

### Tasks

- [ ] Replace current `COALESCE` behavior where it prevents clearing fields.
- [ ] Use property-presence checks.
- [ ] Allow explicit JSON `null` for nullable fields.
- [ ] Keep absent property as unchanged.
- [ ] Prefer `PATCH` semantics; if current `PUT` route is retained, document partial-update semantics clearly.

### Acceptance

- [ ] assign category
- [ ] clear category
- [ ] set description
- [ ] clear description
- [ ] set acquired date
- [ ] clear acquired date

---

## FP-2B.2 Attachment orphan cleanup

### Problem

Deleting an Item cascades attachment metadata in PostgreSQL but does not remove attachment files from Storage.

### Tasks

- [ ] Before/within item deletion flow, collect attachment storage keys.
- [ ] Delete physical stored objects.
- [ ] Delete Item/metadata safely.
- [ ] Define failure behavior if storage deletion fails.
- [ ] Avoid silently leaving permanent orphans.
- [ ] Add attachment-level deletion API:

```http
DELETE /api/apps/assets/items/:id/attachments/:attachmentId
```

### Acceptance

- [ ] Upload attachment.
- [ ] Delete attachment → DB metadata and storage object both gone.
- [ ] Upload attachment.
- [ ] Delete Item → DB metadata, Item row, and storage object all gone.

---

# FP-2C — Tasks correctness

## FP-2C.1 Preserve true completion timestamp

### Problem

Sending `status=done` repeatedly can refresh `completed_at`.

### Required behavior

```text
todo -> done   => completed_at = now()
done -> done   => completed_at unchanged
done -> todo   => completed_at = null
```

### Acceptance

Add integration tests for all three transitions.

---

# FP-3 — Assets V1 Functional Closure

**Priority: P1**

**Status: DONE** — `target_location` via forward migration (+ created_at index); Category PATCH/DELETE with clean duplicate-name errors; full item editor (create/edit) with nullable clearing; server-side query API (`q/categoryId/targetLocation/acquired+created ranges/sortBy/order` with explicit allowlist, NULLS LAST, deterministic fallback); URL-driven filter toolbar with debounced search; attachment download links and confirmed attachment/item/category deletion.

## FP-3.1 Data model expansion

Existing fields:

```text
id
category_id
name
description
quantity
acquired_at
created_at
updated_at
```

Add:

```text
target_location text NULL
```

Do **not** add another "added time" field.

Use:

```text
created_at == added time
```

### Migration

- [ ] New Assets migration adding `target_location`.
- [ ] Add useful indexes based on supported query behavior.

Recommended:

```sql
CREATE INDEX ... ON assets.items(created_at DESC);
```

Only add a `target_location` index if filtering semantics justify it.

---

## FP-3.2 Category CRUD

Backend:

```http
GET    /categories
POST   /categories
PATCH  /categories/:id
DELETE /categories/:id
```

Requirements:

- [ ] rename category
- [ ] delete category
- [ ] existing `ON DELETE SET NULL` behavior preserved
- [ ] unique-name conflict returned as clean API error
- [ ] frontend edit/delete controls
- [ ] confirmation before destructive delete

---

## FP-3.3 Item create/edit/delete

Create/edit UI must support:

- [ ] name
- [ ] description
- [ ] quantity
- [ ] category
- [ ] acquired date
- [ ] target location

Detail page must show:

- [ ] category
- [ ] quantity
- [ ] acquired date
- [ ] added time (`created_at`)
- [ ] last modified (`updated_at`)
- [ ] target location
- [ ] description
- [ ] attachments

Actions:

- [ ] Edit
- [ ] Delete
- [ ] confirmation before delete

---

## FP-3.4 Search/filter/sort API

Extend:

```http
GET /items
```

Supported query parameters should include at least:

```text
q
categoryId
targetLocation
acquiredAfter
acquiredBefore
createdAfter
createdBefore
sortBy
order
```

Supported `sortBy` allowlist:

```text
name
quantity
acquiredAt
createdAt
updatedAt
targetLocation
```

### Requirements

- [ ] query validation
- [ ] stable deterministic fallback ordering
- [ ] no raw arbitrary ORDER BY interpolation
- [ ] category filtering should be performed server-side rather than loading all rows and filtering only in React

---

## FP-3.5 Assets UI query controls

Toolbar:

```text
Search
Category
Location
Acquired date
Added date
Sort
Asc/Desc
```

Requirements:

- [ ] search debounce ~200–300 ms
- [ ] query state reflected in URL
- [ ] browser refresh preserves filters
- [ ] browser back/forward works
- [ ] empty state differentiates "no inventory" vs "no matches"

---

## FP-3.6 Attachment UX

- [ ] attachment name should open/download the backend resource
- [ ] attachment delete
- [ ] upload progress/busy state
- [ ] visible error state
- [ ] optional file-size limit if not already enforced
- [ ] backend should reject oversized payloads cleanly if a limit is introduced

---

# FP-4 — Tasks V1

**Priority: P1**

**Status: DONE** — `start_at` + `priority` (0–3, CHECK-constrained) via forward migration with (priority, due_at) and start_at indexes; PUT replaced by PATCH with nullable clearing; query API (`q/status/priority/start+due windows/sortBy/order` allowlist); `dueAt < startAt` rejected with 422; task editor dialog + URL-driven filters/sort + priority badges + overdue state + confirmed delete. Scheduler overdue-notification behavior documented as known follow-up.

## FP-4.1 Data model

Add:

```text
start_at timestamptz NULL
priority smallint NOT NULL DEFAULT 1
```

Recommended constraint:

```sql
CHECK (priority BETWEEN 0 AND 3)
```

UI mapping:

```text
0 = Low
1 = Normal
2 = High
3 = Urgent
```

Keep:

```text
due_at == target deadline
```

---

## FP-4.2 Task API

Create/update fields:

```text
title
description
status
startAt
dueAt
priority
```

Query:

```text
q
status
priority
startAfter
startBefore
dueAfter
dueBefore
sortBy
order
```

Allowlisted `sortBy`:

```text
createdAt
updatedAt
startAt
dueAt
priority
title
status
```

### Time validation

- [ ] Decide whether `dueAt < startAt` is invalid.
- [ ] Recommended: reject unless an explicit reason exists to allow it.
- [ ] Store UTC/timestamptz.
- [ ] Display in browser local timezone.

---

## FP-4.3 Tasks UI

Do not expand the current one-line create form into an oversized row.

Preferred interaction:

```text
Tasks
[ Search ][Filters][Sort]               [+ New Task]

Task List
...
```

`+ New Task` opens an editor panel/modal/window.

Task editor:

- [ ] title
- [ ] description
- [ ] status
- [ ] start time
- [ ] deadline
- [ ] priority

Task row/card:

- [ ] checkbox/status
- [ ] title
- [ ] priority badge
- [ ] start/deadline
- [ ] overdue state
- [ ] Edit
- [ ] Delete

---

## FP-4.4 Task filtering/indexes

Add indexes only for actual query paths.

At minimum consider:

```text
status
due_at              existing
priority
start_at
(priority, due_at)
(status, due_at)
```

Do not over-index without need.

---

## FP-4.5 Scheduler/summary semantics

Audit current "today" and "overdue" logic after start/deadline changes.

- [ ] Today means deadline today unless UI explicitly defines another concept.
- [ ] Overdue = not done and due_at < now().
- [ ] Completed tasks excluded from overdue.
- [ ] Scheduler should not repeatedly produce semantically duplicate notifications without a future dedupe strategy; document current behavior if intentionally unchanged.

---

# FP-5 — Dashboard Interaction

**Priority: P1**

## FP-5.1 Fix persisted order rendering

### Problem

Saved `visibleKeys` order is currently not necessarily the render order.

### Required implementation

Construct widgets in saved-key order.

Example concept:

```ts
const byKey = new Map(available.map(w => [widgetKey(w), w]));
const visible = visibleKeys.flatMap(key => {
  const widget = byKey.get(key);
  return widget ? [widget] : [];
});
```

### Regression test

Persist:

```text
beta:w2
alpha:w1
```

Assert Beta renders before Alpha.

---

## FP-5.2 Click card to navigate

Extend widget contract:

```ts
interface WidgetDefinition {
  id: string;
  title: string;
  href?: string;
  render: () => ReactNode;
}
```

Behavior:

```text
href defined → navigate href
href absent  → fallback to owning App root route
```

Requirements:

- [ ] keyboard accessible
- [ ] interactive elements inside widget must not accidentally trigger card navigation
- [ ] clicking cards works in normal mode
- [ ] dragging in edit mode does not navigate

---

## FP-5.3 Edit Layout mode

Normal mode:

```text
Dashboard                         [Edit Layout]
```

Edit mode supports:

- [ ] drag reorder
- [ ] hide widget
- [ ] show hidden widget
- [ ] restore default
- [ ] done/save

### Drag behavior

Prefer `@dnd-kit`.

Requirements:

- [ ] pointer input
- [ ] touch input
- [ ] keyboard-accessible reorder where practical
- [ ] explicit drag handle in PixelWindow header
- [ ] do not make entire widget draggable
- [ ] persist final order to `dashboard.widgets`

---

## FP-5.4 Hidden widget management

Current model already supports a visible-key list.

Add actual UI for:

- [ ] Hide
- [ ] Add/show hidden widget
- [ ] Restore all/default

Do not introduce a second competing layout store unless needed.

---

# FP-6 — App Presentation Customization

**Priority: P1/P2**

## FP-6.1 Storage model

Do not modify `app.yaml` at runtime.

Store user overrides in `core.settings`.

Recommended single setting:

```text
apps.presentation
```

Example:

```json
{
  "assets": {
    "displayName": "My Inventory",
    "accent": "mint"
  },
  "tasks": {
    "displayName": "Mission Control",
    "accent": "violet"
  }
}
```

Supported accent values must match `PixelAccent`.

---

## FP-6.2 Presentation resolver

Create one shared resolver so naming/color behavior is not duplicated.

Concept:

```text
manifest name/accent defaults
        +
core.settings user override
        =
resolved presentation
```

Use resolved presentation consistently in:

- [ ] App Center
- [ ] App Dock
- [ ] Mobile Nav
- [ ] Dashboard widget shell
- [ ] App header where applicable

---

## FP-6.3 App Center editor

Each App card gets a customization action.

Support:

- [ ] display nickname
- [ ] accent color
- [ ] reset to default

Do not allow changing:

```text
app id
route
version
capabilities
manifest identity
```

---

# FP-7 — UX, API Consistency, Tests, Hardening

**Priority: P2**

## FP-7.1 URL query state

Assets and Tasks filters/sorting should use URL search params.

Benefits:

- refresh persistence
- back/forward
- bookmarkable views
- Dashboard deep links

---

## FP-7.2 Mutation/error handling

Current reads use `useAsync`; write errors are inconsistent.

Introduce a small shared mutation pattern.

Requirements:

- [ ] busy state
- [ ] error state
- [ ] optional success feedback
- [ ] avoid double-submit
- [ ] do not add a large state library solely for this

A small `useMutation` or shared helper is sufficient.

---

## FP-7.3 Confirm destructive actions

Add confirmation for:

- [ ] Item delete
- [ ] Category delete
- [ ] Attachment delete
- [ ] Task delete

Use a reusable pixel-styled confirmation UI if practical.

---

## FP-7.4 Docker network exposure

Current default Compose exposes PostgreSQL, Backend, and Frontend to the host.

For safer default local operation:

Preferred topology:

```text
Host
  |
127.0.0.1:<frontend>
  |
Docker network
  ├─ frontend
  ├─ backend
  └─ database
```

Tasks:

- [ ] bind frontend host port to `127.0.0.1` by default
- [ ] avoid publishing database port by default
- [ ] avoid publishing backend port unless needed for dev tooling
- [ ] provide explicit override/profile for LAN/debug access
- [ ] keep environment-configurable behavior
- [ ] document the change

Do not break CI/E2E networking.

---

# 8. Test Matrix

## Backend integration

Must cover:

### Core
- [ ] migration for disabled installed App
- [ ] enable/disable lifecycle
- [ ] activation error persistence
- [ ] final returned App state after failure

### Assets
- [ ] Category create/update/delete
- [ ] Category `ON DELETE SET NULL`
- [ ] Item full create
- [ ] Item partial update
- [ ] nullable field clearing
- [ ] target_location
- [ ] search/filter/sort
- [ ] attachment upload/read/delete
- [ ] Item delete storage cleanup

### Tasks
- [ ] create with start/due/priority
- [ ] query filters
- [ ] sorting
- [ ] invalid priority
- [ ] invalid time interval
- [ ] completion timestamp transitions

### 2048
- [ ] persistent high score
- [ ] New Game does not clear high score
- [ ] stale save protection

---

## Frontend unit/component

- [ ] Dashboard persisted order
- [ ] Dashboard hide/show
- [ ] Dashboard navigation
- [ ] Dashboard edit-mode drag behavior
- [ ] App presentation resolver
- [ ] App Center customization
- [ ] Assets item/category edit controls
- [ ] Tasks filtering/sorting/editor
- [ ] 2048 movement transforms

---

## E2E

Extend existing Playwright suite.

Required flows:

### Assets
- [ ] create category
- [ ] create categorized item
- [ ] edit item
- [ ] filter/sort
- [ ] delete item
- [ ] attachment lifecycle

### Tasks
- [ ] create task with start/deadline/priority
- [ ] edit
- [ ] filter
- [ ] sort
- [ ] complete/uncomplete
- [ ] delete

### Dashboard
- [ ] click widget → App/deep link
- [ ] reorder widgets
- [ ] refresh → order preserved
- [ ] hide/show
- [ ] refresh → visibility preserved

### App Center
- [ ] change nickname
- [ ] change accent
- [ ] Dock/Dashboard reflect override
- [ ] reset customization

### 2048
- [ ] Arrow Up/Down correct
- [ ] WASD works
- [ ] high score survives New Game

---

# 9. Documentation Updates

Update as needed:

```text
README.md
doc/DEVELOPMENT.md
doc/IMPLEMENTATION_PLAN.md
doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md
```

Document:

- revised migration lifecycle
- App runtime state semantics
- Assets/Tasks query API
- Dashboard layout customization
- App presentation overrides
- safer Docker networking defaults

Do not rewrite historical design text unnecessarily; add concise current-state notes where appropriate.

---

# 10. Recommended Execution Order

Execute strictly in this order unless a dependency requires otherwise:

```text
FP-1 Core Lifecycle Correctness
    ↓
FP-2 Existing Bug Closure
    ↓
FP-3 Assets V1
    ↓
FP-4 Tasks V1
    ↓
FP-5 Dashboard Interaction
    ↓
FP-6 App Presentation
    ↓
FP-7 UX / Hardening / Final Regression
```

Each phase should finish with:

```text
implementation
→ focused tests
→ full check/build/test/integration
→ E2E where applicable
→ regression review
```

---

# 11. Global Acceptance Gate

Before declaring the batch complete:

```bash
npm run check
npm run build
npm test
npm run test:integration
npm run e2e
```

All must pass.

Also verify:

- [ ] no modified initial migrations
- [ ] no cross-App DB access
- [ ] no arbitrary SQL sort interpolation
- [ ] no orphan Asset attachment files
- [ ] Dashboard order survives reload
- [ ] disabled App data survives
- [ ] runtime enabling an App does not require backend restart
- [ ] App customization survives reload
- [ ] 2048 historical high score survives New Game
- [ ] existing pixel UI styling remains visually consistent

---

# 12. Definition of Done

This optimization batch is complete only when:

1. Core lifecycle state and migration behavior are internally consistent.
2. All confirmed existing bugs have regression tests.
3. Assets supports practical CRUD + category + attachment + query workflows.
4. Tasks supports start/deadline/priority + editing/filtering/sorting.
5. Dashboard supports click navigation, reorder, hide/show, and persistence.
6. App Center supports persistent nickname/accent customization.
7. Existing CI/test/E2E suite remains green.
8. No regression violates the original Modular Monolith / per-App isolation design.
