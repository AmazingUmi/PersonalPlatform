# UNIFIED_TRASH_WORKLIST

Platform-wide Unified Trash (Recycle Bin) for PersonalPlatform — Batch 1 (prerequisite for `AGENT_INTERFACE_WORKLIST.md`).

> Status: **LOCAL ACCEPTANCE PASSED**. GitHub Actions and merge are tracked in the Batch 1 pull request.

---

## 1. Objective

Introduce a platform-wide, user-isolated **Unified Trash (Recycle Bin)** shared by both Web UI users and future Agent callers, so deleting core business records is reversible within a retention window instead of an irreversible hard delete.

Hard invariants:
1. User A can only list, inspect, restore, or purge their own Trash entries.
2. Core owns Trash metadata and lifecycle. Apps own live schema writes and execute delete and restore through their domain handlers.
3. Settings JSON keeps `formatVersion: 1`. Continuous sync applies normal deletion and insertion semantics to live records, preserves tombstones, and uses its existing conflict-resolution flow.
4. For assets, each committed attachment metadata row resolves to complete bytes. Trash retains its copy until a restore or purge commits. Physical cleanup is recoverable across process restarts.

---

## 2. Current Gap

- Tasks, notes, asset items, and alarms have direct hard-delete routes.
- There is no recovery mechanism short of full-database/JSON backup restore, which makes both human misclicks and upcoming Agent write/delete operations high-risk.
- Asset item deletion drops the item and its attachment rows, then removes live files. It enqueues `assets.cleanup_jobs` when file deletion fails.
- Snapshot export reads the files referenced by its attachment metadata. `record-graph.ts` validates the reconstructed snapshot's record relationships, natural keys, and attachment bytes. `assets.storage_reconcile` probes keys from live attachment rows for missing bytes. These checks do not enumerate unreferenced live files.

---

## 3. Architecture & Data-Model Decisions

### AD-1 Archive-in-Core Trash Store (`core.trash_items`)

Add a forward-only Core migration `migrations/core/<timestamp>-unified-trash.sql`:

- Table `core.trash_items`:
  - `id uuid PRIMARY KEY`
  - `user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE`
  - `app_id text NOT NULL`
  - `entity_type text NOT NULL` (e.g. `'task'`, `'note'`, `'asset_item'`, `'clock_alarm'`)
  - `entity_id uuid NOT NULL`
  - `title text NOT NULL` (human-readable preview label for Trash UI)
  - `summary text` (short excerpt/metadata preview)
  - `payload jsonb NOT NULL` (App-owned versioned snapshot, with relation IDs and fallback metadata per AD-3)
  - `payload_version integer NOT NULL DEFAULT 1`
  - `attachment_keys jsonb NOT NULL DEFAULT '[]'::jsonb` (server-owned mapping from archived attachment ID to Trash key and verified size and SHA-256)
  - `deleted_by_type text NOT NULL CHECK (deleted_by_type IN ('user', 'agent'))`
  - `deleted_by_agent_id uuid`, with a constraint requiring it for Agent deletions and requiring null for user deletions. It is historical attribution independent of Agent lifecycle.
  - `deleted_by_label text NOT NULL` (display label snapshot, e.g. username or Agent name)
  - `deleted_at timestamptz NOT NULL` and `expires_at timestamptz NOT NULL`, set together using the same platform time instant. Apply `TRASH_RETENTION_DAYS` as elapsed 24-hour days. Default 30, valid integers 1–365. Config changes apply to new entries.
- Indexes:
  - `(user_id, deleted_at DESC, id DESC)` for stable Trash listing
  - `(user_id, app_id, deleted_at DESC, id DESC)` for per-App filtering
  - `(expires_at)` for scheduled purge sweep

- Add `core.trash_blob_intents` for durable attachment staging and `core.trash_blob_cleanup` for the cleanup outbox described in AD-4. Both retain the owner UUID through account deletion so recovery can finish. Enqueue Trash-key retirement when a `core.trash_items` row is deleted, including `ON DELETE CASCADE` from `core.users`, in the same transaction. Cleanup data stays outside the Settings JSON snapshot.
- Parse and validate `TRASH_RETENTION_DAYS` at startup. Pass it through development Compose and the shared production runtime used by source and release deployments. Document the default and bounds in all three env templates.

