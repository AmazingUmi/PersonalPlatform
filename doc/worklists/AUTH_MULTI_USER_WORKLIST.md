# AUTH_MULTI_USER_WORKLIST

Authentication + multi-user data isolation for PersonalPlatform.

## Objective

Introduce a formal Identity Boundary: server-side session authentication in
Core, `user_id` ownership on all user business data, user-scoped queries in
every App, user-isolated storage, and user-preserving events/scheduler —
without breaking App Contract V1, the frozen Core boundaries, or any existing
guaranteed behavior (lifecycle, registry, capabilities, migrations, CI).

Hard invariant: **User A can never read, mutate, or delete User B's data**, and
the guarantee is enforced by the backend (SQL `user_id` predicates + storage
rooting), never by the frontend.

## Current-state audit (gap)

- Platform is single-user by construction: no `core.users`, no sessions, no
  auth guard. All `/api/apps/*` and `/api/core/*` routes are public.
- `AppContext` (`backend/src/core/app-registry/context.ts`): appId, config,
  log, api, database, storage (rooted `storage/apps/<appId>`), events,
  scheduler, time. Built once per app at assembly, not request-scoped.
- App tables have no ownership columns: `notes.notes/tags/note_tags`,
  `tasks.tasks`, `assets.categories/items/item_categories/attachments/
  cleanup_jobs`, `focus.sessions/settings`, `clock.settings/alarms/
  world_clocks`, `mini_game.saves`. Several global uniques are wrong for
  multi-user: `notes.tags UNIQUE(name)`, `assets.categories UNIQUE(name)`,
  single-row settings PKs (`focus.settings`, `clock.settings`,
  `mini_game.saves` keyed by fixed id `'current'`), and the global one-active
  partial index `focus.sessions_one_active_idx ON ((1)) WHERE …`.
- Storage: only `assets` uses `ctx.storage` (keys `attachments/<itemId>/
  <attachmentId>` under `storage/apps/assets/`). Driver already rejects
  traversal/symlink escapes.
- Events carrying user data (`tasks.task.completed.v1`,
  `tasks.task.overdue.v1`, `assets.item.created.v2`, `focus.session.*.v1`,
  `mini_game.highscore.beaten.v1`) have no `userId`. No cross-app subscribers
  exist today; the only cross-app read is Clock's HTTP consumption of
  `GET /api/apps/tasks/public/status` ("public" = stable cross-app read
  contract, currently implicitly global).
- Scheduler jobs are global sweeps: `tasks.overdue_check` (daily) and
  `assets.storage_reconcile` (+boot sweep) iterate all rows with no user
  dimension.
- Frontend: no auth; `shared/api.ts` is same-origin fetch (cookies would flow
  automatically); e2e + integration tests call APIs unauthenticated.
- `core.settings` semantics today: platform-level preferences
  (`dashboard.widgets`, `apps.presentation`, `platform.timezone`) — stay
  platform-level per spec §16/§17 (no `core.user_apps`, no per-user app
  enable, no per-user settings refactor in this batch).

## Architecture decisions

### AD-1 Auth lives in Core only

New `backend/src/core/auth/` module:

- `passwords.ts` — Argon2id via `@node-rs/argon2` (prebuilt native bindings
  incl. musl for the alpine Docker images; maintained; fails closed).
- `sessions.ts` — 32-byte random base64url token (crypto.randomBytes); DB
  stores only `sha256(token)` hex; expiry 30d; `last_seen_at` refresh
  throttled; deleted row = instantly invalid session.
- `service.ts` — `login`, `logout`, `resolveSession` (join sessions+users,
  status/role checks), `ensureBootstrapAdmin`, `createUser`, `listUsers`.
- `routes.ts` — `POST /api/core/auth/login`, `POST /api/core/auth/logout`,
  `GET /api/core/auth/me`, plus admin-only `GET/POST /api/core/auth/users`
  (minimal real-multi-user surface; no update/delete — deferred).
- `guard.ts` — `onRequest` hooks: `requireAuth` (401) and `requireAdmin`
  (401/403-on-role… see AD-4 for the 404-vs-403 note: auth failures are 401,
  non-admin on admin surface is 403 — these are platform-management routes,
  not user resources, so 403 does not leak per-user object existence).

Cookies: `pp_session`, HttpOnly, SameSite=Lax, Path=/, Secure when
`config.platform.environment === "production"`. Login mints a fresh token per
login (fixation), unknown-username and wrong-password are the same 401
(verify against a dummy hash when the user is absent to equalize timing), and
a small per-process sliding-window limiter throttles login attempts.

