# Assets

Personal asset management app. Verifies CRUD, database, search, file attachments
and a Dashboard widget on the platform.

- Backend: `backend/src/apps/assets/index.ts`
- Frontend: `frontend/src/apps/assets/index.tsx`
- Schema: `assets.*` (categories, items, attachments)

Storage reconciliation runs after boot, hourly, or through the admin-only
`POST /api/apps/assets/maintenance/reconcile` endpoint. Each attachment is
checked in its owner's storage. Healthy files use `exists=true` without reading
their contents; `exists=false` requires a read from that same storage scope.
Only a read throwing `StorageError` with `code: "not_found"` permits metadata deletion,
conditional on the attachment id, owner and storage key still matching.

Directory/symlink rejection, I/O errors and other inconclusive probes retain
metadata and do not stop the remaining scan. The response adds `probeFailed`
alongside `queue` and `danglingDropped`; warnings identify the attachment,
owner and error code, and scheduled summaries include probe failures even when
no metadata was deleted. Repair the storage fault and rerun reconciliation;
this process does not restore missing file bytes or provide a transaction
across PostgreSQL and the filesystem.