### AD-2 Additive App Contract Extension (`platformApiVersion = 1` unchanged)

- Add `ctx.trash` operations bound to the calling App and a Core-authorized mutation context containing the acting user and server-resolved actor. `moveToTrash` uses the caller's live-deletion transaction to write the archive and enqueue live attachment retirement. The authenticated browser session provides user attribution. Batch 2 may pass a Core-authorized Agent actor and use the same transaction for its authorization check, live mutation, Trash archive, and successful mutation audit. The App supplies domain data and owned attachment descriptors. Core supplies the owner, App ID, attribution, and storage key mapping. These values never come from a client or archived payload.
- Covered Apps expose a shared, transaction-bound delete operation used by browser handlers and available to future Agent tools. Keep existing owner predicates, `lockOwnedTables`, record/relation locks, and `assertPresentedHash(await syncWriteFenced(...), ...)` before staging or mutation. Batch 2 can require a presented hash without changing existing browser behavior. Attachment intent preparation precedes the final authorized transaction, with authorization, ownership, and source identity checked again before the first file write.
- Add optional `restoreFromTrash?(ctx: TrashRestoreContext, entry: OwnedTrashEntry): Promise<{ restoredId: string }>` to `BackendAppModule`. Use a narrowed context carrying the same Core-opened transaction for all App data calls, an attachment staging facade scoped to the owner, App, and claimed entry, and existing App time/log services as needed. Preserve the `database` and `storage` capability gates and the rule that the hook only writes its own App schema. The App validates payload versions and fields using the claimed owner as authoritative. When data is unsupported or validation fails, keep the entry and return a stable error.
- Restore selects by `(user_id, id)` with `FOR UPDATE`, checks expiry after acquiring the lock, then dispatches the hook and deletes the Trash entry in the same transaction. Manual purge, empty Trash, and the expiry sweep claim rows through the same lock. Batch claims use a stable lock order. Only one operation can consume an entry, and missing, foreign, or expired entries return `404` for user-facing single-entry mutations.
- Use actual registry status at dispatch. Disabled Apps return `409 app_disabled`, and error, missing, or hookless Apps return `409 app_unavailable`. Listing and purge remain available for their unexpired entries. Core's retention jobs can reclaim storage regardless of App lifecycle.

### AD-3 First-Wave Covered Entities & Restore Semantics

| App | Entity Type | Archived Payload | Restore Behavior |
|---|---|---|---|
| `tasks` | `task` | Task fields | Restore with a fresh task UUID |
| `notes` | `note` | Note fields and tag IDs, names, and creation times | Restore with a fresh note UUID and relink tags under the new note ID |
| `assets` | `asset_item` | Asset fields, category IDs, names, colors, and creation times, and attachment metadata | Restore with fresh asset and attachment UUIDs, remap category links and attachment parent IDs, and stage bytes under new live storage keys |
| `clock` | `clock_alarm` | Alarm fields | Restore with a fresh alarm UUID |

- A restored item is a new live identity even if its old ID is free or the deletion has yet to sync. The original ID remains archive provenance. Old links and stale edit/delete requests to that ID do not apply to the restored record. The restore response points to the new ID. If a prior import or remote apply has made the original ID live again for the same user, return `409 original_live` and keep the Trash entry. A foreign owner's matching original ID has no effect on the response.
- Restore all archived business fields, including explicit nulls and business timestamps. Set ownership and live IDs from the authorized restore context.
- For each archived taxonomy relation, prefer the user's still-existing original ID, including a renamed row. If it is missing, reuse the user's exact current name match and keep its metadata. If neither exists, create a new UUID from the archived name and metadata, including asset category color. Deduplicate resulting links when different archived references resolve to the same taxonomy row. Keep natural-key changes under the App's existing table/owner lock ordering and unique constraints. A foreign row never qualifies as a match.
- Take the App's normal sync-compatible table locks and applicable owner-set locks for restore. `syncWriteFenced` checks whether normal edits need stale-record proof. Restore inserts fresh live identities and does not reuse old hashes or update any existing live entity.

