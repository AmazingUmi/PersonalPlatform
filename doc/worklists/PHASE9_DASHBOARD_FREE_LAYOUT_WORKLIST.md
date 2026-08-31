# Phase 9 — Dashboard Free Layout V2 Worklist

## Objective

Upgrade the desktop Dashboard from "order + CSS Grid auto-fill + sortable" to
**Dashboard Free Layout V2**: every widget owns an independent 2D grid position
(`x`/`y`), can be dragged anywhere on the canvas, leaves empty space behind, and
never displaces other widgets. Mobile/narrow keeps normal flow.

## Current gap

- `frontend/src/shell/Dashboard.tsx` persists `dashboard.widgets = string[]`
  (order only). Visual position == array position via
  `.dashboard-grid { display: grid; auto-fill }`.
- DnD uses `SortableContext`/`arrayMove`/`rectSortingStrategy` — a sorting
  model that re-flows cards and cannot express empty space.
- Card sizes differ per app, so auto-fill produces ragged rows.

## Frozen design decisions (Phase B)

### Data model

```ts
interface DashboardWidgetPlacement { x: number; y: number; w?: number; h?: number } // w/h reserved, unused this batch
interface DashboardLayoutV2 {
  version: 2;
  items: Record<string, DashboardWidgetPlacement>; // visible widgets only
  hidden: string[];                                 // explicitly hidden widget keys
}
```

- Setting key stays `dashboard.widgets`; value becomes versioned JSON.
- Semantics: key in `items` → visible at placement; key in `hidden` → hidden;
  available key in **neither** → "unknown/new widget": auto-placed at runtime
  (first free position), NOT persisted until the next save (spec §19).
- `hidden` is required so "user hid this" stays distinguishable from "new
  widget appeared" once V2 is saved. (Spec's suggested shape omitted it; the
  two requirements §18 + §19 cannot both hold without it.)

### V1 compatibility

- Read side accepts legacy `string[]` (order). Migration (pure function):
  `order' = order ∩ availableKeys` (stale keys occupy no slot and never appear
  in `hidden`), `items = generateDefaultLayout(order', sizes, capacity)`,
  `hidden = availableKeys − order` (preserves V1 "not listed = hidden").
- No DB migration; V2 is written on the next user save.
- Malformed values (wrong shape / non-finite / negative coords) fall back to
  default layout; bad entries are dropped individually; never crash.

### Coordinate system & constants (`dashboardLayout.ts`, single source)

| Constant | Value | Notes |
| --- | --- | --- |
| `GRID_SIZE` | 16 px | logical grid unit; `left = x*16`, `top = y*16` |
| `DEFAULT_CARD_WIDTH_PX` | 320 px | desktop card width (matches V1 min column feel) |
| `ESTIMATED_CARD_HEIGHT_PX` | 256 px | pre-measurement estimate / jsdom fallback |
| `MIN_CANVAS_HEIGHT_PX` | 480 px | canvas floor |
| `CANVAS_BOTTOM_PADDING_PX` | 48 px | below lowest card |
| `COLLISION_GAP_UNITS` | 1 | min 16 px edge separation between cards |
| `DASHBOARD_DESKTOP_BREAKPOINT_PX` | 960 px | matches shell.css 959/960 dock boundary; CSS media query mirrors it with a cross-reference comment |

- Collision works in grid units: card rect =
  `{x, y, w: ceil(pxW/16), h: ceil(pxH/16)}`; rects overlap if closer than
  `COLLISION_GAP_UNITS` (inflated AABB, touching edges allowed at the gap).

### Rendering

- Desktop (≥960 px, JS `useSyncExternalStore(matchMedia)`): canvas is
  `position: relative`; cards `position: absolute; width: 320px` with inline
  `left/top` from placement. DOM order is **always** sorted by `(y, x)` so DOM
  order never decides desktop visual position and mobile reading order falls
  out for free.
- The media hook guards `typeof window.matchMedia === "function"`; when absent
  (jsdom without a stub) it deterministically reports **narrow/flow mode**, so
  legacy tests keep exercising the flow path. Desktop-mode tests stub
  `window.matchMedia` inside `Dashboard.test.tsx` (no `src/test/setup.ts`
  change needed).
- Narrow (<960 px): canvas falls back to the existing auto-fill grid flow;
  cards `position: static; width: auto`; no absolute positioning, no horizontal
  overflow; drag disabled.
- Canvas height = `max(MIN_CANVAS_HEIGHT, max(card bottom) + padding)`, grows
  while dragging (preview bottom included).

### Drag behavior

- Keep `DndContext` + `PointerSensor` (distance 4) + `KeyboardSensor`; remove
  all `@dnd-kit/sortable` usage (`SortableContext`, `arrayMove`,
  `rectSortingStrategy`, `sortableKeyboardCoordinates`, `useSortable`) **and
  drop the `@dnd-kit/sortable` dependency** from `frontend/package.json`
  (+ lockfile) so the sorting model cannot silently return.
- Cards use `useDraggable`; listeners only on the existing grip handle, only in
  edit mode, only on desktop.
- During drag: card follows pointer via dnd-kit transform; a drop ghost
  outline renders at the snapped candidate (`snap(origin + delta)`); ghost is
  valid/invalid styled. On release: valid → update only that key's draft
  placement (clamped + snapped); invalid (collision/out-of-bounds) → revert,
  no state change. No other widget ever moves; no compaction.
- Clamp: `x ≥ 0`, `y ≥ 0`, `x + width ≤ canvas width` (snaps back to the
  rightmost legal slot). Unknown canvas width (≤0) → horizontal clamp skipped.
