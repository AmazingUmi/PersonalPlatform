# Phase 11 — Dashboard Layout Stabilization Worklist

Baseline: `main` @ `9987613` (Phase 9 Free Layout V2 + Phase 10 Adaptive Resize complete).

## Objective

Close the four P-issues from real Dashboard usage:

- **P1** default/restored/migrated views can render overlapping cards;
- **P2** lock the resize-isolation invariant (only the resized card's `w/h` may change);
- **P3** resize must auto-save at action end (no Done required);
- **P4** a `Reset Layout` action reachable from the normal (non-edit) view.

Plus the frozen Phase 11 invariants:

```text
DEFAULT:   collision free
DRAG:      only x/y of the active card may change
RESIZE:    only w/h of the active card may change
COLLISION: reject the active action, never move others
PERSIST:   valid resize action end automatically saves
RESET:     one explicit action returns to deterministic collision-free defaults
```

## Audit results (Phase A — root causes, verified by simulation)

### A1. Default overlap root cause

`generateDefaultLayout()` row packing is collision-free at every canvas width for
homogeneous AND heterogeneous sizes (simulated 0–1920px; all pass). The same holds
for the `kind: "none"` first-load path (`findFirstFreePosition` loop) and V1
migration.

The overlap is produced by `resolveEffectiveLayout()`'s V2 branch: **runtime
clamping of saved placements at a narrower canvas**. `clampPlacement` clamps each
card's `x` toward the right edge independently, with no collision validation
afterwards. Verified failure: a layout saved at 1440px (cards at x=0/21/42/63)
opened at a 960px canvas clamps to x=0/21/40/40 — three cards stacked. At
1000–1130px the last two cards overlap. This is system-introduced overlap: saved
layouts are collision-checked at save time, so any post-clamp collision is caused
by the clamp itself.

Secondary effect: `canvasWidth` starts at 0 (clamp disabled) and flips to the
measured width after mount — the clamped (possibly overlapping) geometry replaces
the raw one within the first layout pass.

### A2. Layout creation paths (current)

| Path | Algorithm | Collision-free? |
| --- | --- | --- |
| No saved layout | `findFirstFreePosition` loop | yes |
| V1 migration | `generateDefaultLayout` | yes |
| V2 missing/new widget | `findFirstFreePosition` | yes |
| Hidden → Show | `findFirstFreePosition` | yes |
| Restore default | `generateDefaultLayout` | yes |
| **Loaded V2 + clamp** | per-card `clampPlacement`, **no collision check** | **NO — the P1 bug** |

### A3. Resize commit/save path

`onResizeEnd` / `onResizeKeyDown` mutate only `draft.items[key]`; persistence
happens exclusively on Done. No action-end save exists (P3).

### A4. Can other cards move during a resize?

State-wise no: handlers touch only the resized key; edit mode renders from the
draft, not the effective memo. Remaining movement sources are passive and
runtime-only: window resize re-clamp (A1), and the 0→measured `canvasWidth`
transition. Desktop cards are `position: absolute` (no flow reflow). The
invariant needs tests, not a bug fix.

### A5. Reset/Restore behavior (current)

`restoreDefault()` generates defaults from `defaultsOf()`; edit mode sets the
draft only (persist deferred to Done — violates the new Reset contract), normal
mode persists immediately. Two differently-named entries: "Restore default"
(edit header) and "Restore default layout" (footer, only when widgets are
hidden). No confirmation.

### A6. Persistence race risks

`saveLayout` has no in-flight serialization. With resize auto-save, rapid
successive actions (held arrow keys) could resolve out of order and overwrite
newer state with stale state.

## Design freeze (Phase B)

### D1. Default placement algorithm

Keep `generateDefaultLayout()` deterministic row packing (verified
collision-free, including heterogeneous sizes and width wrapping). All creation
paths already share `rectsOverlap` / `rectIsFree` / `findFirstFreePosition`.
No rewrite.

### D2. Collision repair for loaded V2 (frozen semantics)

In `resolveEffectiveLayout()`, after clamping saved placements:

1. iterate keys in deterministic reading order (`sortForMobile`: y, then x, then
   key);
2. keep each placement that is collision-free against the already-kept ones;
3. a conflicting widget keeps its size and is repositioned with
   `findFirstFreePosition`;
4. auto-placement of unplaced widgets then runs against the repaired occupancy.

Runtime normalization only — never written back on read; the next real user save
persists the repaired geometry. Justification: saves are collision-checked, so
post-clamp conflicts are system-introduced; for hand-edited overlapping data the
repair moves only the later widget in reading order (most placements preserved).

### D3. Resize auto-save semantics

- Unified entry point `saveLayout` (serializes, updates committed `parsed`
  state, PUTs `dashboard.widgets`); in-flight saves are serialized in call
  order so responses can never apply out of order.
- Pointer resize: `pointerup` with a valid, changed size → commit draft + one
  `saveLayout`. `pointermove` never persists. Invalid release → revert, no
  save. Exactly ≤1 PUT per complete pointer action.
- Keyboard resize: each valid, changed arrow action → commit + `saveLayout`
  immediately (each key press is one discrete action; no debounce timers).
- Done: persists any still-unsaved draft changes (hides, reset-failure
  leftovers) and exits edit mode. After an auto-saved action Done persists
  the identical state — no contradictory stale save.

### D3b. Drag auto-save (added during Phase C — root-cause finding)

While stabilizing the e2e suite we identified the true mechanism behind the
Phase 10 "Dashboard Done/settings PUT intermittent hang" flake: **dnd-kit's
PointerSensor installs a document-level `click` listener with
`stopPropagation` once a pointer drag activates and only removes it 50ms
after the drag ends** (upstream `AbstractPointerSensor.detach` ->
`setTimeout(removeAll, 50)`). Any click within that 50ms window — e.g.
Playwright clicking Done right after `mouse.up()` — is silently swallowed, so
Done appears to "hang". The PUT was never at fault.

Decision: implement the optional §15 unification — **a committed drag
persists at action end**, exactly like resize. The drag e2e no longer clicks
Done after a drop; it polls the persisted setting instead, removing the race
deterministically (no sleeps, no retries). Residual known limitation (not
Phase 11 scope): a human clicking within ~50ms after a pointer drop loses
that one click — upstream dnd-kit behavior affecting all its users.

### D9. verify.sh test-database reset (added during Phase E)

`scripts/verify.sh`'s `migration:up` step failed locally with
`Not run migration 20260101000001-init is preceding already run migration
20260101000001-step1` (scope tasks). Root cause: the integration suite
(`backend/test/integration/tasks*.test.ts`) replays the REAL tasks migration
SQL through the fixture helper, which renames the files to its `step1/step2`
convention before running them against the shared `personal_platform_test`
database — leaving fixture-named records in `tasks.migrations`. The next
`node-pg-migrate` up-run (checkOrder: true, real file names) then rejects the
database state. Unrelated to the Phase 11 frontend diff and invisible to CI
(CI never runs verify.sh), but it blocked the canonical local gate. Fix:
verify.sh now resets the platform schemas (core + one per installed app) in
the test database before migrating, so the step always validates a fresh
install regardless of what ran before.

### D4. Save failure semantics (frozen)

Optimistic-local: the draft keeps the resize result, a
`Layout save failed: …` banner appears, no rollback to the old size. Reload
shows the last persisted state. (Matches the existing platform UX.)

### D5. Reset semantics (frozen)

One action named **Reset Layout**, present in the header in BOTH modes:

```text
normal:  [ Reset Layout ] [ Edit Layout ]
editing: [ Reset Layout ] [ Done ]
```

- Confirmation via the existing shared `ConfirmDialog` (pixel modal, FP-7.3):
  "Reset dashboard layout? This restores default widget positions and sizes."
- Reset restores every currently available widget (hidden cleared) at its
  `defaultW/defaultH` via `generateDefaultLayout`, and **persists immediately**
  in both modes (no Done required).
- The footer "Restore default layout" duplicate entry is removed; the footer
  keeps the "N widget(s) hidden" count text only.

### D6. Global drag/resize mutex

- `activeResize != null` → every card's draggable is disabled;
- `activeDrag != null` → resize handles are disabled;
- handler-level second line of defense: `onDragStart` rejects while a resize is
  active; `onResizeStart` rejects while a drag or another resize is active.

### D7. Accessibility

Resize handle keeps `aria-label="Resize <title>"` and gains
`aria-describedby` pointing at a visually-hidden live status
(`<w> by <h> grid units`) so the current size is announced on focus.

### D8. Unchanged contracts

- Default generation on load never writes the DB (read/default runtime only).
- Passive window resize never persists and never crashes; with D2 it now also
  repairs collisions at runtime instead of rendering overlaps.
- Widget layout specs / density contract frozen; no widget content changes.
- Mobile flow layout untouched (no desktop geometry leak, no resize on mobile).

## Tasks

| # | Task | Files |
| --- | --- | --- |
| T1 | Post-clamp collision repair in `resolveEffectiveLayout` (D2) | `dashboardLayout.ts` |
| T2 | `saveLayout` serialization; drag + resize action-end auto-save (D3/D3b/D4) | `Dashboard.tsx` |
| T3 | `Reset Layout` header action + ConfirmDialog + immediate persist; remove footer duplicate (D5) | `Dashboard.tsx` |
| T4 | Global drag/resize mutex (D6) + resize a11y (D7) | `Dashboard.tsx` |
| T5 | Pure layout tests: repair, heterogeneous defaults, resize isolation invariants | `dashboardLayout.test.ts` |
| T6 | Component tests: auto-save call counts, reset, mutex, failure, isolation | `Dashboard.test.tsx` |
| T7 | E2E: default no-overlap (pairwise boxes), resize isolation + reload without Done, drag persistence without Done, reset + persist | `e2e/platform.spec.ts` |

## Non-goals

8-direction handles, auto push/cascade/compact, group move/resize, multi-select,
undo/redo, layout history, cloud sync, mobile resize, new tables, layout V3,
density redesign, widget visual rework. (Drag action-end auto-save was
originally optional; it was promoted into scope by the D3b root-cause finding.)

## Acceptance criteria

The Phase 11 checklist from the task brief (default collision-free across
first-load/migration/new-widget/show/reset; resize isolation incl. revert;
pointer ≤1 PUT per action, move-phase 0 PUTs; keyboard auto-save; reload without
Done; Reset Layout in normal mode with confirm, deterministic defaults, hidden
cleared, immediate persist; global mutex; a11y; mobile regression; all gates
green).

## Regression matrix

| Concern | Covered by |
| --- | --- |
| Loaded V2 narrower-canvas overlap | T1 + T5 + T7 (pairwise) |
| V1 migration / first load / show / new widget geometry | T5 + existing tests |
| Resize isolation + revert | T5/T6/T7 |
| Auto-save counts (pointer 1 / move 0 / invalid 0 / no-change 0 / reset 1) | T6/T7 |
| Done after auto-save (no stale save) | T6 |
| Save failure keeps local result + banner | T6 + existing |
| Reset determinism + persistence | T6/T7 |
| Global mutex | T6 |
| Mobile 375px regression | T7 + existing |
| Existing V1/V2 compat suite | full `npm test` / e2e |
