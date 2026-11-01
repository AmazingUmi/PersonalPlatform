# Focus completion notification worklist

Status: implementation and local canonical gates complete; independent final-reviewer ACCEPTED. Commit/push/CI form the final remote acceptance record.

## Objective and confirmed gap

Repair the reported case: the Focus page is in the foreground when a timer ends, but the user receives no effective completion notification. Cover the dashboard Focus widget as the other existing timer surface.

`useFocusState.ts` currently ticks only the displayed countdown and reconciles server state through a 15-second visible-tab poll. It never schedules a read at the actual deadline and never exposes a completion event. `FocusTimer` and `FocusWidget` replace the ended session with READY/next duration without an explicit completed notice. No sound or browser-notification implementation exists. Backend reconciliation correctly distinguishes natural completion from manual cancellation, but `/state` returns only the active row, so disappearance alone cannot identify the reason.

## Architecture decision and boundaries

- Implement entirely inside the Focus app slice, its tests, app-specific styles, and documentation. No Platform Core, migrations, capability, event semantics, module contract, status-feed, or shell host changes.
- Ownership stays with mounted Focus page/widget hooks. The shell status feed is decorative and is not repurposed as an application background runtime.
- Server state remains authoritative. A client countdown reaching zero triggers reconciliation; it never establishes completion by itself.
- Add a small app-owned read-only `GET /api/apps/focus/sessions/:id` returning the existing terminal history-item shape. Lookup requires authenticated `user_id` and session id; missing, foreign, and still-active rows return the same 404. Validate UUID input. It does not change state or publish events; reconciliation continues through existing `/state` and transition paths. This gives exact-session evidence without relying on a truncated history page or inferring from totals.
- No data-model migration is needed. Existing terminal rows already contain session id, kind, status, endedAt, and endReason.

## Behavior and implementation tasks

### FOCUS-N1 — Exact-session evidence

Add the repository lookup, route, frontend API helper, and integration regressions. Natural completion, manual stop, foreign-user lookup, live row, unknown id, invalid id, disabled app, and unauthenticated requests must preserve existing guards. Existing events remain published only by committed transitions/reconciliation.

### FOCUS-N2 — Completion observation and timing

Extend app-local state/notification code with these semantics:

1. At a running session's actual `expectedEndAt`, issue an ordered background state read. Use the existing server-time/monotonic-clock anchor; do not trigger from the floored display reaching `00:00` up to a second early. Keep the existing mutation/request/StrictMode epoch protection.
2. Re-arm on an accepted changed deadline/revision; cancel on pause, stop, unmount, or identity change. Deadline callbacks must not create a tight retry loop if the server still reports running or the network fails. Retain bounded retry/poll and visibility-return recovery.
3. Remember a session actually observed active by this mounted observer. When a subsequent accepted state replaces/removes that id (including a 409 self-heal), fetch that exact terminal row. Only `status=completed` AND `endReason=natural` establishes a completion notice. Manual stop, pause, missing/foreign row, network failure, and idle-on-first-load do not generate success.
4. Do not lose an unresolved terminal lookup merely because a newer session starts or another poll arrives. Retry transient lookup failures at a bounded cadence while mounted; do not announce unverified completion. Reject stale lookup resolutions after identity change/unmount.
5. Deduplicate by authenticated user id plus session id. Existing `useAuth` identity may be consumed without modifying AuthContext; app-local test wrappers/mocks must supply it. Never put personal completion payloads onto the existing unscoped `focus` BroadcastChannel. Any new stored preference/acknowledgement or notification channel must be user-scoped.
6. Retain a visible completed notice until dismissed or explicitly superseded by starting the next session. It must name Focus/Short Break/Long Break correctly, distinguish the finished session from the next READY duration, and offer an accessible dismiss action. Use a live status region; no blocking browser `alert()` or automatic next-session start.

### FOCUS-N3 — Optional sound and browser notification

Implement an app-local alert adapter and small controls exposed on Focus surfaces:

- The visible completion notice always works, regardless of optional browser facilities.
- Offer sound enable/mute and a test action. Prepare/resume AudioContext synchronously from a user gesture (start/resume and/or explicit sound control) before awaiting network calls. A recovered running session must expose the explicit activation/test control. Catch unsupported API, suspended/failed resume, and playback errors; surface a concise status without blocking timer controls. Use a short bounded chime and release resources on teardown.
- Browser notifications are opt-in. Request permission only from an explicit enable action, feature-detect secure context/API support, and handle denied/default permission and constructor exceptions (including browsers requiring a service-worker path). Never prompt on load or expiry. Use a stable per-user/session notification tag and safe app-local navigation on click if implemented.
- Preference persistence, if used, is per authenticated user and browser; storage errors fall back to memory. Report the actual permission/readiness state, not merely the stored preference.
- Avoid duplicate sound/notification from simultaneous page/widget observers and repeated reconciliation. Use an app-local per-document claim; where cross-tab alert claims are implemented, use Web Locks with a bounded user-scoped ledger when available. Do not claim atomic cross-tab exactly-once behavior from a localStorage check/write alone. Unsupported coordination may use best-effort deduplication; it must not suppress the visible completion notice.
- Completion notices can appear in each mounted surface, but a previously dismissed/handled session must not repeatedly chime on polls, rerenders, or remount in the same tab. No historical-completion replay on first load.

### FOCUS-N4 — User-facing documentation and verification

Document notification controls and operational limits in `apps/focus/README.md`. Keep generated registries unchanged. Add focused regression tests before declaring the missing notification fixed, run the repository gates, and obtain independent final review.

## Allowed scope and dependencies

