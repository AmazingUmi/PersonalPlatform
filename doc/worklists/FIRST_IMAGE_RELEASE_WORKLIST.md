# First public image release

## Objective and current gap

Publish the current accepted application, including the continuous-sync and incremental-backup fixes, as the first public GHCR release. A server must be able to download the release configuration and anonymously pull/run the application without Node, npm, source checkout, or a local image build.

Baseline inspected: `f8e0027` on `codex/webdav-continuous-sync`; root package version is `0.1.0`. The existing production images and isolated Docker acceptance harness work from source. There is no image-publication workflow, versioned application image reference, or pull-only production entry point. The user selected public GHCR packages and anonymous server pulls.

## Architecture and release policy

1. Keep App Contract V1, Core, App behavior, applied migrations, private networking, credentials, cookies, resource defaults and persistence unchanged. This is packaging/release work. The release source includes all five already-accepted continuous-sync migrations; it does not introduce another migration or change the sync protocol. Real WebDAV provider compatibility remains unverified.
2. Publish paired `ghcr.io/amazingumi/personalplatform-backend` and `ghcr.io/amazingumi/personalplatform-frontend` images for `linux/amd64` and `linux/arm64`. The first release is `v0.1.0`, matching the root package version. Workspace package versions need not change. Use exact version references or index digests in deployment instructions; do not make `latest` or a moving minor tag the deployment default. Git version tags and published version image tags must not be retargeted or overwritten. Failed publication may be resumed only without changing an already-published version digest.
3. Build and verify the exact release commit. A Git version tag triggers release automation; validate its syntax and match to `package.json`. Canonical CI for that commit must pass before versioned image tags and a downloadable GitHub release become available. Preserve normal push/PR CI. A tag on the current reviewed branch is permitted; do not silently substitute the older default-branch source.
4. Use native Linux amd64 and arm64 jobs for candidate builds and runtime verification, including the native Argon2 dependency through a real login. Candidates may be pushed by digest before promotion. Publish the multi-architecture version indexes only after both services on both architectures pass. Record index digests, source revision and supported platforms; verify the final indexes. Retain OCI source/revision/version labels, SBOM/provenance where supported, and least-privilege job permissions. Pin added third-party Actions to reviewed immutable revisions. No long-lived publishing token is required when repository-scoped `GITHUB_TOKEN` access is sufficient.
5. Add a shared non-entry `docker/docker-compose.runtime.yml` for the existing runtime settings. Keep `docker/docker-compose.prod.yml` as the standalone source-build entry, and add `docker/docker-compose.release.yml` as the standalone pull-only entry. Use Compose `extends` for each service and preserve the Compose 2.20 compatibility floor. Do not inherit the release services from a file containing `build`, and do not depend on newer `!reset`/`!override` tags. The pull-only entry must resolve with no `build` keys, host source mounts or build-time source requirements.
6. Both entry points retain the existing default project and volume names. An explicit pair of backend/frontend image references supports digest verification and deployment pinning. The release bundle supplies matching references for one version, with credentials left empty. Downloaded Compose files keep the relative layout needed by `extends`. Build-on-server remains supported through the existing entry point.
7. Extend the existing isolated production acceptance harness with an explicit prebuilt-image mode. Reuse its real login, migration, API/proxy, attachment and persistence checks rather than duplicating a weaker smoke script. Prebuilt mode must never invoke a build, must inspect the requested image identities, and must not delete user images, external release images, or unrelated volumes. Source-build mode and its cleanup guarantees remain intact.
8. Publish a small release bundle containing the pull-only entry, shared runtime file, credential template, concise instructions and checksums/digest record. Demonstrate anonymous pulls with registry authentication removed from the verification context. GHCR visibility must actually be public; a successful authenticated workflow pull alone is insufficient evidence. If account permissions prevent visibility changes, report the exact remaining owner action without claiming the release is anonymously usable.

## Tasks, dependencies and allowed scope