CSRF: SameSite=Lax covers all state-changing methods (they are never GET);
documented as the CSRF stance for this phase.

### AD-2 Data model: shared schema + row-level ownership

New core migration `migrations/core/20260916000001-users-sessions.sql`:

- `core.users` (id, username UNIQUE, password_hash, display_name, role,
  status, created_at, updated_at, last_login_at)
- `core.sessions` (id, user_id FK CASCADE, token_hash UNIQUE, created_at,
  expires_at, last_seen_at) + indexes on user_id and expires_at.
- Seed **one placeholder bootstrap admin** (`username='admin'`,
  `password_hash='!bootstrap-pending'` — not an argon2 hash, login
  impossible until activated). This makes every environment (fresh install,
  upgrade, test DB) deterministically own exactly one user before app
  migrations run, so app backfills have a stable target; it also satisfies
  "never hardcode a working password in a migration".

App migrations (one per app, forward-only, inside the existing runner):
add nullable `user_id uuid` → backfill from
`(SELECT id FROM core.users ORDER BY created_at LIMIT 1)` → verify no NULLs
→ `SET NOT NULL` → `REFERENCES core.users(id) ON DELETE CASCADE` → fix
uniques/indexes:

| Table | Ownership | Constraint changes |
|---|---|---|
| notes.notes | user_id | index (user_id, occurred_at DESC) |
| notes.tags | user_id | UNIQUE(name) → UNIQUE(user_id, name); upsert ON CONFLICT target updated |
| notes.note_tags | none (derived via parents) | queries scope through owned notes/tags |
| tasks.tasks | user_id | indexes (user_id, status), (user_id, due_at) |
| assets.categories | user_id | UNIQUE(name) → UNIQUE(user_id, name); seeded rows backfilled to bootstrap admin |
| assets.items | user_id | index (user_id, created_at DESC) |
| assets.item_categories | none (derived) | queries scope through owned items/categories |
| assets.attachments | user_id (direct — cleanup queue needs it after item rows change) | index (user_id, item_id) |
| assets.cleanup_jobs | user_id (delete_storage must resolve the storage scope) | index (user_id, status, created_at) |
| focus.sessions | user_id | `sessions_one_active_idx` → `ON (user_id) WHERE status IN ('running','paused')` |
| focus.settings | user_id | PK (id) → PK (user_id, id) |
| clock.settings | user_id | PK (id) → PK (user_id, id) |
| clock.alarms | user_id | index (user_id) |
| clock.world_clocks | user_id | index (user_id, sort_order) |
| mini_game.saves | user_id | PK (id) → PK (user_id, id) |

App runtime code never references `core.*` in SQL (isolation test stays
green): ownership is the app's own `user_id` column; FKs to core.users exist
only in migration DDL.

### AD-3 Auth context for Apps (additive Contract extension)

`AppContext` gains `auth: AuthService` (always available, like api/log/time —
no capability flag, identity is not opt-in):

```ts
interface AuthUserView { id: string; username: string; displayName: string | null; role: "admin" | "user" }
interface AuthService {
  user(request: FastifyRequest): Promise<AuthUserView | null>;
  requireUser(request: FastifyRequest): Promise<AuthUserView>; // 401 AppError
  requireRole(request: FastifyRequest, role: "admin"): Promise<AuthUserView>;
}
```

The global guard resolves the session once per request and decorates
`request.user`; `ctx.auth` reads it (apps never touch cookies/core.sessions).
`platformApiVersion` stays 1 (additive change per doc bump rule).

### AD-4 Guard placement

Per-app plugins (`/api/apps/*`): `onRequest` order **lifecycle guard → auth
guard** → handlers. Enabled app + unauthenticated → 401; disabled app → 404
(existing behavior preserved). Cross-app read contract
`/api/apps/tasks/public/status` keeps its path; it is now authenticated and
user-scoped (per-user current/next/remaining).

Core routes: public = `/api/core/health/*`, `/api/core/auth/login`,
`/api/core/platform`, `/api/core/time` (login page needs platform identity;
no user data). Authenticated-any-user = `GET /api/core/apps`,
`/api/core/auth/logout`, `/api/core/auth/me`. Admin-only =
`PUT /api/core/apps/:id/enabled`, `GET /api/core/apps/:id/health`,
`GET/PUT /api/core/settings/:key`, `GET/POST /api/core/auth/users`
(deployment management surface; keeps platform-level semantics of §16/§17).