### AD-4 Attachment Staging, Retirement & Sync

1. **Durable intent before filesystem writes.** Commit a staging intent in a separate short transaction before creating any destination file. Record an operation ID, owner, Trash ID, source mapping, allocated destination and temporary keys, and abandonment deadline. If this first commit is unconfirmed, stop without writing any file. The subsequent mutation transaction locks and validates the intent before use. Recovery takes the same lock before acting and only reclaims abandoned or settled intents, so it cannot sweep a staging operation in progress.
2. **Copy with the source retained.** Under the authorized mutation transaction and the live record locks or Trash entry claim, recheck the sources against the committed intent. Copy into owner- and App-scoped, exclusive keys and verify byte count and SHA-256. Make destination bytes durable before making rows that reference them visible. Trash keys use `storage/users/<userId>/trash/<trashId>/<attachmentId>`. Restored live keys use the new asset and attachment IDs under that owner's `apps/assets/attachments/` directory, outside `sync/`. Check canonical paths and reject descendant symlinks on both sides. Never rename a source out of its current location to stage a destination.
3. **Finalize in one transaction.** Delete commits archive rows, live row removal, live-source retirement outbox entries, and the intent outcome together. Restore commits new live rows and links, Trash row consumption, Trash-source retirement outbox entries, and the intent outcome together. A failed staging operation or confirmed rollback leaves all original references and bytes intact. After an unknown commit acknowledgment, retain both copies and read the intent outcome in a new transaction after the original transaction has settled. A committed outcome authorizes queued retirement. An abandoned or rolled-back outcome allows only unreferenced staged destinations and temporaries to be reclaimed.
4. **Protect readers until the bytes have been read.** Use a shared PostgreSQL-backed attachment-read guard from before the metadata view is chosen through the final byte read. Cover Settings JSON export (own and all), periodic/manual WebDAV backups, continuous sync capture, and Assets paths that read bytes from metadata, including download and unprotected proof/reconciliation reads. For repeatable-read exports/captures acquire the shared session guard on the same checked-out connection before `BEGIN`, release in `finally`, and keep a consistent lock order with existing sync/App locks. Live-source retirement takes the corresponding exclusive guard and checks committed metadata and pending storage work again before unlinking. Add the same protection to the sync staging pruner for `sync/<uuid>` keys, including Trash-owned intents and retirement reservations, because a trashed asset can contain a previously synced-in file. This lets a reader that started before delete complete against its old metadata while later readers see the committed state.
5. **Recover and purge through Core.** `core.trash_purge` runs hourly, claims expired entries (`expires_at <= current instant`) in bounded batches, and removes their metadata using the same entry lock as Restore. Manual purge, empty Trash, and owner-row cascade likewise enqueue Trash-key cleanup in the deleting transaction. A Core startup and recurring sweep handles abandoned stages and committed outbox work. Make unlink idempotent, retry I/O failures with backoff and operator-visible errors, and retire completed jobs. Require a settled transaction and a successful check that the file is unreferenced before irreversible cleanup. Use only server-recorded keys and verified ownership, including when an owner or App no longer exists.

**WebDAV and snapshots.** The Trash tables and blobs stay local and outside `formatVersion: 1` Settings JSON and the continuous sync snapshot. A live deletion can still publish its old sync keys as tombstones. Restore publishes new entity, attachment, and relation keys as inserts. It neither clears tombstones nor bypasses a concurrent peer change. Incoming sync changes apply through existing semantics and do not create local Trash entries. Healthy live metadata and complete staged bytes remain readable during trash, restore, and cleanup.

If a deleted taxonomy row is recreated with a fresh ID and a peer still has an edited row of the same name under the old ID, current sync can keep the remote row and attempt to publish the new row, then reject the duplicate natural key. Within the bound sync identity, extend the existing `natural-key` conflict classification narrowly to this deleted-locally/remote-edited pair. Use the existing held-record/link and conflict-resolution behavior to retain the local replacement and its dependent links, preserve valid outbound snapshots, and converge after either Keep Local or Keep Remote choice. Keep the sync protocol, tombstone behavior, and snapshot schema unchanged.

