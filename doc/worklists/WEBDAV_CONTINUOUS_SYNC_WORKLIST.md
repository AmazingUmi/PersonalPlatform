# WebDAV continuous sync

## Status

- Architecture and independent checkpoint: ACCEPTED.
- Implementation is in the tree: sync service and routes, five forward Core migrations (`20261102000001` through `20261102000005`), fences on all six Apps, Settings sync view, shell loop, and EN/ZH help. App Contract V1 and `platformApiVersion` are unchanged.
- Source is frozen. Local canonical gates PASS: `npm run check`, `npm run build`, 254 backend unit tests, 592 frontend tests, 436 integration tests (the 20 full-sync tests included), fresh migrations and smoke via `./scripts/verify.sh`, and 60 e2e tests. Independent review ACCEPTED (`final-atomic-review.jsonl`). Desktop and mobile EN/ZH screenshots reviewed PASS. Lost acknowledgement, rollback of the accepted head, and the 409 v2 fence were confirmed on the source.
- Implementation and local acceptance are complete. Release acceptance is verified against the committed revision using CI and deployment evidence in the final delivery report. A later documentation commit is not required only to record CI.
- Real Nutstore was not tested. Do not claim provider compatibility. CAS stays fail-closed.
- Accounts are created independently (`createUser` uses a new UUID). The user explicitly pairs once to one cloud sync identity. After that, continuous sync runs only while a frontend session is signed in, and only for that user's own data. Admin all-user backup stays a separate backup path.

## Authorization

This is an explicit platform data-management capability. Allowed Core additions are the forward migrations above and `backend/src/core/data-management/` sync modules, plus the narrow transport and lock-helper edits already in this feature. Applied migrations are not edited. Existing full export, add-only import, and incremental backup restoration stay usable. Pre-sync backups are not sync identities and are not auto-discovered.

## Frozen protocol

Objects live in the WebDAV collection the user already configured. Names:

- immutable `pps-{identityId}-{sha256}.json` and `.bin`
- one mutable head `pps-{identityId}-head.json`
- probe `pps-probe-{32 hex}.json` (left in place)

No `MKCOL`, no directory listing, no replica index, and no remote `DELETE`. Different identities share one folder without colliding. A pairing code is `ppss1.` plus base64url(16-byte identity UUID, 32-byte secret). The head stores `SHA-256(secret)` only. WebDAV credentials grant storage access. The pairing code binds one local app user. The code is shown only after create, or when that same user explicitly reveals it. It is never written to API logs.

The head is format 1: identity, pairing verifier, generation, `opToken`, parent op, content hash, schema fingerprints, and references. Row bytes are the same 16 content buckets as incremental backup (`contentBucket`), one object per occupied bucket. Attachments are separate content-addressed `.bin` objects. Tombstones are one JSON array object. A one-row edit uploads the changed bucket (and the tombstone object only when that set changes), then the head. Content objects use `If-None-Match: *`. The head is last, with `If-Match` on the current generation ETag. A failed compare-and-swap fails closed: no unconditional `PUT`, and the baseline is not moved onto that unconfirmed published head. `buildSyncDocument`, `parseSyncHead`, and `reconstructSyncDocument` are the protocol shape. There is no single all-rows object.

Cloud objects and the local sync cache are content-addressed. Sync staging under `sync/<uuid>` is a random UUID name. It is not content-addressed staging.

Enablement probe, in order, on a random probe name. A strong ETag is read from `GET` after `PUT`. A missing ETag on the `PUT` response is not a failure by itself.

1. `PUT If-None-Match: *` creates body A. `GET` must return A and a strong ETag. One retry if the ETag is missing or weak; a second miss fails closed.
2. A second create-if-absent `PUT` returns 412 and the bytes stay A.
3. `PUT If-Match` with a wrong tag returns 412 and the bytes stay A.
4. `PUT If-Match` with the current tag changes the bytes. `GET` returns the new bytes and a new strong ETag (one retry for a missing or weak tag).
5. `PUT If-Match` with the previous, now-stale tag returns 412 and the bytes stay at the new body.

Any miss records `webdav_cas_unsupported` with the step name and does not enable sync.

