# App Development Guide

The authoritative reference for building Apps on Personal Platform: manifest, registration, lifecycle, backend/frontend module contracts, migrations, capabilities, and the conventions every App must follow. General repository workflow (commands, database, testing matrix) lives in [`DEVELOPMENT.md`](DEVELOPMENT.md); migration operations in [`MIGRATION_RUNBOOK.md`](MIGRATION_RUNBOOK.md); architecture in [`PERSONAL_PLATFORM_INITIAL_DESIGN.md`](PERSONAL_PLATFORM_INITIAL_DESIGN.md).

## Overview

Personal Platform is a single-user, self-hosted monolith. An **App** is a vertically sliced feature (tasks, assets, mini game, …) that plugs into the platform at three places sharing one id:

| Location | Contents | Load mechanism |
|---|---|---|
| `apps/<id>/` | `app.yaml` manifest (single source of truth for metadata), `migrations/` (forward-only SQL), `README.md` | Scanned at runtime by Core (`backend/src/core/app-registry/scanner.ts`) |
| `backend/src/apps/<id>/index.ts` | Backend module, default export `BackendAppModule` | Statically imported via `backend/src/generated/apps.ts` |
| `frontend/src/apps/<id>/index.tsx` | Frontend module, default export `FrontendAppModule` | Statically imported via `frontend/src/generated/apps.ts` |

Apps are compiled into the monolith — there is no runtime download or execution of unknown code. What the platform buys with this structure is per-app enable/disable, schema isolation, and a guarded capability surface, not dynamic loading.

