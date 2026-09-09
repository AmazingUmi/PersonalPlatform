# FE Motion Worklist — Pocket Pixel OS interaction feedback

## Objective

Upgrade the frontend from static pixel UI to a pixel desktop system with game-UI
operation feedback, via a single centralized Motion System built on Anime.js v4.
Motion is presentation-only: removing the animation layer must leave all
functionality intact.

## Current gap

- Zero JS-driven animation; only `--motion-fast: 80ms` token, 5 `steps()` keyframes
  (loading blink, clock blink/pulse/ring), a few hover transitions.
- Dialogs / MobileNav panel / pages mount instantly with no feedback.
- Dashboard drag/resize commit with no pick-up / drop / rejection feedback.
- 2048 board is positional `number[][]` re-render (no tile identity → no move
  animation possible).
- No JS-side `prefers-reduced-motion` handling (CSS kill-switch exists at
  `base.css:140-149`).

## Architecture decisions

### Library

- `animejs@^4.5.0` (current stable). Official React pattern: `createScope({ root })`
  inside `useEffect`, cleanup `scope.revert()`. No other animation framework.
- Two engines, chosen per case:
  - `waapi.animate()` — one-shot feedback (pop / shake / flash / entrance pulses).
    Cheap, off-main-thread. Feature-detected (`el.animate` exists) — in jsdom it
    no-ops.
  - JS `animate()` + `stagger()` — staggered multi-element entrances where a
    scope is already mounted (dashboard load, app grid first paint).
- No animation completion callback may drive business state. No `setTimeout`
  choreography; WAAPI `onfinish` / `animationend` only as visual hints.

### Ownership rule (Dashboard — critical invariant)

`.dashboard-card` owns `left/top/width/height` (placement) and its `transform`
while dragging (`CSS.Translate.toString(transform)`, Dashboard.tsx:835).
Anime.js never touches those. A new presentation-only wrapper
`.dashboard-card__inner` (wrapping the hit-area / PixelWindow) is the only
animation target inside a card. Drag/resize/ghost/persistence behavior is frozen.

### New module

```
frontend/src/shared/motion/
├── motionTokens.ts    # durations, distances, scales, stagger steps (single source)
├── pixelEasings.ts    # quantized easing fns (pixel feel; no smooth springs)
├── reducedMotion.ts   # prefersReducedMotion() + useReducedMotion() hook
├── useAnimeScope.ts   # React-safe scope wrapper: createScope + revert, StrictMode-safe
├── pixelEntrance.ts   # entrance presets (page/window/list stagger)
└── pixelFeedback.ts   # feedback presets (pop, shake, flash, dropSnap, tick)
```

All call sites use tokens + presets. No local magic numbers (no `duration: 173`).

### Motion tokens

JS (`motionTokens.ts`) and CSS (`tokens.css`) kept in lockstep:

```
instant 0ms / fast 80ms / normal 140ms / slow 200ms   (guide §29: 80–160 band,
                                                       slow reserved for overlays)
stagger step 35ms
distance-xs 2px / distance-sm 4px / distance-md 8px
```

Existing `--motion-fast: 80ms` keeps its value; add `--motion-instant/normal/slow`
and `--motion-distance-xs/sm/md`.

### Reduced motion

- CSS: existing global kill-switch (durations → 0.01ms) already covers CSS
  animations/transitions.
- JS: every preset checks `prefersReducedMotion()` first and skips. All
  animations animate *from* an offset *to* the element's natural state, so
  skipping leaves correct visuals (never opacity-0 stuck states).

### CSS vs Anime.js responsibility

- CSS: hover/active/focus states, state-class transitions, mount-time keyframes
  (dialog entrance, handle pop, new `<li>` entrance), reduced-motion kill-switch.
- Anime.js (via `shared/motion`): staggered multi-element entrances, drag/drop
  feedback, invalid-drop shake, mode-switch ticks, one-shot pulses tied to
  events not expressible as class changes.

## Batches

### FE-MOTION-0 — Foundation

