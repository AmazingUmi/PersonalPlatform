# Lightweight Runtime Worklist

## Objective and checkpoint

Reduce the default production stack's idle CPU wakeups, connection overhead and log growth for personal/family use, retaining every App, account isolation and all existing data/lifecycle semantics. Establish a reproducible before/after measurement; do not claim a minimum NAS specification or a supported 512 MiB deployment without testing it.

- Baseline: `f6f625c29b8c52ba967d8a3966e651d0a0d815bf`; initial working tree clean. Implementation branch: `codex/lightweight-runtime`.
- Architect decision: **ACCEPTED** for the bounded Core change below. This explicitly resolves the frozen-boundary escalation for connection-pool configuration only; it authorizes no other Core/Contract change.
- Reviewer checkpoint: **ACCEPTED** (2026-11-01, independent reviewer; clarifications below incorporated). Scope/acceptance are frozen; record newly discovered facts and obtain checkpoint review for material changes.

## Current gap and decisions

1. One shared `pg.Pool` is hardcoded to 10 connections. Add an optional typed pool-size option to `Database` and a single startup environment parser for `DATABASE_POOL_MAX`; reject empty/invalid/non-integral/out-of-range supplied values before serving requests. Accept integers 1–100. Preserve the existing constructor's default 10 for callers that do not opt in; production Compose explicitly defaults to 4. AppContext, query results, transaction client ownership, rollback/release, migration connections and `platformApiVersion = 1` stay unchanged. The startup parser may live beside Database or in the existing config module, but must not read global environment implicitly inside every constructor.
2. Production currently starts a separate Node process for backend readiness every 5 seconds. Use the runtime image's lightweight HTTP client (BusyBox `wget`, verified inside the built image), require a successful `/api/core/health/ready` HTTP response, and preserve a bounded timeout/nonzero failure. Default production health intervals become 30 seconds, configurable through one documented variable. Preserve private networking, dependency readiness and the existing Compose compatibility floor; do not rely on unsupported `start_interval` behavior. Verify fresh startup remains within the existing 180-second wait.
3. Use conservative, overridable PostgreSQL defaults: `PG_SHARED_BUFFERS=64MB`, `PG_WORK_MEM=2MB`, `PG_MAINTENANCE_WORK_MEM=32MB`, `PG_MAX_CONNECTIONS=30`. Pass settings as discrete command arguments, not shell interpolation. Keep `fsync`, `synchronous_commit`, WAL and recovery safeguards enabled. Explain that connection allowance must exceed the application pool plus migration/admin/maintenance demand. Existing data volumes remain reusable; no SQL migration is required.
4. Make the three production memory/CPU ceilings overridable while retaining their current defaults until measurements justify a separate change. A lower ceiling is not itself a resource optimization. Add bounded Docker log rotation to all production services. Preserve the existing INFO default and `LOG_LEVEL` override so the pool/health changes are not confounded with suppressed request logs; document WARN as an explicit operator option.
5. Keep Node + PostgreSQL + Nginx and the current frontend. Nginx was only about 10 MiB in the earlier native test. No authentication downgrade, password-hash change, SQLite, cache, process consolidation, App behavior change or frontend polling rewrite in this batch.

## Tasks and dependencies

| Task | Work | Depends on |
|---|---|---|
| L1 | Reviewer accepts/finalizes this worklist; capture baseline source and resolved production configuration | architect |
| L2 | Add explicit pool configuration, fail-fast validation and semantic small-pool regressions | L1 |
| L3 | Update production probes, PG defaults, configurable ceilings, log rotation and environment/deployment documentation; extend Docker configuration/runtime assertions | L1 |
| L4 | Add reproducible isolated benchmark runner, shared baseline/candidate workload, raw samples and comparison report | L1; final comparison after L2/L3 |
| L5 | Run task checks, canonical gates, container persistence/health checks and paired benchmarks; resolve discovered defects with regressions | L2–L4 |
| L6 | Independent final review of actual diff/results; coherent commit, push, successful GitHub Actions; restore owned runtime resources | L5 |

Workers may own L2 and L3 separately after checkpoint. Benchmark implementation must consume actual resolved configuration and not silently substitute lighter settings. No worker edits another worker's owned files without coordination.

## Allowed file scope

