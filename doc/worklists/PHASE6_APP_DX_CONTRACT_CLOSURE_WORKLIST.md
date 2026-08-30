# Phase 6 — App DX / Contract Closure (FROZEN WORKLIST)

Scope: eliminate "adding an app requires editing the shared base". P0 red lines (App Contract V1,
manifest v1, lifecycle, migration semantics, capability model, owner-scoped cleanup, schema
isolation; no unrelated Core refactors) are absolute. AGENTS.md does not exist in this repo;
all tasks follow the Phase 6 task-brief principles directly. Core source files get ZERO changes.

## 1. Current gaps (verified)

- G1a `scripts/verify.sh:75` — hardcoded `expect = ["assets","focus","mini_game","tasks"]`; any new app fails verify.
- G1b `backend/test/integration/app-contract.test.ts:47-52` — KNOWN_ROUTES requires a per-app edit (and `:61` derives `registerTestSchemas` from its keys, so the coupling is structural).
- G2 `scripts/create-app.ts:97-98`, `doc/APP_DEVELOPMENT.md:104-106`, `:304`, `apps/_template/README.md:123-124` — icon/accent/tokens.css described as required; runtime fallbacks already exist (`appIcons.ts:22-28`, CSS `var(--window-accent, var(--app-accent, var(--px-primary)))`). Wording only.
- G3 `scripts/create-app.ts` — no collision pre-check for `backend/src/apps/<id>` / `frontend/src/apps/<id>`; no reserved-id guard; no empty-name guard; frontend stub not aligned with the `page`/header page convention; not importable (top-level `process.exit`), so untestable.
- G4 No enforcement of `manifest.id == BackendAppModule.id == FrontendAppModule.id` nor of widget-id drift between `app.yaml` and `FrontendAppModule.widgets` (`appTypes.ts:15-17` claims consistency). `generate-apps-registry.ts` only scans file existence, never imports modules.
- G5 No automated test that the scaffold output is contract-valid and repo-clean.
- G6 No "reference implementations" pointer (focus) in `doc/APP_DEVELOPMENT.md`.
- G7 `frontend/e2e/platform.spec.ts` pins the 4-app product surface (nav links, widget titles, App Center list, Settings widget order) — product-release-time friction, by design (see D7).

Verified non-gap: a fresh scaffold creates an empty `apps/<id>/migrations/` dir; `singleAppMigrationTarget` returns a target whenever the dir exists (`startup-migrations.ts:17-19`) and `runMigrations` passes `createSchema: true` (`migrate.ts:54`) — so the per-app schema contract test already passes pre-first-migration. No change needed there.

## 2. Chosen design (rulings)