### AD-5 Storage isolation

`Storage` interface gains `forUser(userId: string): Storage`. The app-scoped
`ctx.storage` remains app-rooted (`storage/apps/<appId>`); user data uses
`ctx.storage.forUser(userId)` rooted at `storage/users/<userId>/apps/<appId>/`
(uuid-validated before path join; all existing traversal/symlink protections
inherited; the capability-denied facade gains a throwing `forUser`).

One-time legacy file move (code path in Core, invoked from `main.ts` after
core migrations + bootstrap, before app migrations): if
`storage/apps/assets` exists and marker `core.settings['platform.storage.userscope.v1']`
is unset → move files to `storage/users/<bootstrapUserId>/apps/assets/`
(per-file rename, overwrite-tolerant, idempotent) → set marker. Assets
handlers write/read/delete attachments exclusively through `forUser`;
cleanup jobs carry `user_id` and resolve the scope explicitly.

### AD-6 Events & scheduler user boundary

User-data event payloads gain `userId` (additive field on the existing `.v1`
types; no in-repo subscribers today, documented in APP_DEVELOPMENT).
Jobs stay platform-registered sweeps but iterate rows with explicit
`user_id` and scope every mutation/publish to it: `tasks.overdue_check`
publishes `tasks.task.overdue.v1 { userId, … }` per user's task;
`assets.storage_reconcile` reconciles per (user_id, attachment) and deletes
through `forUser(row.user_id)`. No implicit "current user" anywhere.

### AD-7 Bootstrap admin

Shared function `ensureBootstrapAdmin({ database, username?, password?, log })`
used by (a) `main.ts` startup when `BOOTSTRAP_ADMIN_USERNAME` /
`BOOTSTRAP_ADMIN_PASSWORD` env are set, and (b) new CLI
`npm run bootstrap:admin` (`backend/src/cli/bootstrap-admin.ts`, reads
env or hidden stdin prompt). Rules: if no activated user exists →
create/activate the requested account (renaming the placeholder if it is
still pending); if the account already exists and is activated → no-op
(**never resets a live password**); passwords are never logged and never
committed. `.env.example` + compose files gain the two variables (empty by
default — no secrets in git).

### AD-8 Frontend

- `shared/api.ts`: same-origin fetch stays (cookies flow by default; no
  `credentials` config needed); add `login/logout/fetchMe`; on any 401 from a
  non-auth endpoint dispatch `pp:unauthorized`.
- New `shell/AuthContext.tsx` (session bootstrap via `GET /me`, provider,
  `useAuth`), `shell/LoginPage.tsx` (pixel/terminal style from the existing
  design system only), protected shell (unauthenticated → `/login`, return
  path preserved), TopBar user display + logout, 401 → re-login redirect.
- Settings page gains an admin-only Users panel (list + create) backed by the
  admin API.
- E2E: playwright storageState setup logs in via the bootstrap account;
  existing specs keep working; new auth spec covers login/logout/401 flow.

## Task breakdown (phases)

### AUTH-1 Core authentication (backend)

1. Deps: `@node-rs/argon2`, `@fastify/cookie` (backend workspace).
2. Core migration `20260916000001-users-sessions.sql` (+ placeholder admin).
3. `core/auth/{passwords,sessions,service,routes,guard}.ts`; register cookie
   plugin + auth routes + core-route guards in `platform.ts`; core session
   cleanup job on the platform scheduler.
4. `ensureBootstrapAdmin` + env startup wiring in `main.ts` + CLI
   `bootstrap:admin` + root package.json script.
5. Update ALL backend integration tests to authenticate (login helper in
   `test/helpers/platform.ts`); new `test/integration/auth.test.ts`
   (login success/wrong password/unknown user/logout/me/expired/invalid
   session/cookie flags/rate limit) + admin-route protection assertions.
6. Update `scripts/verify.sh` smoke (bootstrap env + cookie login).

### AUTH-2 Ownership infrastructure

1. `AuthService` on `AppContext` (+ types, context wiring, docs table entry).
2. `Storage.forUser` (interface, local driver, capability facade).
3. Auth guard ordering on `/api/apps/*` (lifecycle → auth).

### AUTH-3 App ownership migrations + user-scoped queries

Per app (notes, tasks, assets, focus, clock, mini_game — each its own
commit-able slice: migration + handler scoping + tests):

