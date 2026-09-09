# Frontend Motion System

Pocket Pixel OS interaction-feedback layer, built on **Anime.js v4** (`animejs`
npm package, WAAPI engine). Motion is **presentation-only**: removing the
animation layer must leave every feature functional.

Implemented by the FE-MOTION batches (worklist:
`doc/worklists/FE_MOTION_WORKLIST.md`).

## 1. Architecture

```
frontend/src/shared/motion/
├── motionTokens.ts    # durations / distances / scales / stagger step (single source)
├── pixelEasings.ts    # CSS steps() timing functions (quantized pixel feel)
├── reducedMotion.ts   # prefersReducedMotion() + useReducedMotion() (absent-safe)
├── useAnimeScope.ts   # React-safe Anime.js scope: createScope + revert on unmount
├── runMotion.ts       # single choke point: gating (reduced motion / WAAPI) + scope tracking
├── pixelEntrance.ts   # pageEnter / windowEnter / faceEnter / listStagger
└── pixelFeedback.ts   # pop / blink / shake / dropSnap / pickUp / resizeSnap / tick
```

All JS animations route through `runMotion`, which:

1. skips under `prefers-reduced-motion: reduce`;
2. skips when the Web Animations API is missing (jsdom) instead of throwing;
3. records created animations on the component's scope (when given) so
   unmount reverts them;
4. never lets an engine error escape into render/event code.

Every preset animates **from an offset to the element's natural state** and
uses no fill mode — a skipped, interrupted or reverted animation therefore
leaves the element exactly as static CSS renders it. There are no stuck
opacity-0 states by construction.

## 2. Anime.js usage boundary

- Only `waapi.animate` (from `animejs/waapi`) and `createScope` (from
  `animejs/scope`) are used. The heavier JS/RAF engine, timelines and
  draggable are intentionally not used: every effect here is a short one-shot
  pulse or a staggered entrance with uniform step delays, all of which WAAPI
  covers off the main thread.
- React integration follows the official pattern: `createScope({ root })`
  inside `useEffect`, `scope.revert()` in cleanup (`useAnimeScope`). This is
  StrictMode-safe: the double mount cycle reverts the first scope before the
  second exists, so repeated mount/unmount never accumulates animations
  (covered by `useAnimeScope.test.tsx`).
- Component code never imports `animejs` directly — only `shared/motion`
  presets. One-shot feedback presets may be called without a scope; they
  self-terminate within `--motion-normal` and end at the natural state.

## 3. CSS vs Anime.js responsibility

| Effect | Owner |
| --- | --- |
| hover / active / focus states | CSS |
| state-class transitions (dock active, task done, focus idle) | CSS |
| mount-time keyframes (page enter, dialog enter, handle pop, new-list-row entrance, 2048 merge/spawn) | CSS |
| reduced-motion kill-switch | CSS (`base.css`, durations → 0.01ms) |
| staggered multi-element entrances (dashboard load, app grid) | Anime.js `listStagger` |
| event-tied pulses not expressible as class changes (drop settle, invalid shake, digit tick, enable flash) | Anime.js presets |
| 2048 tile movement | CSS transition on transform (position = inline style from tile r/c) |

Rule of thumb: if the browser can express it as a class change + keyframe,
keep it in CSS; reach for Anime.js only for staggered or event-driven pulses.

## 4. Dashboard transform ownership rule (critical invariant)

`.dashboard-card` owns:

- `left/top/width/height` — from the persisted placement;
- `transform` — **dnd-kit only**, while dragging (`CSS.Translate.toString`).

Anime.js therefore animates **`.dashboard-card__inner`** — a presentation-only
wrapper (with `height: 100%` to preserve the card → inner → (hit) → px-window
fill chain). Drag/resize/drop feedback (`pickUp`, `dropSnap`, `shake`,
`resizeSnap`) targets the inner wrapper only. The drop ghost, placement math,
collision checks, keyboard DnD and persistence are untouched by motion.

Card feedback is delivered via a presentation-only signal
(`CardFeedback { key, kind, id }`) emitted from `onDragEnd` / `onResizeEnd`;
it never participates in layout, persistence or interaction decisions, and
each signal id fires exactly once per card.