A 304 or an equal head hash means the cloud copy is unchanged. The cycle still compares the local semantic snapshot with the baseline. A local-only edit still publishes.

First join does not overwrite either side because one side is new:

- same key, different semantic value, no baseline: conflict
- local-only key: pending addition, not a deletion
- remote-only key: pending remote insert
- explicit remote tombstone against an existing local row: conflict
- a key that was never in the baseline and is merely absent is not a deletion
- a baseline key missing from a later head without an explicit tombstone invalidates that head

Link and download first. Publish local-only rows on a later cycle, after the downloaded remote state has been committed locally. Status shows bootstrap versus conflicts.

Remote CAS and the local commit are not one distributed transaction. Before the head `PUT`, the service journals the pending op, content hash, capture hash, and the expected parent op, parent content hash, and parent ETag. `recoverPublication` chooses the next step; it does not by itself prove the local commit. After a later remote mutation the helper must not treat a new head as the parent.

- remote head equals the pending op and that capture was applied locally: commit that baseline
- remote head is still that parent (op, content hash, and ETag): retry the same operation, bounded
- remote head is a different operation and the local capture is unchanged: lost race; reconcile on the next cycle
- local rows changed after the objects were uploaded: retain the pending operation; do not advance the baseline to data that was not applied
- applied inbound rows and the accepted head (ETag, generation, document) commit in one transaction. A lost acknowledgement (`publication_unknown`) can mean both committed. Retain the new staged files and the old keys, and verify on the next cycle. A known rollback rolls the rows and the accepted head back and deletes only the new staged files. A known commit retires every replaced key that nothing still references.
- Until first-bootstrap anchoring, `baseline_hash` stays null. The accepted head, generation, and document are already atomic and reject an older generation or the same generation with a different content hash. A completed inbound accept may advance the accepted head, and an already established baseline with it, even when a later outbound upload is partial or the head CAS fails. CAS failure never advances the baseline to that unconfirmed published head. A validated cycle with no pending op clears `publication_unknown`.

Same `identityId` cannot be bound to two local users on one deployment (`UNIQUE (identity_id)`). A different WebDAV username that reaches the same collection still has to match the pairing verifier.

Idle poll is one conditional `GET` of the known head. Default interval is 120 seconds; 60 is optional; 0 is manual only. Normal cycle budget is 24 requests; bootstrap may use 64 per cycle and must continue through cached hashes rather than repeating the first objects. Backoff on 429 and transport failure is exponential with jitter, cap 30 minutes. Backup scheduler and its lease stay as they are. Sync uses its own lease. Changing endpoint or username while linked returns 409 until unlink. Logout, user change, closing the platform page, and user pause stop later cycles. A request already sent cannot be recalled.

Semantic hashes exclude `updated_at`, `revision`, `user_id`, and `storage_key`. Attachment bytes enter the hash as `content_sha256` and are removed before apply. `high_score` is `max(local, remote, baseline)` on fast-forward, publish, and conflict. A fast-forward must not install a lower remote score. After both sides hold that max, the key is not published again. A local tombstone plus a restored local row is a resurrection conflict. A key listed as both live and tombstoned invalidates the head. Focus revision bumps are local metadata and must not republish an unchanged session. Two active Focus sessions, or a tombstone for the local active session, are conflicts; the local timer is not stopped.

Apply validates with `validateEnvelope`, `validateRow`, and `assertRecordGraph` before rewriting `user_id`. Duplicate primary keys, core tables, a second owner, and attachment size/hash mismatches reject the whole plan. Import stays add-only.

Apply holds `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` in the same sorted name order as import, only for the apply transaction, with a 5-second lock timeout. Owner `user_id` is rewritten to the session user. Attachment storage keys are server-assigned.

`resolveSession` runs at cycle start, again before a publication `PUT`, and again inside the apply transaction before commit. An ambiguous `PUT` is resolved only by a later authenticated `GET` of `opToken`. No scheduler pulls or pushes sync. `core.users` and `core.settings` are never sync data.

## Write fence

Shared `semanticHash` / sync key helpers are the base hash.

No binding, or phase `probing` / `unlinked`: `baseHash` is optional. Omitted writes keep the previous behavior.