The contract described in this document is **App Contract V1**; `GET /api/core/platform` reports it as `platformApiVersion: 1` (see [platformApiVersion](#platformapiversion)).

## Directory layout

A new app `my_app` spans these files (all created by `npm run create:app`):

```text
apps/my_app/
├── app.yaml                  # manifest v1 (metadata truth)
├── migrations/               # forward-only SQL, applied to schema "my_app"
└── README.md

backend/src/apps/my_app/index.ts    # BackendAppModule (default export)
frontend/src/apps/my_app/index.tsx  # FrontendAppModule (default export)

config/apps/my_app.yaml             # OPTIONAL static config, arbitrary YAML,
                                    # surfaced to the backend as ctx.config
```

Optional static config is loaded by `loadAppConfig` in `backend/src/core/config/index.ts`; it returns `{}` when the file is absent. It is deployment-time configuration (secrets, tunables), not user-visible settings — see [App settings ownership](#app-settings-ownership).

The frontend side also has two shared registration points that are **not** scaffolded automatically; see [Registration](#registration).

## Manifest v1

`apps/<id>/app.yaml` is validated by an Ajv JSON Schema plus semantic cross-field rules in `backend/src/core/app-registry/manifest.ts`. The scanner (`backend/src/core/app-registry/scanner.ts`) reads every `apps/*/app.yaml`; directories starting with `_` (e.g. `apps/_template/`) are ignored. An invalid manifest does not crash the platform — the app is listed with `status: "error"` and its error message — but the build-time generator fails hard so a broken app cannot ship.

Fields:

| Field | Type | Rules |
|---|---|---|
| `manifest_version` | integer | Must be exactly `1` |
| `id` | string | Must match `^[a-z][a-z0-9_]*$`; must be unique across apps |
| `name` | string | Non-empty display name |
| `version` | string | Semver `X.Y.Z` (`^\d+\.\d+\.\d+$`), the app's own version |
| `description` | string | Free text |
| `default_enabled` | boolean | Enablement default on first sight (see [lifecycle](#app-lifecycle)) |
| `frontend.route` | string | Must start with `/` (schema) **and** be under `/<id>` (semantic rule) |
| `widgets[]` | `{ id, name }` | Widget `id` must match `^[a-z][a-z0-9_]*$` and be unique within the app |
| `capabilities` | `{ database, storage, scheduler, events }` | Four booleans, all default `false` (see [Capabilities](#capabilities)) |

`additionalProperties: false` everywhere — unknown fields are validation errors, not silently ignored.

Example (`apps/tasks/app.yaml`):

```yaml
manifest_version: 1
id: tasks
name: Tasks
version: 0.1.0
description: Personal task management
default_enabled: true
frontend:
  route: /tasks
widgets:
  - id: today
    name: Tasks Today
capabilities:
  database: true
  storage: false
  scheduler: true
  events: true
```

## Registration

### Compile-time module tables

`scripts/generate-apps-registry.ts` scans `apps/*/app.yaml`, re-validates every manifest, and emits two generated files (never edit by hand):

- `backend/src/generated/apps.ts` — `backendAppModules` (static imports of every `backend/src/apps/<id>/index.ts`) and `frontendAppIds`
- `frontend/src/generated/apps.ts` — `frontendAppModules` (imports of every `frontend/src/apps/<id>/index.ts(x)`) and `frontendAppIds`

Commands: `npm run generate:apps` regenerates; `generate:apps:check` (wired into `npm run check`) regenerates in memory and fails if the committed files are stale.

### Scaffolding

```bash
npm run create:app -- my_app "My App"
```

`scripts/create-app.ts` copies `apps/_template/`, writes backend and frontend stubs, and runs `generate:apps` automatically. The scaffold's `apps/_template/README.md` is copied into the new app as a step-by-step guide.

### Manual frontend wiring

Three registrations live in shared frontend files and must be done by hand:

1. **Icon and accent**: add entries to `APP_ICONS` and `APP_ACCENTS` in `frontend/src/shared/ui/appIcons.ts` (used by navigation, App Center, and Dashboard; fallbacks are `"apps"` icon and no accent).
2. **Accent token**: add a `[data-app="<id>"] { --app-accent: var(--px-…); }` scope in `frontend/src/styles/tokens.css` so anything inside the app route can use `var(--app-accent)`.
3. **New glyph (only if needed)**: if no existing icon fits, add a 16×16 pixel glyph to `pixelIcons` in `frontend/src/shared/ui/icons.tsx` — `IconName` is `keyof typeof pixelIcons`.

## App lifecycle

Startup order in `backend/src/main.ts` + `backend/src/core/platform.ts`:

1. Database connect, then **core migrations** (`migrations/core` → schema `core`).
2. `registry.init()` — scan manifests, reconcile with persisted state in `core.apps`, persist records.
3. Mount app API routes: every compiled backend module gets a Fastify plugin scoped to `/api/apps/<id>` with an `onRequest` **lifecycle guard**.
4. `beforeActivation()` — run migrations for **all installed apps** (enabled or disabled), in ascending id order (`backend/src/core/database/startup-migrations.ts`).
5. Activate every app whose status is `enabled`: `registerEvents` then `registerJobs`; `scheduler.start()`.

Key behaviors:

- **Guard, not unmount**: the `lifecycleGuard` in `backend/src/core/platform.ts` answers 404 for any app whose status is not `enabled` (disabled, error, anything else). Routes are never unregistered, so enable/disable is instant and needs no restart.
- **Enable/disable API**: `PUT /api/core/apps/:id/enabled` with `{ enabled: boolean }` (`backend/src/core/api/routes.ts`). Enabling at runtime first applies that app's pending migrations (`migrateApp`), then activates it — activation never runs against an outdated schema.
- **Activation failure**: any throw in `registerEvents`/`registerJobs` (or migration failure during enable) calls `registry.markError` and releases the app's owner-tagged subscriptions and jobs. The app shows `enabled=true, status=error` in App Center with a **Retry** button (`frontend/src/shell/AppCenter.tsx`).
- **`enabled` vs `status`**: `enabled` is the user's intent (persisted in `core.apps.enabled`); `status` is the actual runtime state (`enabled` / `disabled` / `error`). A failed activation keeps the intent so a retry can succeed. The historical `"installed"` status value is type-compat only and never produced.
- **Disable ≠ uninstall**: disabling stops API (404), events, and jobs, but keeps the schema and all data; the app's migrations keep running on future startups. There is no uninstall and no rollback.

## Backend module contract

Defined in `backend/src/core/app-registry/types.ts`:

```ts
interface BackendAppModule {
  id: string;
  registerApi(ctx: AppContext): Promise<void>;          // required
  registerEvents?(ctx: AppContext): Promise<Unsubscribe[]>; // optional
  registerJobs?(ctx: AppContext): Promise<JobHandle[]>;     // optional
  healthcheck?(ctx: AppContext): Promise<AppHealth>;        // optional
}
```

`registerApi` runs at platform assembly (before `app.ready()`); a throw marks the app `error` but never crashes Core or other apps. `registerEvents`/`registerJobs` run only on activation of an enabled app. `healthcheck` backs `GET /api/core/apps/:id/health` (404 when not enabled; 503 when the check throws or reports `error`).

`AppContext` is the entire controlled surface:

| Member | What it is |
|---|---|
| `appId` | The app's own id |
| `config` | Contents of `config/apps/<id>.yaml` (empty object when absent) |
| `log` | Child logger tagged `{ app: appId }` |
| `api` | Fastify instance already scoped to `/api/apps/<id>`, behind the lifecycle guard |
| `database` | `DatabaseContext`: `query(text, params)` and `withTransaction(fn)` (`backend/src/core/database/index.ts`) |
| `storage` | Local storage driver rooted at `<storageRoot>/apps/<appId>` (`backend/src/core/storage/local.ts`) |
| `events` | App-scoped event bus facade (`backend/src/core/events/index.ts`) |
| `scheduler` | App-scoped scheduler facade (`backend/src/core/scheduler/index.ts`) |
| `time` | Platform time service (`backend/src/core/time/index.ts`) |

Contexts are built by `createAppContext` in `backend/src/core/app-registry/context.ts`.

## Migrations

- Location and naming: `apps/<id>/migrations/<YYYYMMDDHHMMSS>-<name>.sql` (forward-only, plain SQL).
- Create stubs with `npm run migration:create -- --scope <id> --name add_items` (`backend/src/cli/migrate.ts`); apply with `npm run migration:up`; inspect with `npm run migration:status`.
- **Write bare table names** (`CREATE TABLE items (...)`). The runner (`backend/src/core/database/migrate.ts`, node-pg-migrate) runs each app as its own target: it creates the `<id>` schema and a separate `<id>.migrations` record table, wraps each run in `singleTransaction`, and enforces `checkOrder`. In backend request code, qualify as `<id>.items`.
- **Migrations follow installation, not enablement.** Every installed app's migrations run at startup (ascending id order), disabled apps included, so a runtime enable can never activate against an outdated schema and data is never rolled back.
- Core migrations (`migrations/core`, schema `core`) always run first and are owned by the platform — apps never touch them.

Operational detail (advisory locks, failure modes, backup/restore) is in [`MIGRATION_RUNBOOK.md`](MIGRATION_RUNBOOK.md).

## Capabilities

The four manifest booleans gate real service access (`backend/src/core/app-registry/context.ts`):

| Capability | Grants |
|---|---|
| `database` | A working `ctx.database` |
| `storage` | A working `ctx.storage`, rooted at `storageRoot/apps/<appId>` (path-traversal and symlink escapes rejected by the driver) |
| `scheduler` | A working `ctx.scheduler` |
| `events` | A working `ctx.events` |

A service the manifest does not declare is still present on the context (uniform API shape) but backed by a facade that throws `CapabilityError` on any use; the error handler maps it to `capability_error` with a message naming the missing grant. `ctx.api`, `ctx.log`, `ctx.config`, and `ctx.time` are always available. Declare only what the app uses — the defaults are all `false`.

## API conventions

- Validation: Fastify v5 JSON Schema on every write (and on list querystrings). Validation failures map to `400 validation_error`.
- Domain failures: `throw new AppError(statusCode, code, message, details?)` (`backend/src/core/api/errors.ts`). Every error surfaces as `{ error: { code, message, requestId, details? } }`.
- PostgreSQL constraint violations are mapped by hand at the call site — precedent: unique violation `23505` → `422 category_name_taken` in `backend/src/apps/assets/index.ts`. Keep these mappings explicit and give them stable codes.
- Method and shape conventions (mirrored in [`DEVELOPMENT.md`](DEVELOPMENT.md)): lists are `{ items: [...] }`, updates use PATCH, nullable semantics are absent = keep / explicit `null` = clear / value = update, `sortBy` goes through an in-code allowlist that maps to column names (never interpolate request values into SQL), DATE crosses the API as `YYYY-MM-DD`, timestamptz as ISO UTC.
- Response casing: the DB layer speaks snake_case; the response layer converts. New apps should return camelCase at the view boundary — precedent: `toSave(row)` in `backend/src/apps/mini_game/index.ts` mapping `high_score`/`updated_at` to `highScore`/`updatedAt`.
- App APIs are always under `/api/apps/<id>` and always behind the lifecycle guard — no auth layer exists in V1 because the platform is single-user self-hosted.

## Events

`ctx.events.publish(type, payload, source)` / `ctx.events.subscribe(type, handler)` — the in-process bus in `backend/src/core/events/index.ts`.

- Event type names are **enforced**: `<app_id>.<entity>.<action>.v<N>`. Publishing anything else throws immediately (examples in the wild: `tasks.task.completed.v1`, `assets.item.created.v1`).
- Semantics: purely in-process, asynchronous handlers, no persistence, no replay, at-most-once observer isolation (a failing subscriber is logged, the publisher is unaffected). Treat events as notifications, not as a data pipeline.
- Subscribing requires the `events` capability and belongs in `registerEvents`: subscriptions made through the app facade are owner-tagged with the appId so Core can reclaim them wholesale on disable/re-enable — even when a previous activation threw halfway.

## Scheduler

`ctx.scheduler.register({ id, schedule, run })` (`backend/src/core/scheduler/index.ts`). Job ids are conventionally `<app_id>.<job>`. Schedule variants:

```ts
{ cron: "0 * * * *", timezone: "Asia/Shanghai" }  // cron needs a valid IANA timezone
{ intervalMs: 60_000 }
{ onceAt: new Date(...) }
{ onceAfterMs: 1_000 }                             // e.g. a post-boot sweep
```

Precedent: the assets app registers an hourly `cron` reconcile job plus a `onceAfterMs` boot sweep (`backend/src/apps/assets/index.ts`).

Guarantees and limits:

- Purely in-memory, single process. Jobs are re-registered on every restart; **missed runs are not caught up**. Correctness must never depend on precise triggering — jobs should be idempotent reconcilers over durable state (see the assets cleanup queue), not the only write path.
- Registering an already-registered id throws (stop it first). Jobs only run while the app is enabled; `stopByOwner` removes them on disable.

## Time

All calendar reasoning must go through `ctx.time` (`backend/src/core/time/index.ts`):

- `now()`, `timezone()`, `todayRangeUtc()` — the user's local "today" as a UTC `[start, end)` range, DST-safe (23h/24h/25h days are exact).
- The platform timezone comes from `config/platform.yaml` (`platform.timezone`, IANA name only — offsets like `UTC+8` are rejected) and is overridden live by the persisted setting `platform.timezone`: `PUT /api/core/settings/platform.timezone` validates and hot-applies it (`backend/src/core/platform.ts`).
- Never derive "today" from SQL (`due_at::date = CURRENT_DATE` uses the server timezone) and never build app-local timezone helpers. Precedent: the tasks summary computes today via `ctx.time.todayRangeUtc()` (`backend/src/apps/tasks/index.ts`); cron jobs pin `timezone: ctx.time.timezone()`.
- Tests inject a fixed clock through `createPlatform({ clock })` — see `buildTasksPlatform(clock)` in `backend/test/integration/timezone.test.ts`.

## Isolation rules

Statically enforced by `backend/test/unit/isolation.test.ts`, which scans every `backend/src/apps/**.ts`:

- No importing `pg`, no constructing pools — database access only via `ctx.database`.
- No importing core database internals (`../../core/database/...`) — only the `AppContext` surface.
- No importing other apps (`../../apps/<other>`).
- Any schema-qualified SQL reference (`FROM x.`, `INTO x.`, `UPDATE x.`, `TABLE x.`, `JOIN x.`) must reference the app's **own** schema name only.

Write to your own schema, read platform state only through Core APIs. These rules are what keeps apps independently enable/disable-able.

## App settings ownership

Frozen V1 decision — platform settings and app settings are strictly separated:

- `core.settings` (the `/api/core/settings/*` API) stores **platform-level preferences only**: keys such as `dashboard.widgets` (dashboard layout), `apps.presentation` (per-app nickname/accent), `platform.timezone`. The dashboard and the shell own these; apps must not read or write them.
- **App business settings live in the app's own schema.** The pattern: a migration creates a settings table (a single-row table keyed by a fixed id is usually enough), the backend module exposes its own `GET/PUT /api/apps/<id>/settings` routes with JSON Schema validation and app-level checks, and the app frontend reads/writes those routes like any other resource.
- Rationale: `AppContext` exposes no settings service, and the isolation rules forbid apps from touching the `core` schema — so `core.settings` is not an option even if it looked convenient.
- Deferred to V1.1 (do not build speculatively): once at least two apps need it, consider a minimal Core extension `ctx.settings` reading/writing an `apps.<id>.*` namespace. Also deferred: auto-start ordering for apps.

## Dashboard widgets

Widgets are declared twice and must agree: `widgets[]` in `apps/<id>/app.yaml` and `WidgetDefinition[]` in the `FrontendAppModule` (`frontend/src/shared/appTypes.ts`). The full frontend contract:

```ts
interface AppRoute {
  path: string;      // relative to the app root; "" is the app index
  label: string;
  element: ReactNode;
}

interface FrontendAppModule {
  id: string;
  routes: AppRoute[];
  widgets?: WidgetDefinition[];
}

interface WidgetDefinition {
  id: string;      // must match a widget id in app.yaml
  title: string;
  href?: string;   // deep link for card clicks; defaults to the app route
  render: () => ReactNode;
}
```

The shell combines the manifest `frontend.route` with each module's route paths to build real URLs (`frontend/src/shell/routes.ts`). Rendering rules (`frontend/src/shell/Dashboard.tsx`):

- Each widget fetches its own data (e.g. `TasksTodayWidget` calls `/api/apps/tasks/summary` via `useAsync`). The dashboard is a pure container.
- In normal mode the **whole card navigates** to `href`/the app route. Clicks on interactive descendants — `button, a, input, select, textarea, label`, via `isInteractiveTarget` — are intercepted and do **not** navigate. Interactive widgets can therefore use plain native buttons inside the card. Keyboard activation (Enter/Space) applies the same guard.
- There is no polling and no SSE. A widget that must stay fresh decides its own strategy (refetch on visibility, cross-tab notifications, manual reload buttons); existing widgets expose a Retry button on error.
- Every widget renders inside its own error boundary; one broken widget cannot take down the dashboard. Visible set and order persist in `core.settings` under `dashboard.widgets`.
- Widgets only exist for enabled apps: the shell intersects compile-time modules with `GET /api/core/apps` (`frontend/src/shell/routes.ts`).

## platformApiVersion

`GET /api/core/platform` returns `platformApiVersion: 1` alongside the platform name, environment, and timezone (`backend/src/core/api/routes.ts`; asserted in `backend/test/integration/platform-api.test.ts`).

- Meaning: the response contract described by this document — Manifest v1 plus the `BackendAppModule`/`FrontendAppModule` contracts, the `AppContext` surface, capability gating, and the isolation rules. Clients and tools can branch on it.
- Bump rule: increment only on a **breaking** contract change (a manifest field apps must stop sending, a removed/renamed context service, a changed error envelope). Additive changes (a new optional field, a new capability flag) do not bump. Any bump must be reflected here and in the version-pinning test in `backend/test/integration/platform-api.test.ts` in the same change.

## Testing

| Layer | Location / runner | Notes |
|---|---|---|
| Backend unit | `backend/test/unit/`, `node:test` via `npm test` | No database: manifest, scanner, config, errors, storage paths, events, scheduler, time, isolation static checks |
| Backend integration | `backend/test/integration/`, `node:test` via `npm run test:integration` (needs PostgreSQL) | `platform.app.inject(...)` against `buildFixturePlatform`/`withFixturePlatform` (`backend/test/helpers/platform.ts`), DB reset via `resetDatabase`, injectable `clock` |
| Frontend unit | `frontend/src/**/*.test.tsx`, Vitest + @testing-library via `npm test` | `vi.stubGlobal("fetch", fetchMock)` — see `frontend/src/shell/AppCenter.test.tsx` |
| E2E | `frontend/e2e/`, Playwright via `npm run e2e` | Real backend; full lifecycle and persistence flows |
| Acceptance | `scripts/verify.sh` via `npm run verify` | Install → generate → check → build → tests → migrations → boot → smoke |

Integration-test requirement: a new app with a schema must be added to `APP_SCHEMAS` in `backend/test/helpers/db.ts` so `resetDatabase()` drops and re-creates it. Fixture apps that ship migrations register theirs via `registerTestSchemas(...)`.

## Adding a new app: checklist

1. `npm run create:app -- <id> "Name"` — scaffolds `apps/<id>/`, backend and frontend stubs, runs `generate:apps`.
2. Edit `apps/<id>/app.yaml`: description, widgets, capabilities (only what you use), keep `frontend.route` under `/<id>`.
3. Write the first migration: `npm run migration:create -- --scope <id> --name init`, edit the SQL (bare table names), apply with `npm run migration:up`.
4. Implement `backend/src/apps/<id>/index.ts`: `registerApi` with JSON Schema validation and `AppError` mapping; optional `registerEvents`/`registerJobs`/`healthcheck`.
5. Implement `frontend/src/apps/<id>/index.tsx`: `routes` (path `""` is the app home) and optional `widgets` (ids matching the manifest).
6. Register frontend UI metadata: `APP_ICONS`/`APP_ACCENTS` in `frontend/src/shared/ui/appIcons.ts` and a `[data-app="<id>"]` accent in `frontend/src/styles/tokens.css`; add a glyph in `frontend/src/shared/ui/icons.tsx` only if needed.
7. If the app has a schema, add it to `APP_SCHEMAS` in `backend/test/helpers/db.ts`; add unit/integration/e2e coverage.
8. **Sync `scripts/verify.sh`**: the acceptance script hardcodes the expected app list (`expect = ["assets", "focus", "mini_game", "tasks"]`). A new app must be added there or verify fails.
9. Verify: `npm run check && npm test && npm run test:integration` (full acceptance: `npm run verify`).