- `backend/src/core/database/index.ts`, `backend/src/main.ts`, and only if needed for the single parser `backend/src/core/config/index.ts` (bounded Core exception above).
- New targeted `backend/test/unit/database-pool.test.ts`, `backend/test/integration/database-pool.test.ts`; necessary focused additions to existing config/auth-isolation/focus tests or their helper to exercise explicit small-pool options.
- `docker/docker-compose.prod.yml`, `docker/backend.prod.Dockerfile`, and a small `docker/healthcheck*` helper only if the inline probe cannot meet timeout/failure requirements.
- `.env.production.example`, `doc/DEPLOYMENT.md`, `doc/DEVELOPMENT.md`, this worklist; `doc/reports/LIGHTWEIGHT_RUNTIME_BENCHMARK.md` for the compact evidence report.
- `scripts/test/docker-config.test.mjs`, `scripts/verify-docker.mjs`, new `scripts/benchmark-runtime/` runner/workload/summarizer and focused runner tests; `package.json` for corresponding commands.
- `.gitignore` only to exclude benchmark runtime artifacts. Raw captures, credentials, databases, image exports and generated test output remain outside tracked source.
- `.github/workflows/ci.yml` only if a targeted check cannot be reached through the existing canonical jobs; no unrelated CI refactor. Other files require a recorded scope amendment.

## Measurement contract

The previous macOS/Node 26 RSS report is context, not a valid control for a Node 22 Linux candidate. OrbStack was initially stopped, has now been started, and provides Docker 29.8.2/Linux aarch64 with no pre-existing containers. **Production Linux containers are the primary comparison**, using the same engine, host, Node 22/PG17/Nginx base image identities, dataset and workload. Record immutable baseline SHA, candidate diff/SHA, image identities and effective runtime settings. Keep a native fallback/reporting path compatible with the prior benchmark only if container access later fails; label its evidence separately and do not claim container acceptance from it.

- Build baseline from an isolated checkout of the exact baseline commit. Use random Compose projects, private credentials, new volumes and loopback ports. Never reuse or reset a user's database/storage.
- At least two paired baseline/candidate runs with reversed order between pairs, fresh services/data each run. Predefine identical warmup and phase durations: data seed; 60-second idle; 60-second one-client and five-client mixed reads/CRUD; successful login; 1/10 MiB attachment upload/download/hash/delete; 60-second post-load idle. The 9-parallel-read/6-serial-write cycle plus one-second think time from the previous test can be retained. Label simulated clients rather than real-user capacity.
- Use at least 500 tasks, 500 notes and 200 assets for the main account; add a second account and explicit cross-account read/write/attachment-denial checks. Test functional isolation separately from performance totals if necessary, but retain error counts and final row counts.
- Sample approximately every second. Prefer Linux cgroup cumulative CPU deltas and `memory.current`/`memory.stat`; record both total container charge and a clearly defined working-set metric if used. CPU 100% means one logical core. Include real health-probe subprocesses. Never mix raw container memory with macOS process RSS in a percentage-improvement claim.
- Report phase CPU means and sampling peaks, memory median/peak, request count/rate/errors, p50/p95, health status, connection count, runtime versions and cleanup. Preserve raw timestamped samples and workload outcomes outside Git; commit only compact methodology/results and reproducible scripts.
- Improvement acceptance: paired evidence must show a repeatable reduction in at least one intended runtime metric (idle CPU/probe overhead or loaded DB/stack memory), not merely fewer configured connections/probes. All requests and hashes must pass. Mixed-workload throughput must remain at least 90% of matched baseline; investigate a p95 increase above the larger of 25% or 10 ms. These are regression investigation gates, not permission to hide a tradeoff; any accepted exception requires a recorded rationale and reviewer approval. If no material improvement is observed, revise/revert the ineffective setting rather than declare success.
- Report CPU seconds per successful request or complete CRUD cycle alongside throughput for closed-loop loads, so doing less work cannot appear as an optimization. A material improvement must have the same direction in both pairs and exceed observed repeat-to-repeat variation; report per-run results rather than hiding variation in a pooled mean.
- Document health-detection latency: changing 5-second intervals to 30 seconds with 10 retries extends the nominal failure window from about 50 to 300 seconds, excluding timeout/start-period effects. Fresh startup must still pass the existing 180-second wait; the runtime interval remains configurable.
- Startup, migration and restart behavior are verified functionally; one-second sampling does not establish true sub-second peak memory. No 512 MiB support claim, saturation capacity claim, or long-term leak claim follows from this short benchmark.

## Acceptance and regression matrix