- **D1 verify.sh app list → dynamic disk scan.** The smoke-test node block derives `expect` from `apps/*/app.yaml` on disk (excluding `_*`/dot dirs), sorted, compared for exact equality with `GET /api/core/apps`; keep the all-enabled assertion. Rationale: verify.sh already ran `generate:apps` (manifest validation) before booting, so disk == registry is sound; exact-match keeps the "no app silently skipped" guarantee with zero per-app maintenance.
- **D2 KNOWN_ROUTES → ping fallback (accept the trade-off).** Probe route becomes `KNOWN_ROUTES[app.id] ?? "/api/apps/<id>/ping"` in the route-probe and lifecycle-guard tests; drop the "requires a KNOWN_ROUTES entry" test; `registerTestSchemas` derives from `scanApps(appsDir)` valid manifests instead of KNOWN_ROUTES keys; lifecycle-guard target prefers an app WITH a KNOWN_ROUTES entry to keep business-route coverage. KNOWN_ROUTES stays for the 4 real apps (pinning business routes); the scaffold contract guarantees `/ping` (create-app stub, enforced by P6-F). Rationale: Phase 6's primary goal is zero shared edits when landing an app; "every app ships a pinned business-route test" transfers to app-owned tests (checklist item 7 already demands coverage). Residual risk accepted: an app that never registers gets only ping-level probing here.
- **D3 UI metadata wording → OPTIONAL everywhere; no CSS/JS change.** Fallbacks (icon `"apps"`, accent → `--px-primary`) already work end-to-end; only create-app Next Steps, APP_DEVELOPMENT manual steps + checklist, and template README reword.
- **D4 create-app hardening + testable export.** Pre-check all three target dirs (`apps/<id>`, `backend/src/apps/<id>`, `frontend/src/apps/<id>`); reject reserved id `core` (collides with the core DB schema); reject empty/whitespace name; frontend stub aligned to the existing page header convention (visual only). Refactor: export `runCreateApp({root, id, name, runGenerate})` (throws `CreateAppError`, no `process.exit` inside); thin CLI wrapper keeps argv parsing, output and exit codes byte-identical. Scripts-layer file, not Core.
- **D5 Contract validator → two-track (checkpoint revision).** Root `scripts/verify-apps.ts` imports ONLY the committed `backend/src/generated/apps.ts` (verified loadable under tsx: backend modules are pure node TS) and checks per valid manifest: backend module presence and `module.id === manifest.id`. The frontend side CANNOT be loaded under tsx — `mini_game/index.tsx` imports `./assets/logo.svg` (verified failure: `Unknown file extension ".svg"`), and the original claim "no asset imports" was wrong. Frontend enforcement therefore lives in a NEW vitest test `frontend/src/shell/app-contract.test.ts`: it imports `frontendAppModules` from `../generated/apps` (the vite pipeline resolves svg imports — proven by `mini_game/index.test.tsx`), reads `apps/<id>/app.yaml` via `fs` + the `yaml` package (hoisted in root node_modules), and asserts `mod.id === manifest.id` plus exact widget-id set equality (`app.yaml` widgets vs `FrontendAppModule.widgets`; catches missing/unknown/duplicate). Both reuses the manifest rules: root script via `scan()` exported from `generate-apps-registry.ts` (no logic duplication); vitest via the same yaml files. Wiring: `check` becomes `generate:apps:check && verify:apps && workspace checks`; the vitest file runs under `npm test` automatically. NOT in `generate:apps` itself (generator stays single-purpose). No static frontend-route check — semanticErrors already pins manifest route prefix, routes are runtime-composed, e2e covers navigation; AST-matching would add brittleness for zero guarantee.
- **D6 Scaffold E2E → unit test against a mkdtemp fixture root.** `backend/test/unit/create-app.test.ts` (node:test, no DB, no server) copies `apps/_template` into a temp root, calls `runCreateApp({root: tmp, runGenerate: false})`, asserts file set + substitutions, manifest validity via `validateManifest`+`semanticErrors`, `/ping` in the backend stub, frontend stub syntax via `ts.transpileModule`, error paths (duplicate/reserved/invalid id, existing dirs) fail before any write, and repo `generated/apps.ts` unchanged (hermetic). Full tsc rejected: a temp root has no tsconfig/workspace deps and repo tsc wouldn't cover it anyway — real integration typing is proven by `npm run check` during the P6-01/P6-H manual exercise. In-repo create+finally-delete rejected: a crashed run pollutes the tree and churns `generated/apps.ts` against parallel checks.
- **D7 e2e stays exact (4-app pins unchanged).** e2e pins the shipped product surface; loosening to ">=4 / contains" guts its regression value for the whole suite. Policy: adding an app in development never requires touching e2e (scaffold E2E does not run business e2e; `npm run e2e` is only expected green on the shipped app set); updating platform.spec.ts is a product-release-time step, documented as such. Known remaining friction, accepted.
- **D8 Focus is documented as the reference implementation; zero focus code changes.**

## 3. File scope

| Task | File | Action |
|---|---|---|
| P6-B | `scripts/verify.sh` | MODIFY (dynamic app list) |
| P6-B | `backend/test/integration/app-contract.test.ts` | MODIFY (D2; test file, not Core source) |
| P6-C | `scripts/create-app.ts` | MODIFY (D3 wording + D4 hardening/export) |
| P6-D | `doc/APP_DEVELOPMENT.md` | MODIFY (optional wiring, checklist rewrite incl. removing item 8, e2e policy) |
| P6-D | `apps/_template/README.md` | MODIFY (optional wording) |
| P6-E | `scripts/verify-apps.ts` | NEW (backend-side id check, tsx) |
| P6-E | `frontend/src/shell/app-contract.test.ts` | NEW (frontend id + widget-drift check, vitest) |
| P6-E | `scripts/generate-apps-registry.ts` | MODIFY (export `scan()`, no behavior change) |
| P6-E | `package.json` | MODIFY (add `verify:apps`; extend `check`) |
| P6-F | `backend/test/unit/create-app.test.ts` | NEW |
| P6-G | `doc/APP_DEVELOPMENT.md` | MODIFY (Reference implementations section) |
| P6-H | (no code; runs acceptance + evidence) | — |

Core files (`backend/src/core/**`, `frontend/src/shared/**`, existing app code): zero changes.
Known limitation kept: root `scripts/*.ts` are not covered by any tsc project (pre-existing);
verify:apps type errors surface at runtime inside `npm run check`.

## 4. Tasks

Batches: **B ∥ C** → **D, E, F** (D after B+C for doc consistency; E, F after C) → **G, H** (G after D, same file; H last).