1. Migration per AD-2 table.
2. Handlers: `ctx.auth.requireUser(request)` → thread `user.id` through every
   query (list/get/patch/delete/summary/upsert/public); 404 (not 403) for
   foreign ids; unique-violation mapping per-user; junction reads scoped via
   owned parents; events gain `userId`.
3. Two-user isolation integration test per app (A/B create → list own only;
   A get/patch/delete B's id → 404).
4. Upgrade-path regression: pre-insert single-user rows → run migrations →
   rows owned by bootstrap admin (covered per app + a dedicated
   `test/integration/auth-migration.test.ts` running the real repo migration
   files against a seeded legacy schema).

### AUTH-4 Storage + scheduler + admin API

1. Assets attachments through `forUser`; cleanup_jobs user_id; reconcile
   sweeps per-user; legacy file move routine + tests.
2. `tasks.overdue_check` per-user publish (fixed clock test).
3. Core settings/apps-management admin guard (+ tests for 403/401).
4. Admin users API (GET/POST /api/core/auth/users) + tests.

### AUTH-5 Frontend authentication

1. api.ts auth client + 401 event; AuthContext; LoginPage; protected App
   shell; TopBar user + logout; Settings Users panel (admin).
2. Frontend unit tests updated (fetch mocks answer `/me`) + new tests.
3. Playwright: storageState login setup; all specs run authenticated; new
   auth e2e spec; playwright webServer env gains bootstrap vars.

### AUTH-6 Verification, docs, template

1. Docs: README (login/bootstrap), DEVELOPMENT, APP_DEVELOPMENT (ownership
   chapter: user-owned tables, ctx.auth, storage.forUser, jobs/events userId,
   cross-app boundary), MIGRATION_RUNBOOK (upgrade path), architecture doc,
   `.env.example`, docker-compose files.
2. `apps/_template` + `scripts/create-app.ts` scaffold user-owned-by-default
   (template README + example migration note).
3. Full gates: `npm run check`, `npm test`, `npm run test:integration`,
   `npm run build`, `npm run e2e`, `./scripts/verify.sh`, `git diff --check`.
4. Independent final-reviewer pass; AUTH-GATE-01..10 matrix.

## Dependencies

AUTH-1 → AUTH-2 → AUTH-3 (per-app parallelizable) → AUTH-4 → AUTH-5 → AUTH-6.
Frontend AUTH-5 depends only on AUTH-1's API surface (could overlap AUTH-3/4).

## Allowed file scope

- Core: `backend/src/core/**` (new auth module; minimal edits in platform.ts,
  main.ts, storage, app-registry types/context, api/routes.ts),
  `migrations/core/**`, `backend/src/cli/**`, `backend/test/**`,
  `scripts/verify.sh`, root `package.json` (script + deps), `.env.example`,
  `docker-compose*.yml`, `docker/*.yml`.
- Apps: `apps/*/migrations/**`, `backend/src/apps/**`, per-app frontend files
  only when auth-flow requires (TopBar/Settings/App shell).
- Docs: `doc/**`, `apps/*/README.md`, `frontend/e2e/**`.

## Amendments after reviewer checkpoint (PASS-WITH-NOTES)

1. **Legacy storage move is fatal-before-activation** (P2-1): the one-time
   file move runs in `main.ts` after bootstrap and before
   `createPlatform`/activation; any failure `process.exit(1)` (core-migration
   precedent). This prevents the assets boot reconcile
   (`onceAfterMs: 1_000`) from dropping metadata for files still living at
   the legacy path. The move stays overwrite-tolerant + marker-gated for
   crash-retry idempotency; a regression test covers the failure path.
2. **Event payload evolution rule** (P2-2): AUTH-6 documents the general
   contract in APP_DEVELOPMENT.md — additive payload fields are allowed
   within an existing `.vN`; renames, removals, or semantic changes require a
   new `.vN`. This batch's `userId` additions are additive under that rule.
3. **Backfill determinism** (P2-3): `ORDER BY created_at, id`; each app
   migration raises a clear error if any row is still NULL after backfill
   (catches "no users exist but data rows do"); `ensureBootstrapAdmin`
   **repurposes the pending placeholder row** (rename + set hash + display
   name, id stable) instead of inserting a second user while the placeholder
   is pending — it only inserts when the platform is already bootstrapped and
   the requested username is simply missing. Migration comments note the
   pattern is valid only for single-user→multi-user upgrades.
4. Constraint drops use real names with `IF EXISTS` (e.g.
   `categories_name_key`); settings/saves upserts update conflict targets to
   `(user_id, id)` (focus `repository.ts`, clock settings, mini_game saves) —
   added to the AD-2 table rows.
5. `findActiveSession`/focus repository statements gain explicit `user_id`
   predicates alongside the index change.
6. `apps/tasks/README.md` frozen `/public/status` contract note is updated to
   "authenticated, per-user" in AUTH-6.
7. Password verify fails closed: a malformed stored hash (e.g. the
   `!bootstrap-pending` placeholder) maps to invalid credentials (401),
   never a 500.
8. `POST /api/core/auth/users`: username `^[a-z0-9_-]{3,32}$` (lowercase),
   password min length 8, role fixed `'user'` (only bootstrap creates
   admins); created users own nothing until they log in.

## Amendments recorded after final review (P3 follow-ups applied)

9. **AD-4 refinement:** `GET /api/core/apps/:id/health` and
   `GET /api/core/settings/:key` shipped as authenticated-any-user (not
   admin-only as the AD-4 table implied) — the shell reads the app list,
   app health and layout/presentation settings for every logged-in user,
   while writes stay admin-only. Behavior is covered by auth.test.ts.
10. `POST /api/apps/assets/maintenance/reconcile` is admin-only
    (`ctx.auth.requireRole`) — it sweeps queue state across users.
11. Login timing equalization uses one fixed module-level dummy hash
    (single Argon2 op on the unknown-username path, matching the real path).
12. Amendment 4's "IF EXISTS" wording was stricter than shipped: the
    migrations drop deterministic default constraint names without IF EXISTS
    (safe on both fresh and upgrade replays).
13. The legacy-move failure path has a regression test (obstructed target →
    throw, marker unset → rerun converges).
14. `AGENTS.md` §2 (project state) was updated beyond the enumerated file
    scope to reflect the new platform capability — intentional, recorded here.

## Non-goals (explicit)

- No per-user app enable/disable, no `core.user_apps`, no per-user platform
  settings (dashboard layout stays deployment-level this batch).
- No user delete/update/password-change API, no email/verify flows, no
  MFA/remember-me/OIDC, no RLS rewrite, no per-user DB schemas.
- No cross-app direct table reads; cross-app stays HTTP/event contracts.
- No pagination/version bumps beyond additive event fields.

## Acceptance criteria (AUTH-GATE matrix)

- AUTH-GATE-01 unauthenticated `/api/apps/*` → 401 (enabled apps).
- AUTH-GATE-02/03 A cannot read/mutate B's rows (list single-owner; foreign
  id GET/PATCH/DELETE → 404) across notes/tasks/assets/focus/clock/mini_game.
