# Phase 10 — Dashboard Adaptive Widget Resize (Worklist)

Baseline: `5edb57a` (Free Layout V2). This phase adds free resize + widget
density on top of the existing V2 placement model. It is an incremental
extension, not a rewrite.

## Objective

Desktop dashboard widgets get explicit `w`/`h` (grid units) alongside `x`/`y`:

- bottom-right anchored resize in Edit Layout (pointer + keyboard);
- sizes snap to the 16px grid, persist together with position on Done;
- resize affects ONLY the resized widget (no push, no cascade, no x/y change);
- collision geometry switches from measured DOM boxes to explicit `x/y/w/h`;
- widget content adapts via discrete density levels (compact / normal /
  expanded) driven by widget-declared integer-unit thresholds;
- mobile flow layout ignores desktop sizes entirely.

## Current gap

- `DashboardWidgetPlacement.w/h` are parsed/serialized but unused; geometry is
  derived from measured DOM sizes (`rectForPlacement(placement, pxSize)`).
- Cards have fixed 320px width and content-driven height.
- No resize interaction; no density contract; widgets render one fixed layout.

## Frozen design decisions

### D1 — Placement w/h semantics

- `{x, y, w, h}` all integers in grid units; `left = x*16`, `top = y*16`,
  `width = w*16`, `height = h*16` on desktop.
- V2 entries without `w/h` (and V1 migrations) are normalized at RUNTIME with
  widget defaults (`applyWidgetDefaults`) — never written back on read; the
  full `x/y/w/h` persists on the next user save (Done). No DB migration.
- `normalizePlacement` already keeps valid `w/h > 0`; serialization unchanged.

### D2 — Geometry source of truth (Phase 10 core architecture change)

- Desktop collision/canvas geometry comes from placement `w/h`
  (`placementRect(placement, defaults)` prefers `placement.w/h`, falls back to
  widget defaults). Per-card DOM measurement is REMOVED from Dashboard; only
  canvas width is still measured (for capacity clamping).
- Consequence: the px-based helpers `rectForPlacement`, `defaultWidgetSize`,
  `normalizeMeasuredSize`, `DEFAULT_CARD_WIDTH_PX`, `ESTIMATED_CARD_HEIGHT_PX`
  are replaced by unit-native equivalents. Existing unit tests for those
  helpers are mechanically migrated to the unit API (same cases and expected
  semantics; assertions gain `w/h` where outputs now include them —
  tightening, not loosening). The jsdom zero-measurement fallback test is
  obsoleted by design (cards are no longer measured) and is replaced by
  defaults-resolution tests.
- `clampPlacement` clamps position using `placement.w ?? defaults.w` for the
  right edge; `clampWidgetSize` clamps `w/h` into
  `[minW, min(maxW, capacity - x)]` × `[minH, maxH]`.
- Effective-layout resolve also runtime-clamps saved `w/h` to the current
  canvas (never persisted; §36 boundary tolerated: visual overlap may occur on
  narrower viewports, no crash, no auto-save).

### D3 — Widget layout contract (`shared/appTypes.ts`)

```ts
type WidgetDensity = "compact" | "normal" | "expanded";
interface WidgetLayoutSpec {
  minW?, minH?, maxW?, maxH?, defaultW?, defaultH?: number; // grid units
  density?: { normal?: {minW?, minH?}; expanded?: {minW?, minH?} };
}
interface WidgetRenderContext { layout: { widthUnits; heightUnits; widthPx; heightPx; density } }
interface WidgetDefinition { id; title; href?; layout?: WidgetLayoutSpec;
  render: (context?: WidgetRenderContext) => ReactNode }
```

- `render(context?)` is backward compatible: unadapted widgets ignore it.
- Widgets without `layout` (focus, mini_game) get platform defaults
  (20×16, min 12×8) and density `normal` forever (missing thresholds ⇒
  normal). No app-specific branches in Dashboard.

### D4 — Platform defaults (single source, no magic numbers)