### AD-5 Core Trash API & Settings UI

Authenticated user-scoped routes under `/api/core/trash` (Cookie session only — never exposed for permanent purge to Agents):
- `GET /api/core/trash?appId=&limit=&offset=` lists current user's unexpired entries newest first, using bounded pagination and preview fields including `deletedByType`, `deletedByLabel`, `deletedAt`, and `expiresAt`. Use `Cache-Control: no-store` for the list.
- `POST /api/core/trash/:id/restore` commits the App restore and removal of the claimed Trash entry. Respond with the fresh `restoredId` and App/entity information for navigation.
- `DELETE /api/core/trash/:id` returns `204` after the logical purge and cleanup job commit. Physical blob retirement runs through AD-4.
- `DELETE /api/core/trash` empties the current user's Trash using the same per-entry purge rules. Require explicit confirmation in the UI.

Frontend:
- Add a **Trash** section/tab in `frontend/src/shell/Settings.tsx` (`TrashPanel.tsx`) using existing shared pixel UI primitives (`ConfirmDialog`, `EmptyState`, `StatusChip`, i18n keys), showing source badge ("You" vs "Agent: <name>"), remaining retention days, App filter, Restore, Permanent Delete, and Empty Trash.
- Update existing delete confirmation copy in covered Apps (`tasks`, `notes`, `assets`, `clock`) to indicate items move to Trash.

---

## 4. Task Breakdown & Dependencies

| Task | Depends on | Owner Role | Work |
|---|---|---|---|
| T1 | — | architect + reviewer | Record approval of the specific Core, Contract V1, and sync changes and freeze this worklist after independent review |
| T2a | T1 (foundation) | advanced-worker | Add the forward-only Core tables, transactional cascade enqueue, retention configuration and all Compose/env wiring. Verify fresh install, upgrade, attribution, rollback, cascade and config |
| T2b | T2a, T1 (transaction/storage design) | advanced-worker | Add the scoped mutation and restore contracts, transaction-bound Trash operations, attachment staging and recovery, and retirement processing |
| T3 | T2b | advanced-worker | Wire Core Trash HTTP and scheduled purge through owned entry claims and verified lifecycle status |
| T4 | T2b | advanced-worker | Integrate Tasks and Clock first, then Notes taxonomy and Assets attachments. Coordinate Assets route activation with T5 before Trash starts retiring live bytes |
| T5 | T2b, T4 (App operations) | advanced-worker | Audit and guard all live-file readers, coordinate sync pruning with Trash retirement, and integrate the narrowly scoped sync natural-key conflict handling |
| T6 | T3, T4 | worker | Add Settings Trash with URL-backed section, retention and attributable-delete views, restore/purge feedback, and delete confirmation copy for the covered Apps |
| T7 | T3, T4, T5, T6 | worker / advanced-worker | Run focused unit, migration/transaction/filesystem/sync integration, deployment config, and Playwright coverage from §7 |
| T8 | T7 | primary + final-reviewer | Run canonical gates (`npm run check`, `npm run build`, `npm test`, `npm run test:integration`, `npm run e2e`, `./scripts/verify.sh`, `git diff --check`, `git status`) and obtain independent final acceptance before commit, push, and green GitHub Actions |

### Execution checkpoints

