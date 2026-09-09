# FE Polish Final Worklist — Shell status, widget density, interaction completion

## Objective

Close the remaining Dashboard-polish gaps after Phase 9–11 and FE-MOTION:
dock/top-bar become a real Personal OS status surface (badges + accents +
clock), dashboard cards gain hover/pressed pixel feedback, widgets gain
low-density visualizations (Assets category distribution, Tasks today
progress, Focus state styling, Clock NEXT countdown), plus a paper-noise
background layer and restrained number pulses. No behavior redesign —
visual/informational completion only.

## Current gap (audit 2026-09-09)

- Dock: no per-app badges; `--app-accent` never resolves in dock scope
  (tokens.css defines it only under `[data-app]`), so active icons are all
  `--px-primary`; active marker is a small `▸` glyph.
- TopBar: only "N apps active" badge — no clock, no task/focus status.
- Assets widget: counters + recent items only, no category distribution.
- Tasks widget: counters only, no completion meter (`/summary` lacks a
  done-today count; `completed_at` column exists).
- Focus widget: single muted state style for READY/FOCUSING/PAUSED.
- Dashboard cards: no hover lift / pressed states on `.px-window`.
- Background: grid only, no paper texture layer.
- Number pulses exist as presets (`pop`) but are wired only to clock digits.
- Clock widget expanded NEXT row has no "in Xm" countdown (page has one).
- Notes app has no lightweight count endpoint (`GET /notes` returns all rows).

## Architecture decisions

### Shell app-status system (generic, no shell→app coupling)

Extend `FrontendAppModule` with an OPTIONAL provider, mirroring the existing
`widgets` pattern (app declares, shell renders generically):

```ts
interface AppStatusChip { id: string; label: string; tone: "neutral"|"info"|"success"|"warning"|"danger"; title?: string }
interface AppStatusProvider { load(): Promise<AppStatusChip[]>; subscribe?(onChange): () => void }
```

- New `shell/AppStatusContext.tsx`: provider component (mounted inside
  BrowserRouter) + `useAppStatuses()` hook returning `Map<appId, chip[]>`.
- Refresh triggers: mount, pathname change, window focus, provider
  `subscribe` events, 60s interval while visible (safety net).
- Failures (incl. 404 disabled app) hide that app's chips silently — status
  is decorative, never an error surface.
- Providers live in each app's frontend slice:
  - tasks: `GET /summary` → `{today}` chip (label = count, hidden at 0).
  - assets: `GET /summary` → `{items}` chip (hidden at 0).
  - focus: `GET /state` → `●` chip while a session is active;
    `subscribe` reuses the existing `"focus"` BroadcastChannel (a second
    channel instance in the same document does receive the posts).
  - notes: NEW `GET /summary` → `{total}` chip (hidden at 0).
  - clock / mini_game: no provider (no meaningful live count).
- The context is mounted with modules already intersected to ENABLED apps
  (`enabledAppModules`), so disabled apps never poll. `useAppStatuses()`
  returns an empty Map when no provider is mounted (defensive default for
  direct-render tests like MobileNav.test.tsx) — never throws.
- Badges render in AppDock rows, MobileNav rows, and TopBar compact chips.
  Badge text is `aria-hidden` everywhere (accessible names stay stable);
  badges are hidden in the ≤959px 64px icon-only dock mode; TopBar chips
  hidden < 600px. Dock/mobile links keep/pin `aria-label={displayName}`.
  Badges are REAL data only, hidden at zero.

### Dock accents + active indicator

- Inline `--app-accent: var(--px-<accent>)` on each app dock item (resolved
  presentation accent, user override wins — FP-6 resolver reused).
- Active `::before` marker upgraded from `▸` glyph to a CSS block (`▌`-like
  4px accent bar); inactive stays hidden; icon-only mode keeps inset bar.

### TopBar

- Real clock `HH:MM` (minute tick, 24h, pixel font) + provider chips +
  existing apps-active badge. Same 56px height; chips hidden < 600px.

### Card hover/pressed (motion ownership preserved)

- Token: `--shadow-pixel-hover: 6px 6px 0 var(--px-shadow)`.
- Scoped to navigable cards only:
  `.dashboard-card__hit:hover/.focus-visible .px-window` → translate(-2px,-2px)
  + hover shadow (steps(2), `--motion-normal`); `:active` → translate(1px,1px)
  + `--shadow-pixel-sm`. Edit-mode and error-fallback cards (no `__hit`)
  unchanged; dnd-kit transform on `.dashboard-card` untouched; JS pulses
  still target `.dashboard-card__inner` (different node — no conflict). The
  existing `.px-window` transition list (shell.css drag states — box-shadow/
  filter) is EXTENDED with `transform`, never replaced.

### Widget visualizations

- New shared `PixelMeter` (segments bar, div-based, `role="img"` +
  aria-label; CSS steps(4) width transition; reduced-motion safe).
- Assets normal/expanded: fetch `/categories` (id+name), render TOP-3 by
  item count from existing `counts.categories` facet + PixelMeter each;
  degrades to nothing when no categorized items.
- Tasks: `/summary` gains additive `doneToday` (completed_at within
  platform-local today via ctx.time) and `overdueBeforeToday` (status <> done,
  due_at < window start). The three meter segments are DISJOINT by
  construction (status-disjoint done-today vs open-by-due-window), fixing the
  double-count the existing `today`/`overdue` overlap would cause
  (a task due 9am still todo at 10am matches both counters). Widget
  normal/expanded renders a TODAY meter = doneToday / (doneToday + today +
  overdueBeforeToday), hidden at 0/0; the OVERDUE stat block keeps showing
  the unchanged `overdue` counter.
- Focus widget: `data-state=ready|focusing|paused` + `data-kind`;
  state line + digits get per-state colors (neutral / coral / warning;
  break kinds → info). No logic changes.