| Task | Work | Depends on |
|---|---|---|
| R1 | Freeze this worklist after independent architecture/checkpoint review | inspection |
| R2 | Extract shared runtime settings; add pull-only Compose, release env template and focused parity/missing-reference tests | R1 |
| R3 | Add prebuilt-image verification and release metadata/config validation, preserving source-build verification | R2 |
| R4 | Add tag-driven multi-architecture candidate build, native verification, promotion and bundle/release workflow; reuse canonical gates | R2–R3 |
| R5 | Update deployment/README guidance for first install, HTTPS prerequisite, persistence, backup, pinned updates and failed-update recovery | R2–R4 |
| R6 | Run task checks and canonical gates; independent final review; commit/push; verify source CI and tagged publication | R2–R5 |
| R7 | Verify public anonymous pulls and clean-bundle startup on available supported Linux hosts; record exact tag/revision/digests and evidence limits | R6 |

Allowed: this worklist; `.github/workflows/`; `docker/` Compose and narrowly necessary image metadata; `.env.production.example` and a release-specific example; release/verification helpers and their focused tests under `scripts/`; `package.json`/lock only for relevant script or release metadata; `Makefile`; `README.md`; `doc/DEPLOYMENT.md` and release instructions. Shared Compose extraction is packaging-only and must preserve the resolved runtime settings.

Implementation fact: `.gitignore` also needs the narrow `!.env.release.example` exception so the public empty-credential template is tracked; all private `.env.*` files remain ignored.

Out of scope: Core/App/frontend feature changes, migration edits, new auth or sync semantics, real WebDAV account operations, public-server provisioning/DNS/TLS deployment, publishing private environment files or data, changing existing running deployments, forced tags, and automatic database rollback. Forward migrations make reverting only an image an unsafe general rollback claim; document full matching backup recovery when schema compatibility is uncertain.

## Acceptance and regression matrix

| Area | Required evidence |
|---|---|
| Configuration | Source-build entry still builds cleanly; release entry has image references and no build keys; missing refs/credentials reject; source/release runtime settings match apart from image/build; Compose 2.20 syntax retained |
| Network/security | Only loopback frontend published by default; backend/database private; required credentials; production Secure cookie, non-root runtime and no development tools/source mounts preserved |
| Architecture | Exact backend and frontend candidates run on native Linux amd64 and arm64; login exercises native password hashing; final indexes contain both intended platforms and source/version labels |
| Clean installation | Downloaded bundle works without repository source or npm; fresh DB receives all current migrations and Apps activate; SPA/API/static routes and >1 MiB attachment round trip pass |
| Persistence/update | Database, session and attachment survive recreation; switching the existing project from source-build to release configuration preserves the same volume identities; no `down -v` in user update/stop instructions |
| Existing features | Existing unit/integration/E2E suites remain green, including backup/sync migrations and stale-edit fences; no new real-provider compatibility claim |
| Failure/cleanup | Missing daemon/image, invalid config, failed health/login or image mismatch fail nonzero; random-project cleanup only; prebuilt images retained; no unrelated deployment mutation |
| Release | Tag equals package version; exact source CI passes; immutable version refs and digests recorded; both GHCR packages publicly pullable with no credentials; bundle checksums/layout valid; publication failures do not become accepted releases |
| Canonical gates | `npm run check`, `npm run build`, `npm test`, `npm run test:integration`, `npm run e2e`, `./scripts/verify.sh`, `npm run test:docker:config`, source and prebuilt production verification, focused release tests, `git diff --check`, expected/clean `git status` |
| Final acceptance | Independent final-reviewer ACCEPTED against actual diff and evidence; coherent committed/pushed source; GitHub CI and publication success for the exact release revision; anonymous pull evidence and remaining deployment limits reported |

## Checkpoint and evidence

- Architecture proposal: ACCEPTED.
- Worklist checkpoint: ACCEPTED by independent release reviewer before implementation. Both entry files must declare named volumes because `extends` imports services only; resolved runtime parity is required.
- Local gates: PASS (`check`, `build`, backend unit 254, frontend 594, integration 443, E2E 60, full `verify` with fresh migrations/smoke, release tests 8, Docker configuration/options tests 14, source-build and prebuilt container verification, actionlint, and diff check). The high-severity dependency gate passes; audit still reports three moderate advisories, with no forced dependency changes in this packaging batch.
- Independent local final-reviewer: ACCEPTED after direct diff, configuration parity, gate logs, retained-input-image and live-production-isolation checks. A workflow-context defect found during validation was reproduced by regression before correction.
- Publication and final acceptance: PENDING. Record final release evidence against the committed revision in the delivery report; do not create another release tag merely to record CI results here.