- **T2a** adds the archive and one durable intent per multi-attachment operation. Store attachment locators relative to `storage/users/<userId>`. Trash locators have the form `trash/<trashId>/<attachmentId>`. Persist source, temporary and destination locators together with their expected sizes and hashes; `committed_at` is written in the final mutation transaction. Inside the archive delete transaction, derive retirement locators from the claimed Trash row and attachment IDs. Intents and retirement work retain their owner UUID after account deletion.
- **T2b review** covers the transaction-bound Core actor, App capability gates, commit-acknowledgement recovery and lock ordering. Use the same lock order for browser and future Agent mutations. Check account deletion against the proposed owner → intent/entry → App order and review the owner lock with Core Auth. Classify restore from current registry status and migration readiness after claiming the entry. Exercise attachment preparation, mutation and cleanup with a one-connection pool. An absent intent after an uncertain commit requires checking committed references. Intent retirement must preserve enough information to resolve that outcome.
- **T4 and T5 review** covers exact business timestamp preservation and concurrent taxonomy fallback creation. Include Notes and Assets taxonomy insert-or-reselect behavior, since their normal creation paths rely on owner/name uniqueness. For repeatable-read capture, acquire and release the shared guard on the same checked-out connection used for all metadata and byte reads, beginning the transaction after acquiring the guard. Review sync conflict resolution, inbound apply and baseline commit alongside ordinary capture. Include standalone Assets unlink, queued Assets cleanup and sync retirement in the unlink-side lock audit. Activate Assets archive and physical retirement only with guarded readers and pruning ready.
- **T6** uses the returned fresh ID for navigation. Clock needs an App-local alarm deep link because its current route only opens the page. Verify direct reload locates the restored alarm.
- **Before T8**, run the full matrix in §7, review the actual diff independently, and complete the release checks. Batch 2 waits for Batch 1 acceptance and merge.

---

## 5. Allowed File Scope

- `migrations/core/` (new forward-only migration only; never edit existing migrations)
- `backend/src/core/trash/` (new module)
- `backend/src/core/app-registry/{types,context}.ts`, `backend/src/core/platform.ts`, `backend/src/core/config/index.ts` (additive contracts, wiring, scheduler, config)
- `backend/src/core/auth/{guard,service}.ts` (immutable Cookie-guard principal and transaction-scoped active owner lock)
- `backend/src/core/storage/`, `backend/src/core/database/index.ts` (attachment path safety and minimal same-connection reader guard support)
- `backend/src/core/data-management/{snapshot,sync-service,sync-retention}.ts` (guard snapshot readers and sync retirement, and classify the covered taxonomy conflict)
- `backend/src/apps/{tasks,notes,assets,clock}/` (share covered delete paths, restore owned entities, and coordinate Assets readers)
- `frontend/src/shell/{Settings,TrashPanel}.tsx`, Settings-scoped styles, `frontend/src/shared/i18n.tsx`, delete confirmation text in `frontend/src/apps/{tasks,notes,assets,clock}/`, and the Clock alarm deep link
- `docker-compose.yml`, `docker/docker-compose.runtime.yml`, `.env.example`, `.env.production.example`, `.env.release.example` (retention setting propagation)
- `backend/test/`, `frontend/src/**/*.test.*`, `frontend/e2e/`, and focused deployment assertions in `scripts/`
- `doc/APP_DEVELOPMENT.md`, `doc/DATA_MANAGEMENT.md`, `doc/DEPLOYMENT.md`, `doc/worklists/UNIFIED_TRASH_WORKLIST.md`

---

## 6. Explicit Non-Goals

- No Agent endpoints, Agent tokens, or MCP server in this batch (deferred to Batch 2: `AGENT_INTERFACE_WORKLIST.md`).
- No breaking changes to `platformApiVersion = 1` or existing `formatVersion: 1` JSON snapshot envelopes.
- No cross-user admin trash inspection (each user sees only their own Trash).
- No Trash replication or generic sync resurrection. Existing `formatVersion: 1` backups and sync heads manage live records only.
- Covered removal is limited to the task, note, asset item, and alarm routes. Taxonomy, standalone attachment deletion, world clocks, Focus sessions, and Mini Game saves are outside this batch.

---

## 7. Acceptance Criteria & Regression Matrix