## 5. Motion tokens

JS (`motionTokens.ts`) and CSS (`tokens.css`) are kept in lockstep — enforced
by `motion.test.ts`, which parses `tokens.css` and compares values.

| Token | Value | CSS var |
| --- | --- | --- |
| instant | 0ms | `--motion-instant` |
| fast | 80ms | `--motion-fast` |
| normal | 140ms | `--motion-normal` |
| slow | 200ms | `--motion-slow` |
| stagger step | 35ms | — (JS only) |
| distance xs / sm / md | 2 / 4 / 8px | `--motion-distance-xs/sm/md` |

Scales (`MOTION_SCALE`): pop 1.04, lift 1.01, settle 0.985, dialog 0.96,
entrance 0.98. Durations stay inside the guide §29 band (80–160ms; `slow` is
reserved for overlay pulses). No magic durations in call sites — everything
goes through tokens/presets.

**Easing ladder — 20ms frames.** Every stepped ease keeps one intermediate
frame per 20ms (~50fps): `fast` 80ms → `steps(4, end)`, `normal` 140ms →
`steps(7, end)`, `slow` 200ms → `steps(10, end)` (`PIXEL_EASE.snap4/snap7/
snap10`; the same counts apply to the CSS `steps()` declarations). Movement
stays quantized — the pixel feel — but dense enough to read as smooth; linear
easing is reserved for opacity-only fades and the focus progress fill.

## 6. Reduced-motion strategy

- **CSS side**: the pre-existing global kill-switch in `base.css`
  (`animation-duration/transition-duration: 0.01ms !important`) neutralizes
  every keyframe/transition.
- **JS side**: `runMotion` skips creation entirely under
  `prefersReducedMotion()`. `prefersReducedMotion()` is absent-safe (returns
  `false` without `window.matchMedia`) so environments like jsdom never throw.
- **Exit animations**: the MobileNav launcher panel keeps an animated close
  for backdrop/toggle clicks, but Escape and route changes unmount instantly,
  the closing phase is pointer-inert from its first frame, and a missed
  `animationend` self-heals on the next interaction (listener is a native
  `animationend` listener filtered by target + animation name).
- Covered end-to-end by `e2e/motion.spec.ts` (`test.use({ reducedMotion:
  "reduce" })`): dashboard load/keyboard drag/keyboard resize/reset dialog,
  app center toggle round-trip, mobile nav open/close, 2048 move + save.

## 7. How a new app opts in

1. **Entrances**: put a ref on the list/container, `const scope =
   useAnimeScope(ref)`, and in a `useLayoutEffect` guarded by a once-per-mount
   ref call `listStagger(container.querySelectorAll(".item"), scope.current)`.
   See `AppCenter.tsx` / `Dashboard.tsx`.
2. **Feedback pulses**: call a preset on an element you own (from `useEffect`
   on a state flip, or an event handler): `pop(iconEl)`, `blink(iconEl)`,
   `shake(wrapperEl)` — no scope needed for one-shots.
3. **CSS-side**: new keyframes must use `var(--motion-*)` durations and
   `steps(n, end)` easing at the 20ms-frame density (fast=4 / normal=7 /
   slow=10 steps), and end at the element's natural state.
4. **Never** let a completion callback, `setTimeout`, or animation state drive
   business logic; animations observe state, never produce it.

## 8. Anti-patterns (forbidden)

- Importing `animejs` outside `shared/motion`; adding another animation
  framework.
- Magic durations/distances in call sites (`duration: 173`, `translateY: 11`).
- Animating `.dashboard-card` (or any dnd-kit-owned node) transform/geometry.
- `querySelector` sweeps across the document from unrelated components.
- `setTimeout`-based animation lifecycle choreography.
- Business state set inside animation completion callbacks; sequencing API
  requests after animations.
- Keyframes that animate an **interactive** element through a zero-size
  state (e.g. `scale(0)` on a button) — this swallows pointer input during
  the first frames (found and fixed on the dashboard drag/resize handles:
  pop the icon, never the button).
- Long smooth animations (>200ms), springs, blur, glassmorphism, particles,
  hover motion on everything — this is a pixel desktop system, not a demo
  reel (guide §29).