```ts
DEFAULT_CARD_WIDTH_UNITS = 20   // 320px, matches V2 card width
DEFAULT_CARD_HEIGHT_UNITS = 16  // 256px, matches the old estimate
DEFAULT_MIN_WIDTH_UNITS = 12    // 192px
DEFAULT_MIN_HEIGHT_UNITS = 8    // 128px
```

`maxW` default: canvas capacity (x + w <= capacity). `maxH` default:
unbounded (canvas grows below).

### D5 — Density algorithm (deterministic, expanded wins)

```
density = compact
if w >= normal.minW && h >= normal.minH  -> normal     (defaults 18/12 when only expanded declared? NO —
if w >= expanded.minW && h >= expanded.minH -> expanded  missing normal threshold fields default to 0)
```

Thresholds are explicit integer units declared by widgets; no DOM measuring,
no hysteresis (discrete stable steps are accepted per spec §17).
Mobile renders with density `normal` and widget-default unit values.

### D6 — Resize interaction

- Handle: 16px bottom-right grip button, rendered ONLY in edit mode + desktop,
  inside the card wrapper (outside PixelWindow content). `aria-label="Resize
  {title}"`; keyboard: Arrow±1 grid unit on W/H, applied immediately when
  valid+changed (each keypress is a discrete commit to the draft), no-op on
  invalid; preventDefault/stopPropagation so dnd-kit keyboard drag and card
  navigation never fire.
- Pointer: Pointer Events + `setPointerCapture` (feature-detected for jsdom);
  move computes `w = snapToGrid(originPx + dx)`, `h = snapToGrid(...)`; snapped,
  clamped via `clampWidgetSize`; collision-checked against other placement
  rects → live card outline primary (valid) / danger (invalid) + size badge
  "W × H"; release: valid ⇒ commit `w/h` to draft (x/y untouched), invalid ⇒
  revert to pre-resize size. Draft-only during interaction; persisted on Done.
- Drag/resize mutex: dnd-kit listeners live only on the drag handle; the
  resize handle never triggers drag/hide/navigate; the resized card's
  draggable is disabled while resizing.

### D7 — Canvas growth

`canvasHeightFor` keeps consuming placement rects; the resizing card
contributes its live candidate rect so the canvas never clips a low resize.

### D8 — CSS

- Desktop media block: cards get inline `width/height` from placement (the
  fixed `--dashboard-card-w` rule is removed); `.dashboard-card .px-window`
  fills the card (`height:100%; display:flex; flex-direction:column`) with
  `__body { flex:1; min-height:0; overflow:hidden }` — generic PixelWindow
  fill, no Dashboard-specific API on PixelWindow (§28).
- `.resize-handle`, `.dashboard-card--resizing`, `--resize-invalid` (danger
  outline), transient `.dashboard-resize-badge`.
- Density is React conditional rendering keyed off `data-density` on the card
  content wrapper; container queries are NOT used for business information.
- Mobile: card style prop stays empty (no inline size) ⇒ saved `w/h` cannot
  leak into flow layout.

### D9 — First-batch widget adaptations (thresholds in units)

| widget | minW×minH | default | normal thr | expanded thr |
|---|---|---|---|---|
| clock:clock | 16×12 | 20×16 | 18×14 | 26×20 |
| tasks:today | 16×10 | 20×16 | 18×12 | 26×16 |
| assets:summary | 14×10 | 20×16 | 16×12 | 24×16 |
| notes:quick_note | 14×10 | 20×16 | 16×12 | 22×14 |

Content per density (driven by `context.layout.density`, never
`window.innerWidth`):

- **Clock** — compact: time only (digital: no top row/date/focus line;
  analog: dial only); footer mode toggle hidden. normal: current behavior
  (time, date per settings, focus line). expanded: + current task, next task,
  "N MORE TODAY" from the Tasks public status (already fetched by
  `useTaskFocus`, extended to expose next/remaining). Alarm/World Clock stay
  out of the widget.
- **Tasks** — compact: CURRENT + title + "N MORE TODAY" (public status);
  normal: existing Today/Overdue/Done stats; expanded: stats + CURRENT/NEXT/
  remaining block.
- **Assets** — compact: existing Items/Categories stats (summary endpoint);
  normal: stats + ≤3 recent items (items list, createdAt desc);
  expanded: ≤5 recent items + category count summary.