| Area | Required Verification |
|---|---|
| Migrations | Fresh install and upgrade over existing user/App data. Verify forward-only migration, ownership/attribution constraints, and durable staging/outbox schema. |
| Multi-user isolation | Foreign entries are absent from lists and return the same `404` as missing IDs. Bulk purge affects only the acting user. Reject mismatched owners, Apps, source keys, and symlinks. Owner-row cascade durably removes Trash bytes while other users' files remain readable. |
| Transaction and concurrent claims | Inject rollback after the App changes rows and before Core consumes the archive. Race two restores, restore vs manual/empty/expiry purge, and restore at the expiration boundary. Verify a single committed outcome, no duplicate restore, and no file reclaimed during a winning restore. Verify a failed shared browser/Agent-style transaction cannot archive without the App delete or retain caller-authored attribution. |
| Attachment recovery | Trash and restore multiple attachments and compare SHA-256. Inject failures before intent commit, after only some files were copied, before mutation commit, after commit acknowledgment is lost on both commit and rollback paths, and during physical retirement. Restart recovery after each case. Verify live/trash bytes remain with committed rows, an in-flight stage survives a sweep, and retries converge to cleanup of only unreferenced copies. |
| Live readers | Pause own/all export, WebDAV/sync capture, and Assets attachment download after reading old metadata and before reading bytes. Commit delete-to-Trash and exercise cleanup plus sync pruning for an original `sync/<uuid>` key. The old reader still gets complete bytes, retirement waits for readers, and later reads and scheduled Assets reconciliation reflect committed metadata. |
| New IDs and relation integrity | Every covered restore allocates fresh entity and attachment IDs and valid owned link keys. Stale old-ID edit and delete fail. A same-owner original reintroduced by import yields `409 original_live` with Trash retained; foreign originals are ignored. Exercise renamed taxonomy, name reuse, local recreation with category color, and concurrent matching taxonomy creation. |
| App lifecycle | Disabled App returns `409 app_disabled`, as distinguished from unavailable or hookless App. List and purge still work. Re-enable and restore successfully. |
| Retention and deployment | Confirm expiry uses the configured elapsed duration, expired entries are excluded before the sweep, unexpired items stay available, and failed physical cleanup is retried. Resolve development, production source, and release Compose with a non-default override and test default and invalid startup config. |
| WebDAV and JSON compatibility | Verify full Settings export/import stays v1 without Trash content. In paired continuous sync, restore before a delete publication, during publication, and after both peers have applied its tombstone. Verify fresh identities and remapped attachments/links converge without `resurrection`. Test a peer edit to the original entity under existing conflict rules. Test the same-name taxonomy collision with both conflict choices, preserving local data and dependent links and publishing a valid graph afterward. |
| Attribution and E2E | Delete each covered entity in its App, reload Settings Trash directly, verify user attribution and retention, restore and navigate to the new record, then delete the restored record and purge it from Trash. Use a server-bound Agent fixture for attribution, with external Agent routes deferred to Batch 2. |

---

## 8. Checkpoints

- Architect & Reviewer Checkpoint (2026-11-25): **T2a APPROVED**. The checkpoint authorizes the specific Core migration, startup/deployment settings, and focused tests in this slice.
- T2a implementation and independent review (2026-11-25): **PASSED**. Migration `20261125000001-unified-trash.sql` passed six focused PostgreSQL tests. The local verification script passed with 449 integration tests and a startup smoke test. All 60 existing Playwright tests and the three Compose configuration variants passed. Trash retention is validated by the shared configuration loader.
- T2b transaction and storage design review (2026-11-25): **APPROVED**. The Cookie guard exposes immutable Core-only evidence. Authorization locks the active owner before the intent or claimed entry, and final App operations use the same transaction. An attachment guard is acquired before any relational locks, and exclusive cleanup starts only after the guarded readers are integrated. Per-App lifecycle transitions fence restore until activation finishes.
- Implementation & Local Canonical Gates: **PASSED**. The release candidate passed `scripts/verify.sh`, 485 integration tests, 64 Playwright tests, and development, source production, and release Compose configuration checks.
- Independent Final Review: **LOCAL ACCEPTANCE PASSED**. The candidate includes the full App restore, attachment recovery, reader contention, and paired sync regression matrix.
- GitHub Actions & Merge: **RELEASE CHECKPOINT**. Batch 2 starts after verification of the merged Batch 1 commit.