| Area | Required evidence |
|---|---|
| Pool configuration | Default compatibility, explicit 1/4/10 and bounds; reject malformed/empty/zero/negative/fractional/overflow values; startup uses supplied option |
| Pool semantics | Small-pool concurrent work queues and completes; transaction rollback releases the client; subsequent queries and graceful shutdown succeed; no timing-accident assertions |
| Isolation/concurrency | Existing multi-user isolation/auth-hardening and Focus concurrency tests pass; two-account benchmark checks preserve ownership and attachment isolation |
| Production configuration | Defaults/overrides survive Compose resolution; resource/log settings present; health success and failure verified in the actual image; no required credential/security/network/storage weakening |
| Database | Effective PG settings asserted; fresh startup and reuse/recreate of a populated volume preserve data; fsync/synchronous_commit remain enabled |
| Features | SPA/deep links, authenticated CRUD, 1/10 MiB attachment integrity, disabled-App behavior, session behavior and restart persistence retain existing coverage |
| Measurement | Comparable Linux pairs, successful requests, raw evidence, actual improvement and disclosed latency/memory tradeoffs; no unsupported minimum hardware claim |
| Cleanup | Only owned test projects/volumes/images/processes removed, ports closed, original services untouched; restore OrbStack to its initial stopped state after all container work |

Canonical gates: `npm run check`, `npm run build`, `npm test`, `npm run test:integration`, `npm run e2e`, `./scripts/verify.sh`, `npm run test:docker:config`, `npm run verify:docker`, `git diff --check`, expected `git status`. Use dedicated test databases for destructive integration/verification suites. Finish only after independent final-reviewer **ACCEPTED**, coherent committed/pushed tree, and GitHub Actions success. A missing daemon or skipped database gate is not PASS.

## Explicit follow-ups, not this batch

Prebuilt multi-architecture image publication would remove NAS-side build overhead, but adds registry credentials, release/tag/update policy, supply-chain checks and architecture-specific native dependency validation. Keep the existing local build path working; record publication as a separate independently accepted release batch. Likewise SQLite, serving frontend from Core, tighter production memory guarantees and NAS-specific packaging require their own architecture/validation scopes.

## Implementation record

- 2026-11-01: Architect approved only the pool-configuration Core exception. Container comparison became feasible after starting previously stopped OrbStack; Linux production comparison is now the required primary evidence.
- Reviewer checkpoint: ACCEPTED; CPU-per-work and health-latency clarifications incorporated before implementation.
- Implementation: L2/L3 accepted by the independent implementation reviewer; benchmark checkpoint accepted after adding immediate cancellation on failure. No App behavior, authentication, migration or Contract semantics changed.
- Local canonical gates: check/build; backend unit 196, frontend 448, integration 357; E2E 44; full verify; Docker configuration 7 and metric regression 3; real production-image verify all PASS. An additional fresh-database E2E run with `DATABASE_POOL_MAX=4` passed all 44 tests. Default-constructor and production pool settings are both covered.
- Benchmark: all four formal Linux runs passed in B1/C1/C2/B2 order, with identical harness/base images and matching source manifests within each configuration. 22,927 expected responses, attachment hashes, two-account ownership/revocation checks and per-run cleanup passed. Interrupted concurrent-workload cleanup also passed.
- Evidence: [paired resource report](../reports/LIGHTWEIGHT_RUNTIME_BENCHMARK.md). Repeatable idle CPU and loaded median-memory improvements satisfy the resource-benefit checks; the roughly 3% five-client throughput cost, inconsistent unit-work CPU change at that load, idle-after memory increase and unreduced peaks are explicitly retained. Final reviewer explicitly accepted the disclosed login-tail exception after the supplemental investigation below. No unsupported low-memory capacity claim is made.
- Final-review discovery/amendment: candidate-2 login p95 was 869.98 ms versus baseline-2 91.12 ms (43 versus 52 successful responses). This triggers the latency investigation gate despite passing functional assertions. Reviewer approved supplemental B3/C3 diagnostics with unchanged runtime/workload: preserve all original evidence, capture timestamped service logs and read-only PostgreSQL stats after sampling, then assess repeatability and any explicitly disclosed exception. Do not attribute the tail to pool configuration or host I/O without evidence.
- Scope clarification: the new standalone metric tests were added to the existing CI job, as allowed by L4/L5. Multi-architecture image publication remains a separate release batch.
- Supplemental diagnosis: B3/C3 passed 11,660 expected responses and cleanup. Login p95 86.27/86.99 ms (52/52 responses), server p95 82.46/83.36 ms; original C2 anomaly did not recur but its cause remains unknown. All original data retained; explicit performance-exception rationale is retained in the report and independently accepted. All owned containers/volumes removed, native gate PostgreSQL stopped, original PostgreSQL PID 854 untouched, OrbStack restored to Stopped.
- Independent final review: **ACCEPTED** after direct diff/source/evidence checks, independent raw-metric recomputation and service-log matching. Reviewer explicitly approved the C2 login exception only for this optimization batch: root cause remains unknown, not fixed, and no login-tail/SLA guarantee. Commit/push follow this acceptance; the final commit's successful GitHub Actions run and clean tree are required for full phase completion and form the remote acceptance record.