- **Notes** — compact: textarea rows=2 + Save; normal: current quick note
  form; expanded: + ≤3 recent entries (title/content preview + date).
- focus/mini_game: untouched (defaults, normal density).

## Task breakdown

1. `dashboardLayout.ts`: unit-native rework + new pure functions
   (`placementRect`, `applyWidgetDefaults`, `clampWidgetSize`,
   `resizePlacement`, `resolveWidgetDefaults`, `resolveWidgetDensity`,
   `DEFAULT_*_UNITS`); migrate `generateDefaultLayout` /
   `findFirstFreePosition` / `migrateLegacyLayout` / `resolveEffectiveLayout`
   / `clampPlacement` to unit defaults; keep parse/serialize/snap/capacity/
   collision/keyboard APIs unchanged.
2. `shared/appTypes.ts`: contract types (D3).
3. `Dashboard.tsx`: remove card measurement; spec-driven defaults; resize
   state/handle/keyboard; render context + `data-density`; ghost/preview and
   canvas height from placement rects; restore-default/show/new-widget stamp
   w/h.
4. CSS (`apps.css`, `shell.css`): D8.
5. Widgets: clock/tasks/assets/notes adaptations (D9) + per-widget layout
   specs.
6. Tests: layout math (§51 list), density algorithm (§52), Dashboard component
   resize suite (§53), widget density rendering per app.
7. E2E (`platform.spec.ts`): desktop resize persist/reload/density switch,
   invalid resize revert, 375px no fixed size/overflow.

## Known limitations / follow-ups (post-review)

1. **Pre-existing e2e flake (not introduced by this phase).**
   `platform.spec.ts:168 "dashboard: free-layout drag persists after reload"`
   intermittently fails in FULL-suite runs: after clicking Done the shell
   stays in edit mode past the 5s wait (the settings PUT appears to hang).
   Reproduced on baseline `5edb57a` with this change stashed (failures in
   2 of 5 baseline/phase full-suite runs; the test passes in isolation and
   in subset runs). Suspected backend DB connection-pool contention under
   cumulative suite load (`core/database` pool `max: 10`); needs a separate
   investigation batch — do not paper over it with larger timeouts.
2. **Runtime size clamp can reach persistence via an explicit Done.** The
   effective layout runtime-clamps saved w/h to the current canvas
   (narrow-window case); entering edit mode snapshots that clamped state, so
   pressing Done persists the clamped values. This mirrors the pre-existing
   Phase 9 x/y semantics (clamp-on-read → draft → Done) and is accepted as
   consistent; a stricter "never persist runtime clamps" rule would be a
   platform-level behavior change for a future batch.
3. Reviewer cosmetic notes fixed in-batch: dangling resize state on
   edit-mode exit (now cleared via effect), formatting, dead stub call in a
   clock test, `applyWidgetDefaults` wired into `resolveEffectiveLayout`.

## Non-goals (this batch)

Size presets, masonry/auto-compact, push-on-resize, multi-select, group
resize, aspect lock, rotate/zoom, infinite canvas, fullscreen widgets, app
page resize, mobile free resize, new DB tables/migrations, responsive desktop
collision reflow (beyond runtime clamp), container-query-driven business
content, rewriting unadapted widgets.

## Acceptance criteria

The checklist in the phase brief §57 (all boxes) plus: every canonical gate
green (`npm run check`, `npm test`, `npm run test:integration`, `npm run
build`, `npm run e2e`, `scripts/verify.sh`, `git diff --check`), CI green,
reviewer + final-reviewer ACCEPTED.

## Regression matrix

- V1 legacy array read/migrate; V2 x/y-only read (runtime defaults, no write);
  V2 full x/y/w/h round-trip.
- Drag behavior unchanged (keyboard + pointer), invalid drop revert, canvas
  growth, hide/show, restore default (now incl. sizes), auto-place of new
  widgets (now incl. sizes).
- Mobile flow layout unaffected (no inline sizes, no horizontal overflow).
- Clock page unaffected (density default normal); Tasks/Assets/Notes pages
  untouched.