- AUTH-GATE-04 storage paths per-user; B cannot read/delete A's attachment
  even with guessed ids; traversal protections intact.
- AUTH-GATE-05 `tasks/public/status` reflects only the calling user.
- AUTH-GATE-06 overdue job + reconcile sweep carry per-user ownership;
  events include userId.
- AUTH-GATE-07 legacy single-user DB migrates: all rows → bootstrap admin;
  legacy attachment files move to the user-scoped tree; fresh install clean.
- AUTH-GATE-08 existing regression suites stay green after auth updates.
- AUTH-GATE-09 e2e: login → shell → apps → logout → 401 → re-login.
- AUTH-GATE-10 no plaintext passwords, no raw session tokens in DB, no
  frontend-accessible session secret (HttpOnly cookie only).

## Regression matrix

| Risk | Guard |
|---|---|
| Existing tests break on 401 | login helper + storageState; every suite updated in AUTH-1/5 |
| Upgrade on real data loses rows | backfill + NOT NULL verify inside single-transaction migrations; dedicated upgrade test |
| Fresh install with zero users | placeholder admin row; backfill no-op; login impossible until bootstrap (explicit, logged) |
| Unique collisions after scoping | per-app UNIQUE(user_id, …) + upsert conflict targets updated + name-taken 422 still per-user |
| One-active-session focus invariant | partial index moves to (user_id); concurrent-start test per user + isolation between users |
| Disabled-app 404 semantics | lifecycle guard runs before auth guard; existing lifecycle suites |
| Cookie broken in dev HTTP | Secure only in production env; integration tests run over inject (no TLS) |
| Alpine musl native module | @node-rs/argon2 musl prebuilds; Docker build verified in CI |
| verify.sh / CI smoke | updated to bootstrap + login |
