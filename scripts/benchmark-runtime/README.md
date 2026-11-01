# Production runtime benchmark

This runner builds the selected source's production Compose file and starts a random, isolated project with new database/storage volumes, private temporary credentials and a random loopback port. It uses the source's defaults, with only test credentials, project/port selection and HTTP-cookie compatibility overridden. It never reuses a deployed database.

```bash
npm run test:benchmark:runtime
node scripts/benchmark-runtime/run.mjs \
  --source /absolute/source/checkout \
  --output /absolute/new-result-directory \
  --label baseline-1 \
  --revision EXACT_SOURCE_COMMIT
node scripts/benchmark-runtime/summarize.mjs /absolute/new-result-directory
```

`--revision` records a commit for a source archive without `.git`. The content manifest independently records SHA-256 hashes of source files, including untracked, non-ignored files in a Git checkout. Secrets in `.env` files are excluded. The runner records its own code hash and the actual runtime/base image IDs.

For a harness smoke test only, use `--scale 0.02`; it shortens phase durations while retaining the full dataset. A scaled run is not a formal resource comparison. Formal comparisons use the default scale `1`, identical host/base images and four sequential runs in baseline/candidate/candidate/baseline order. Avoid unrelated build/test activity during those runs.

The workload seeds 500 tasks, 500 notes and 200 assets. A second account must see empty lists and cannot read, modify or delete the first account's records/attachments; its revoked session must fail. Each mixed-load client performs nine parallel reads and six serial create/update/delete requests, then waits one second. There are separate one-client and five-client phases, login, 1/10 MiB attachment round trips with SHA-256 checks, and idle phases before and after load. Actual container health checks remain enabled; the harness adds no independent readiness poll.

The sampler uses a local Unix-socket Docker API. Cumulative container CPU deltas divided by monotonic elapsed time give CPU use where **100% is one logical core**. It records raw memory charge and Docker-style working set (charge minus inactive file pages), not summed process RSS. Health-check subprocess costs are included. Phase-boundary intervals are excluded. CPU seconds per successful request uses requests completed within the sampled time window, not an unrelated count from the full phase. Expected 401/404 isolation assertions are not errors.

Outputs include:

- `metadata.json`, `source-manifest.json`, redacted `compose-resolved.json`: source, environment, actual image/configuration, health and final data counts.
- `samples.jsonl`, `requests.jsonl`, `phases.json`, `connections.json`: raw evidence, without passwords or session cookies.
- `summary.json`: per-phase latency/throughput, CPU time/percent/per-work, raw memory and working-set median/peak.
- `operations.log`, `failure.json` when needed, and `cleanup.json`: startup/build diagnostics and owned-resource cleanup result.
- Timestamped `backend.log`, `frontend.log`, `database.log` and post-measurement `postgres-diagnostics.json`: latency investigation evidence, captured without changing runtime settings or adding work inside measured phases.

Unexpected responses, byte mismatches, missing counters, container restarts or cleanup failures produce a nonzero exit. On completion or failure, the runner removes only its random project, volumes and locally built images and deletes temporary credentials. Interruptions request cancellation of active commands before cleanup. SIGKILL/power loss cannot run cleanup; the recorded project name identifies those resources for manual recovery.

Short benchmarks do not establish long-term leak freedom, saturation capacity, the true sub-second startup peak, or a supported minimum RAM size. Review per-run results and throughput alongside memory/CPU improvements.