- **P6-B (worker)** — D1 + D2. Acceptance: with a temp app dir added, verify.sh compares it dynamically (no edit needed); app-contract suite green for an app whose only routes are scaffold `/ping`; KNOWN_ROUTES apps still probed on business routes; `registerTestSchemas` covers all valid manifests on disk.
- **P6-C (worker)** — D4 + D3(create-app side). Acceptance: collision/reserved/empty-name errors list the offending path and write nothing; CLI output/exit codes unchanged vs current behavior (except wording); `runCreateApp` importable without side effects.
- **P6-D (worker)** — D3(docs) + checklist rewrite: item 6 optional, item 8 replaced by "nothing to sync — verify.sh and the contract suite are app-list agnostic", add e2e policy (D7), template README reworded. Acceptance: no doc statement implies icon/accent/tokens are required; checklist matches new reality end to end.
- **P6-E (advanced-worker)** — D5 (two-track). Acceptance: `npm run verify:apps` fails on a seeded backend module-id mismatch and passes on the repo as-is; the vitest contract test fails on seeded frontend id mismatch and on widget-id drift (extra AND missing) and passes as-is; `npm run check` runs verify:apps; `generate:apps` behavior unchanged.
- **P6-F (advanced-worker)** — D6. Acceptance: test green in `npm test` (backend unit), no DB needed, leaves temp dirs cleaned and working tree clean; covers success + all error paths from P6-C.
- **P6-G (worker)** — D6-reference/D8. Acceptance: "Reference implementations" section lists `_template` (minimal) and `focus` (full pattern: manifest + own schema, forward-only migrations, timer.ts pure domain / repository.ts / index.ts layering, ctx.time, events, dashboard widget, useFocusState, revision concurrency, reload recovery, E2E) with file pointers; no code changes.
- **P6-H (worker, last)** — Full acceptance sweep + the P6-01 manual exercise: in the real repo run `npm run create:app -- validation_app "Validation App"`, then `npm run check && npm test && npm run test:integration` — all must be green with `git status` showing ONLY `apps/validation_app/**`, `backend/src/apps/validation_app/**`, `frontend/src/apps/validation_app/**` and `src/generated/apps.ts` (this is the zero-shared-edit proof); then remove them, `npm run generate:apps`, tree clean, suites green again. e2e deliberately NOT run during the exercise (D7). Record command outputs as PR evidence (no report files).

## 5. Regression matrix (must stay green)

| Surface | Guarded by |
|---|---|
| App Contract V1 (api version, manifest<->registry, routes, lifecycle, schemas) | `backend/test/integration/app-contract.test.ts` |
| Tasks / Assets / Mini Game / Focus behavior | workspace unit tests + `frontend/e2e/platform.spec.ts`, `focus.spec.ts`, `ui.spec.ts` |
| Dashboard widgets (4 apps) + Settings widget order | `ui.spec.ts`, `platform.spec.ts` |
| App Center enable/disable + owner-scoped cleanup | `platform.spec.ts`, integration suites |
| Backup/restore | backup/restore integration tests |
| Migrations (forward-only, up/status) | migration integration tests |
| Event/scheduler isolation | `isolation.test.ts`, `scheduler.test.ts` |
| Registry generation + staleness | `generate:apps:check` (now also `verify:apps`) |
| Full local acceptance | `npm run verify` |

Command map (unchanged): `npm run check` (now incl. verify:apps) · `npm test` · `npm run test:integration` · `npm run e2e` (shipped app set only) · `npm run verify` · `npm run create:app`.

## 6. Final acceptance criteria

1. A scaffolded app reaches compile + discover + navigate + enable/disable with **zero edits outside its own app dirs and the generated tables** (P6-H git-status proof).
2. A fresh scaffold passes `npm run check` (incl. verify:apps) and the app-contract integration suite unchanged.
3. `scripts/verify.sh` contains no hardcoded app list; smoke equality is disk-derived.
4. Icon/accent/tokens.css documented as optional with working fallbacks in all three docs.
5. `npm run check` fails on a backend module-id mismatch (verify:apps); `npm test` fails on a frontend module-id mismatch or widget-id drift between manifest and modules.
6. Scaffold E2E automated and hermetic (CI-green, no working-tree pollution); docs carry the updated checklist and reference-implementation pointers.

## 7. Non-goals

- No App Contract V2; no changes to platformApiVersion, manifest v1 semantics, enable/disable lifecycle, migration semantics, capability model, owner-scoped cleanup, schema isolation.
- No runtime/dynamic app loading, no plugin marketplace/packaging, no per-app CI sandbox — those are Phase 7+ questions; Phase 6 keeps compile-time module tables.
- No CSS/design changes, no new pixel glyphs, no loosening of e2e assertions, no unrelated Core refactors, no focus code changes.
- OPEN (default: no): teach `verify:apps` to also assert `hasBackend`/`hasFrontend` flags in generated tables — currently redundant with `generate:apps:check` staleness; revisit only if drift is ever observed.