- Sizes for collision come from measured DOM boxes (`getBoundingClientRect`),
  falling back to constants when a rect is 0 (jsdom). One measurement pass per
  render via `useLayoutEffect` ref map; width is CSS-fixed so one pass converges.

### Keyboard accessibility (spec §17, 方案 A)

- KeyboardSensor with custom `gridKeyboardCoordinateGetter` (arrow keys move
  one `GRID_SIZE` per press; Space/Enter start & drop; Esc cancels). Grid
  getter lives in `dashboardLayout.ts` as a pure function.

### Hidden / Show / Restore default / new widgets

- Hide: remove key from draft `items` (lands in draft `hidden`).
- Show: `findFirstFreePosition(size, occupied, capacity)` — deterministic
  top-left row-major scan, bounds + collision aware.
- Restore default (both modes): `generateDefaultLayout(available keys, …)` —
  deterministic left→right row packing with measured (or estimated) sizes;
  `hidden = []`. Compact by design; user layouts are never auto-compacted.
- New/unknown widgets: auto-placed via `findFirstFreePosition` at runtime in
  both modes; persisted only on next save.

### Persistence

- Edit mode works on a draft (`items` + `hidden`); `Done` → single
  `putSetting("dashboard.widgets", {version:2, items, hidden})`; on failure:
  stay in edit mode + existing error banner (unchanged). No writes during drag.

### Visual (pixel UI)

- Edit mode: faint 16 px dot grid on the canvas (CSS repeating radial-gradient,
  desktop only, `.dashboard-canvas--editing`).
- Dragging: raised z-index, slight opacity drop, pixel outline; ghost outline
  at drop target; danger outline when invalid. No glow/rotation/glassmorphism.
- New classes: `dashboard-canvas`, `dashboard-canvas--editing`,
  `dashboard-card--dragging`, `dashboard-card--drop-invalid`,
  `dashboard-drop-ghost` (+ `--invalid`). Implementation note (recorded per
  §6): the flow fallback was merged into the `.dashboard-canvas` base styles
  instead of keeping a separate `.dashboard-grid` class — functionally
  equivalent, removes the stale selector. `.app-grid` (App Center) untouched.

## Task breakdown

1. `frontend/src/shell/dashboardLayout.ts` — constants, types,
   `parseDashboardLayout`, `migrateLegacyLayout`, `generateDefaultLayout`,
   `snapToGrid`, `clampPlacement`, `rectsOverlap`, `findFirstFreePosition`,
   collision helpers, `canvasHeightFor`, `sortForMobile`,
   `gridKeyboardCoordinateGetter`, `serializeLayout`.
2. `frontend/src/shell/dashboardLayout.test.ts` — pure-function coverage per
   spec §28.
3. `frontend/src/shell/Dashboard.tsx` — rewrite orchestration: parse/migrate,
   desktop media hook, canvas width/height measurement, sizes registry,
   draggable cards, ghost preview, draft edit mode, keyboard drag, hide/show/
   restore, V2 save.
4. `frontend/src/styles/apps.css` + `shell.css` — canvas modes, edit grid,
   drag/ghost/invalid states, narrow fallback.
5. `frontend/src/shell/Dashboard.test.tsx` — keep every existing regression;
   add V2/drag/collision/persist/reload coverage.
6. `frontend/e2e/platform.spec.ts` — free-layout drag persists test (V1 reset →
   migrate → drag → others fixed → reload), mobile no-overflow check.
   focus/notes e2e keep writing V1 arrays = live V1-compat regression.

## Dependencies

Sequential: 1 → 3 → 4 → 5 → 6 (2 slots in with 1).

## Allowed file scope

- `frontend/src/shell/dashboardLayout.ts` (new), `dashboardLayout.test.ts` (new)
- `frontend/src/shell/Dashboard.tsx`, `Dashboard.test.tsx`
- `frontend/src/styles/apps.css`, `frontend/src/styles/shell.css`
- `frontend/e2e/platform.spec.ts`
- `frontend/package.json` + root `package-lock.json` (only: remove
  `@dnd-kit/sortable`)
- `doc/worklists/PHASE9_DASHBOARD_FREE_LAYOUT_WORKLIST.md` (this file)

## Explicit non-goals

- No resize (no handles, no size presets; `w`/`h` stay reserved-only).
- No masonry / `grid-auto-flow: dense` / CSS columns / auto-compaction.
- No infinite canvas (no zoom/pan/minimap/transform matrix).
- No PixelWindow changes (stays generic; layout logic lives in Dashboard).
- No platform Core / settings API changes; no DB migration; no other App edits.
- No breakpoint changes outside Dashboard.

## Acceptance criteria

All spec §35 checkboxes, in particular: 2D free positions; moving one widget
never moves others; empty space preserved; V2 persists x/y; V1 migrates;
new widget + hidden→show auto-place; no overlaps; horizontal bounds enforced;
canvas grows downward; edit-mode pixel guide; Done persists; reload restores;
Restore Default deterministic; navigation + interactive-descendant guards
intact; mobile flow without absolute positioning or overflow; gates PASS.

## Regression matrix

| Area | Covered by |
| --- | --- |
| V1 order still renders/hides correctly | Dashboard.test.tsx (existing order tests), focus/notes e2e (V1 PUTs) |
| Card click / Enter / Space navigation | Dashboard.test.tsx FP-5.2/FP-14.1 tests (unchanged) |
| Interactive descendants don't navigate | same |
| Hide / Show / Restore default | Dashboard.test.tsx + e2e hide/show test |
| Layout save failure keeps edit mode + error | Dashboard.test.tsx |
| Mobile/narrow flow, no overflow | e2e viewport test |
| Error boundary per widget | existing test unchanged |
| App enable/disable lifecycle | platform.spec.ts lifecycle test unchanged |