Install animejs; create `shared/motion` (6 files above) + CSS motion tokens;
unit tests for tokens/easings/reduced-motion/scope cleanup (jsdom:
`Element.prototype.animate` stubbed for WAAPI path).
`prefersReducedMotion()` must be absent-safe when `window.matchMedia` is
undefined (Dashboard.test.tsx deliberately runs branches without a stub) —
default to "no preference", never throw.

### FE-MOTION-1 — Shell & global UI

- `.page` entrance: fade + translateY(dist-sm) 120ms, header/content stagger
  (CSS keyframes — replay on route remount; final state = natural state).
- Dock: active item background/shadow/accent transitions + `▸` marker slide
  (CSS only, steps(1)).
- MobileNav: backdrop fade + panel slide-up/scale entrance (CSS); exit feedback
  via internal `closing` phase (animationend-driven unmount, reduced-motion →
  immediate). The closing phase is non-interactive immediately
  (`pointer-events: none` on backdrop + panel) so a missed `animationend`
  (jsdom, overridden animation) can never block input; the unmount handler
  filters `event.animationName`/`event.target` (child animations bubble);
  re-open during closing cancels the pending phase. Close paths that animate:
  backdrop click + toggle click. Escape and route-change close unmount
  immediately (no exit phase) — those paths must stay latency-free.
- Dialog (`.px-dialog-backdrop` / `.px-dialog`): CSS entrance — backdrop fade,
  window scale 0.96→1, form controls micro-stagger. Instant unmount preserved.

### FE-MOTION-2 — Dashboard (frozen behavior + `.dashboard-card__inner`)

- Load: visible card inners stagger (opacity/translateY/scale, 35ms step),
  once per mount, desktop + mobile flow.
- The wrapper adds `.dashboard-card__inner { height: 100% }` so the
  card → inner → (hit) → px-window fill chain keeps working
  (`.dashboard-card__hit { height: 100% }` shell.css:450; canvas window fill
  apps.css:60; auto height in mobile flow is harmless).
- Edit mode: drag/resize handles pop (CSS mount keyframes); canvas accent flash.
- Drag start: inner scale →1.01 + lifted shadow/brightness (class + JS pulse).
- Valid drop: inner scale 1.01→0.985→1 snap ("click" settle).
- Invalid drop: existing danger outline + short x-shake on inner.
- Resize: badge entrance (CSS), start emphasis, commit snap, invalid shake —
  via a presentation-only `feedback` signal `{key, kind, id}` from Dashboard to
  cards. Numeric resize semantics untouched.

### FE-MOTION-3 — App Center + core apps

- App Center: grid first-paint stagger (scope), customize dialog inherits
  dialog entrance, enable/disable success → icon flash + badge pulse (JS preset
  on state flip; busy state untouched).
- Tasks: checkbox pop + row done-state transition (CSS); new-row entrance (CSS
  mount keyframe — keyed `<li>` only animates newly mounted rows). No data
  semantics change (completion stays PATCH → refetch).
- Clock: digit group tick on change (seconds/minutes, WAAPI 60ms, skipped under
  reduced motion); digital↔analog face swap entrance (key-remount CSS); focus
  state emphasis transitions. Time math untouched.
- Focus: progress fill `width` transition (linear, 1s); running/idle emphasis
  transitions; completion pulse (class-keyed CSS).
- Notes/Assets: inherit list entrance patterns only (`.notes-note`, `.inv-card`
  mount keyframe). Nothing extra.

### FE-MOTION-4 — Mini game 2048

- `logic.ts`: keep all existing pure fns + tests; add tile-identity layer
  (`Tile {id, value, r, c}`, `applyMove(tiles, dir) → {tiles, gained, moved,
  mergedIds, movedTiles}`) with equivalence tests vs `moveBoard`, including
  double-merge suppression boards (`[4,4,8]` → `[8,8,0,0]`, `[2,2,4]` → `[4,4]`
  — a tile merged this move must not merge again) and structural spawn checks
  (exactly one new tile on a previously empty cell, value ∈ {2,4}).