Phases `bootstrap`, `linked`, and `publication_unknown` are fenced, including when the user has paused sync (`enabled` false does not leave those phases). There is no safe-off app table.

- Creating a new standalone UUID row, when no old row exists, may omit `baseHash`.
- Updating or deleting an existing row, editing a singleton (including a not-yet-stored settings row, which uses the absent-row hash), changing links, and reordering a list require the `baseHash` loaded with that form.
- A missing hash while fenced does not write and returns 409 `sync_base_required`. A mismatched hash returns 409 `sync_stale` and leaves the stored row unchanged.
- A dirty editor keeps the hash it loaded. Sync refresh does not remount it and does not replace the draft. The user must explicitly discard and reload before saving again. Other keys continue to sync.
- Game still rejects a stale revision. On that rejection the client keeps the pre-rejection board until the user explicitly chooses. It must not number upward and `PUT` the old board over the server. Focus keeps `revision_conflict`. A local revision bump is not a semantic edit.

Covered tables: `tasks.tasks`; `notes.notes`, `notes.tags`, `notes.note_tags`; `assets.categories`, `assets.items`, `assets.item_categories`, `assets.attachments`; `clock.settings`, `clock.alarms`, `clock.world_clocks`; `focus.settings`, `focus.sessions`; `mini_game.saves`.

## Natural keys and parents

Tags and asset categories conflict by name. The chosen side keeps its id. The other parent row is deleted and that parent sync key is tombstoned. In the same transaction, owned `note_tags` and `item_categories` rows are removed from the losing id and inserted on the survivor before the losing parent is deleted, so `ON DELETE CASCADE` does not drop the chosen links.

A parent that is still a natural-key conflict is not applied. Children that need it stay open `parent-child` conflicts (fixed point: a deferred child also blocks deleting that parent). Resolving the parent retargets those links and closes `parent-child` conflicts whose image pointed at the losing id. For that deferred image, the old link key is tombstoned (`tombstoneHash` set). A live link move recorded by `captureRetarget` uses `tombstoneHash: null`; it deletes and reinserts the link and does not write a link tombstone.

## Local retention

After a known commit, retire every replaced key that nothing still references. A known rollback deletes only the new staged files. An unknown commit keeps both. `pruneSyncLocalFiles` runs only after a known completed cycle, while this user's lease is still held, and while publication is not pending or `publication_unknown`. A validated cycle with no pending op clears that phase first. Defaults are 64 MiB and 64 files of unreferenced objects per directory. Protected, and never counted toward the cap: every object hash of the current head and the pending head, open-conflict attachment hashes, and every live attachment `storage_key` in the database. Only regular files named as sha256 (cache) or UUID (staging) are eligible. No remote delete.

## File scope

In this feature:

- this worklist and `doc/DATA_MANAGEMENT.md`
- `migrations/core/20261102000001-continuous-sync.sql` through `20261102000005-sync-remote-filename.sql`
- `backend/src/core/data-management/` sync protocol, document, transport, cache, validate, fence, service, retention
- narrow `webdav-http.ts` conditional `GET`/`PUT` and sync filenames; shared lock and record-graph helpers used by snapshot and incremental backup
- app `baseHash` call sites for the six Apps, Settings sync view, shell loop, EN/ZH help

Non-goals: edits to applied migrations, App Contract V1, auth identity, backup merge semantics, real Nutstore calls, remote delete, adopting a historical backup as a sync identity, content-addressed staging names.

## Local gates

PASS on the frozen source: `npm run check`, `npm run build`, `npm test` (254 backend, 592 frontend), `npm run test:integration` (436, including 20 full-sync tests), `./scripts/verify.sh` (fresh migrations and smoke), `npm run e2e` (60). Independent review ACCEPTED. Desktop and mobile EN/ZH screenshots reviewed PASS. Mock WebDAV only.

## Delivery verification

Release acceptance uses CI and deployment evidence for the committed revision, recorded in the final delivery report. This file does not store that evidence. A later documentation commit is not required only to record CI.

| Check | State |
|---|---|
| commit, push, CI, and deploy | verified against the committed revision in the delivery report |
| real Nutstore create, join, and CAS probe | not tested; no provider-compatibility claim |