- `backend/src/apps/focus/{index,repository}.ts`; app-local timer types only if needed for typing (no domain transition changes).
- `frontend/src/apps/focus/` (existing hook/components/API plus small app-local notification modules/components/tests).
- `backend/test/integration/focus.test.ts`, relevant Focus user-isolation tests if already separated, `frontend/e2e/focus.spec.ts`.
- `frontend/src/styles/apps.css` only for Focus-scoped notice/control styling; `apps/focus/README.md`; this worklist.
- FOCUS-N1 provides terminal verification for N2; N2 provides confirmed completion to N3; N4 validates the combined result.

## Explicit non-goals and practical limitations

No push service, service worker, new scheduler job, global notification center, route-persistent observer, auto-starting breaks, or migration. Navigating away from both mounted Focus surfaces stops observation. Closing/suspending the browser, device sleep, network loss, background timer throttling, OS Do Not Disturb, muted output, permission denial, and unsupported browser facilities can delay or suppress optional external alerts. An open mounted page can reconcile when execution/visibility resumes; this batch does not promise a wakeup alarm or background delivery SLA. No notification of old historical sessions on reopening the app. Cross-browser/device exactly-once delivery is outside scope.

## Acceptance and regression matrix

| Area | Required evidence |
| --- | --- |
| Foreground page | Short real session completes, explicit persistent completion notice appears promptly after deadline reconciliation without manual Refresh; next duration stays identifiable. |
| Dashboard | Same behavior in widget; start/pause/resume/stop/dismiss/test controls do not navigate the card. |
| Completion truth | All three kinds notify; manual stop and pause do not; cross-tab cancellation and replacement cannot become a false completion; post-expiry 409 self-heal can report verified natural completion. |
| Timing | No premature completion from floor-to-zero; resume gets new deadline; late callbacks reconcile once; bounded retry after offline/server failure; existing monotonic-clock tests stay green. |
| Races/lifecycle | Reordered responses, old deadline, mutation overlap, StrictMode replay, unmount and user change cannot announce stale state; disabled/unauthenticated paths cannot show success. |
| Deduplication | Repeated polls/rerenders and simultaneous local observers create at most one external alert per confirmed session; dismissed session does not replay on remount; cross-tab claim path tested if implemented. |
| Identity | Exact-session endpoint and preferences/claims isolate two users; stale callbacks cannot deliver the previous user's notice. |
| Optional APIs | Permission request only on click; granted/denied/default/unsupported/insecure/throwing Notification cases; audio allowed/suspended/rejected/missing; storage denial; no optional-API failure removes visible notice or breaks controls. |
| Accessibility | Visible named completion status and keyboard-operable dismissal/controls; no auto-dismiss or forced modal interaction. |
| Existing behavior | Focus history/statistics/settings, pause/resume/cancel, restart recovery, per-user ownership, app disable/enable and existing Focus concurrency tests pass. |

Use deterministic injected backend clocks and frontend fake timers for semantic cases. E2E should exercise the foreground completion notice and dashboard controls against the real backend with a short session; mocked browser notification/audio assertions verify invocation/fallback, not OS display or audible hardware output.

Canonical final gates: `npm run check`, `npm run build`, `npm test`, `npm run test:integration`, `npm run e2e`, `./scripts/verify.sh`, `git diff --check`, expected `git status`; then independent final-reviewer acceptance and normal commit/push/CI workflow. Record actual executed outcomes and any environmental limits rather than marking blocked gates passed.

## Checkpoint and change record

- Architect inspection: confirmed reported foreground scope and root cause. Earlier consideration of a generic shell observer was rejected after the user's foreground clarification; no platform exception is requested.
- Reviewer checkpoint: ACCEPTED — independently checked the existing hook ordering/monotonic clock, terminal-history model, user-scoped routes, AuthContext interface, and widget controls. App-local scope and acceptance matrix are sufficient; preference persistence and cross-tab Web Locks remain optional, with per-document user/session alert deduplication sufficient for this batch.
- Implementation begins only after checkpoint acceptance. Record any necessary plan amendment and its reason here.

## Execution record

- Confirmed the original missing-notification behavior with the new foreground E2E against an isolated archive of baseline `59ae388`: timer started successfully, but no `.focus-completion` appeared (expected regression failure).
- Implemented exact-session terminal lookup and mounted Focus page/widget completion notices; optional sound and browser notifications are explicit opt-ins. Preferences remain in document memory, per user, with bounded session claims. No Core, migration, shell, or App Contract changes.
- Reviewer found a dashboard clipping regression in the initial notification controls: on a 416×288 card the action bottom reached 315 px, and on 256×192 it reached 333 px. Fixed with a compact notice, an Alerts disclosure, Focus-local internal scrolling and short-height presentation. Added real-browser default/minimum geometry and disclosure regression coverage. The initially empty live region remains accessibility-visible using visually-hidden positioning rather than display:none.
- Existing local instance and data remain untouched. All tests use dedicated temporary PostgreSQL databases and separate preview ports. Final gate counts and cleanup are recorded below when complete.

- Local canonical results: `npm run check`, `npm run build`, `npm test` (backend 196 / frontend 474), `npm run test:integration` (362), full `scripts/verify.sh` with no DB skips, and full `npm run e2e` (46) PASS. Final build includes the last accessibility CSS correction. Default/minimum card geometry also passed a focused real-browser run.
- Final independent review: **ACCEPTED**, after direct code/test/doc review and inspection of browser geometry/screenshots. The final accessibility/geometry focused run passed 2/2, including the initially empty live-region check. Commit/push and successful CI remain required. Browser automation validates DOM layout, API invocation/fallback and timing; it does not certify physical audio output, OS notification presentation or screen-reader hardware output.