- Component: state = tiles; derive board for save/canMove/over (save format
  unchanged). Render: background grid + absolutely-positioned `.game__tile`
  (transform translate, CSS transition). Merge pop / spawn scale-in / game-over
  board pulse. Rapid input: no lockout; state synchronous, visuals retarget.

### FE-MOTION-5 — QA / a11y / perf

- New e2e: reduced-motion smoke (`page.emulateMedia({ reducedMotion: 'reduce' })`)
  covering dashboard drag/resize, dialog, app center, 2048.
- New e2e: 2048 rapid keyboard mash → consistent state + save.
- Unit: scope cleanup / StrictMode double-mount / dashboard transform ownership /
  MobileNav close phases / animation-skip parity.
- Perf review: transform/opacity only in JS animations; no per-frame layout
  reads; entrances run once (refs guard re-entry).

## Dependencies

FE-MOTION-0 blocks all. 1/2/3/4 are independent of each other (3 partially
builds on 1's dialog/CSS work for consistency). 5 last.

## Allowed file scope

```
frontend/package.json (+lock)          # animejs only
frontend/src/shared/motion/            # new
frontend/src/styles/*.css              # motion tokens + keyframes/transitions
frontend/src/shell/{App,AppDock,MobileNav,AppCenter,Dashboard}.tsx (+tests)
frontend/src/shared/ui/                # ConfirmDialog entrance, PixelWindow hooks if needed
frontend/src/apps/{clock,focus,tasks,notes,assets,mini_game}/  (+tests)
frontend/e2e/                          # new specs
doc/FRONTEND_MOTION_SYSTEM.md          # new
doc/PersonalPlatform_PIXEL_UI_DESIGN_GUIDE.md  # §29/§43 motion guidance update
```

Platform core, backend, migrations, app contracts, dashboard layout data
format: untouched.

## Non-goals

- No route-transition choreography; no page exit animations.
- No spring physics, blur, glassmorphism, particles, parallax.
- No changes to data models, API flows, event names, persistence formats
  (2048 save payload stays `number[][]`).
- No rewrite of dashboard placement into an animation engine.
- No per-frame JS loops (clock/focus keep existing tick cadence).
- No visual redesign — borders, shadows, palette, spacing, fonts unchanged.

## Acceptance criteria

1. All existing unit tests (298) and e2e tests (34) pass unmodified.
2. `prefers-reduced-motion: reduce`: every page fully usable (drag, resize,
   dialogs, 2048); animations skipped, no stuck/stale states.
3. Removing animejs imports (simulated by skipped animations) leaves features
   functional — no business logic awaits animation completion.
4. StrictMode double-mount: no accumulating animations; unmount reverts scopes.
5. Dashboard: dnd-kit transform on `.dashboard-card` remains the only writer of
   that transform; placement/resize/persistence tests untouched and green.
6. No magic durations in call sites — all via motion tokens/presets.
7. Gates: `npm run check`, `npm test`, `npm run build`, `npm run e2e` (frontend),
   root `npm run check/build/test`, `npm audit --audit-level=high` clean.

## Regression matrix

| Area | Existing coverage | New coverage |
| --- | --- | --- |
| Dashboard layout/drag/resize | Dashboard.test.tsx (46), dashboardLayout.test.ts (79), platform.spec.ts drag/resize/persist | transform-ownership unit test; drop/resize feedback signal test |
| Dialog semantics | AppCenter.test.tsx etc. | mount/unmount + escape-under-animation unit; e2e dialog open/confirm |
| MobileNav | ui.spec.ts mobile nav | close-phase unmount unit tests (manual `animationend` dispatch — jsdom runs no CSS): animationName/target filtering, Escape-during-closing, re-open-during-closing, route-change close |
| 2048 logic | logic.test.ts (21), index.test.tsx, platform.spec.ts save | tile-move equivalence tests; rapid-input e2e |
| Reduced motion | base.css kill-switch (untested) | e2e reduced-motion spec; JS skip unit tests |
| Clock/Focus/Tasks semantics | existing per-app tests | tick/mode-switch/progress tests where behavior-adjacent |