- Clock widget expanded NEXT row: `· in {humanDuration}` countdown from
  `next.startAt` vs minute-level now (reuses clock/timeMath).
- 2048 widget: high score value pulses via `pop` on change; visual framing
  of the existing large stat (no new stats — backend keeps `{highScore}`).
- Number pulses: shared `usePulseOnChange(ref, value)` hook calling the
  existing `pop` preset; wired to Tasks stat values + 2048 high score only
  (never per-second timers).

### Background texture

- `body::before` fixed overlay: inline SVG feTurbulence data-URI at ~2.5%
  opacity, pointer-events none, behind all surfaces (surfaces are opaque —
  grain shows only on the paper background). No external assets.

#### Implementation deviations (recorded post-review, final-review finding 2/3)

- Paper noise shipped as the FIRST `background-image` layer on `body`
  (base.css) instead of a `body::before` overlay — visually equivalent
  (opaque surfaces cover it; no stacking-order risk at all) and one rule
  smaller. Guide §7.1 documents the shipped form.
- `PixelMeter` segments toggle instantly with no width transition:
  discrete `████░░` blocks stepping between values is the honest pixel
  reading; a width tween would soften it against the motion principles
  (§29: fast, mechanical, quantized). Reduced-motion trivially safe.

## Task breakdown

| # | Task | Files |
| --- | --- | --- |
| FE-1 | appTypes status types + AppStatusContext + 4 app providers + notes backend `/summary` | shared/appTypes.ts, shell/AppStatusContext.tsx(+test), apps/{tasks,assets,focus,notes}/…, backend notes index.ts(+test) |
| FE-2 | Dock badges + accent vars + block indicator | shell/AppDock.tsx(+test), MobileNav.tsx, styles/shell.css |
| FE-3 | TopBar clock + status chips | shell/TopBar.tsx(+test), App.tsx, styles/shell.css |
| FE-4 | Card hover/pressed + shadow token | styles/tokens.css, styles/shell.css |
| FE-5 | PixelMeter + Assets top-3 | shared/ui/PixelMeter.tsx(+test), apps/assets/index.tsx(+test), styles/components.css |
| FE-6 | Tasks doneToday + meter | backend/src/apps/tasks/index.ts(+test), apps/tasks/index.tsx(+test), styles/apps.css |
| FE-7 | Focus state visuals | apps/focus/FocusWidget.tsx, styles/apps.css |
| FE-8 | Clock countdown + pulse hook + 2048 polish | apps/clock/ClockWidget.tsx(+test), shared/motion/usePulseOnChange.ts(+test), apps/mini_game/index.tsx, styles/apps.css |
| FE-9 | Paper noise layer | styles/base.css |
| FE-10 | Guide §9/§10/§18 update | doc/PersonalPlatform_PIXEL_UI_DESIGN_GUIDE.md |

Dependencies: FE-1 blocks FE-2/FE-3. FE-5 before FE-6 (meter reuse).
Rest independent.

## Allowed file scope

```
frontend/src/shared/{appTypes.ts, motion/}
frontend/src/shared/ui/PixelMeter.tsx
frontend/src/shell/{App,AppDock,MobileNav,TopBar}.tsx + AppStatusContext.tsx (+tests)
frontend/src/apps/{tasks,assets,focus,notes,clock,mini_game}/ (+tests)
frontend/src/styles/*.css
backend/src/apps/notes/index.ts (+test)
backend/src/apps/tasks/index.ts (+test)
doc/PersonalPlatform_PIXEL_UI_DESIGN_GUIDE.md
```

Platform core, migrations, app contracts, dashboard layout persistence
format, event names: untouched.

## Non-goals

- No new animation library (anime.js only, existing presets).
- No mock/fake data; badges hidden rather than zero-padded.
- No backend changes beyond two additive app-local read endpoints/fields.
- No dark theme, no glassmorphism/gradients/radius changes.
- No restructuring of Dashboard layout/drag/resize (frozen since Phase 11).

## Acceptance criteria

1. Dock: active item shows app accent (user override respected) + block
   indicator; badges reflect live counts (tasks/assets/notes) and focus ●.
2. TopBar shows real clock + status chips + apps-active; height unchanged.
3. Dashboard cards lift on hover/focus, press down on :active; edit-mode
   drag/resize behavior identical (regression tests untouched).
4. Assets widget shows TOP-3 category meters when data exists.
5. Tasks widget shows TODAY completion meter with honest doneToday math.
6. Focus widget states visually distinct; timer behavior unchanged.
7. Clock expanded NEXT shows countdown; no fake data paths.
8. prefers-reduced-motion: no stagger/pulse/hover transitions; all usable.
9. All existing unit/e2e tests pass; new tests cover status system, meters,
   doneToday, notes summary, countdown, pulse hook.
10. Canonical gates pass (`npm run check/build/test/test:integration/e2e`,
    `./scripts/verify.sh`, `git diff --check`).

## Regression matrix

| Area | Existing coverage | New coverage |
| --- | --- | --- |
| Dock/nav rendering | App.test.tsx, ui.spec.ts | badge + accent var + provider wiring tests |
| TopBar | App.test.tsx, ui.spec.ts | chip row + clock (fake timers) tests |
| Dashboard drag/resize/persist | Dashboard.test.tsx (1060), platform.spec.ts | untouched; hover CSS only (no transform on .dashboard-card) |
| Tasks summary semantics | tasks app tests | doneToday boundary (start-of-day window via ctx.time) |
| Notes API | notes app tests | /summary total + disabled-app 404 |
| Assets widget | assets tests | top-3 derivation + degrade-at-empty |
| Motion | motion tests + motion.spec.ts | pulse hook skip under reduced motion |
```
