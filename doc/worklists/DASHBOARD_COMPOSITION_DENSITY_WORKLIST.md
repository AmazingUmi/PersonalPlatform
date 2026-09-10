# DASHBOARD_COMPOSITION_DENSITY_WORKLIST

## Objective

Dashboard Composition & Density Pass: keep the established Pixel / Personal OS visual
language, improve the default composition, horizontal space utilization, information
density and content hierarchy. "More mature", not "more decorated".

## Current gap (verified against the running app at 1600×900)

1. Default layout leans top-left; row 1 (clock 28 + focus 22 + assets 20 = 72/80 units)
   leaves 8 units unused, row 2 (58/80) leaves 22 units (~350px) of dead space.
2. Clock hero is a tall 448×544 column; the task title and elapsed time each appear
   twice (face focus line + agenda row).
3. Focus widget: the 25:00 number is small and ~30% of the card is blank.
4. Reset Layout (low-frequency, destructive) sits next to Edit Layout in normal mode.
5. Quick Note / 2048 have low internal hierarchy at their default sizes.

## Decisions

- **Default composition = Horizontal Hero (Layout A)**, capacity-relative:
  `[clock hero = full row] [tasks | focus | assets] [notes | 2048]`.
- `generateDefaultLayout` scales default widths by `canvasCapacity / 80`
  (reference = `--content-max` 1280px / GRID_SIZE 16 = 80 units) and justifies
  multi-member rows to fill the canvas, so every desktop capacity (44–80 units)
  gets full-width rows instead of a staircase. Heights stay content-driven.
- `WidgetLayoutSpec.defaultOrder?: number` (additive, optional, app-owned):
  default-composition reading order for Reset + fresh-install auto-placement.
  Sort: `defaultOrder` (missing = last), then footprint desc, then registration.
  User-saved layouts and legacy V1 orders are never reordered.
- Auto-placed widgets (fresh install / newly shipped app) now clamp their size to
  the canvas before placement — fixes a latent overflow when a default is wider
  than the canvas (the new 80-unit hero would have hit it).
- Clock hero becomes horizontal at expanded density (w ≥ 44 units): face left,
  CURRENT/NEXT agenda right, mode toggle + remaining strip in one bottom row.
  Task title and elapsed each render exactly once (in the agenda); the face's
  focus line and the analog meta line are hidden inside the hero.
- 2048 widget adds CURRENT score + BEST TILE from the existing
  `GET /api/apps/mini_game/saves` endpoint (score + board are already there);
  high score stays the lead metric. No backend change.
- Reset Layout moves into Edit Mode (normal mode shows only Edit Layout).
  Reset remains reachable: Edit Layout → Reset Layout, including narrow/mobile.

## New default geometry (grid units, declared by each app)

| widget    | default  | min   | density                          | defaultOrder |
| --------- | -------- | ----- | -------------------------------- | ------------ |
| clock     | 80 × 20  | 16×12 | normal {18,12}, expanded {44,16} | 10 |
| tasks     | 26 × 18  | 16×10 | normal {18,12}, expanded {20,16} | 20 |
| focus     | 26 × 18  | 16×12 | —                                | 21 |
| assets    | 26 × 18  | 14×10 | normal {16,12}, expanded {24,16} | 22 |
| notes     | 48 × 18  | 14×10 | normal {16,12}, expanded {22,14} | 30 |
| mini_game | 31 × 18  | 12×12 | —                                | 31 |

At the 80-unit reference canvas: hero 1280×320, satellites 3×416×288,
notes 768×288 + 2048 496×288 — zero horizontal slack.

## Task breakdown

1. `shared/appTypes.ts`: `WidgetLayoutSpec.defaultOrder`.
2. `shell/dashboardLayout.ts`: reference-units scaling + row justification in
   `generateDefaultLayout`; `defaultOrder`-aware auto-placement sort; clamp
   auto-placed sizes to the canvas.
3. `shell/Dashboard.tsx`: default-order composition for Reset; header actions
   (Reset only in edit mode); dashboard header row layout.
4. App layout specs (clock/tasks/focus/assets/notes/mini_game `index.tsx`).
5. `ClockWidget`: horizontal hero + agenda dedup.
6. `FocusWidget`: 44px timer panel, pips inside the panel, full-width controls.
7. `TasksTodayWidget`: remaining line; `QuickNoteWidget` layout; `HighScoreWidget`
   current-run stats.
8. `apps.css`: hero-wide styles, focus/tasks/notes/game density styles, dashboard
   header row.
9. Tests: dashboardLayout / Dashboard / ClockWidget / FocusWidget unit tests,
   platform + motion e2e (reset flow, default sizes).

## Non-goals

- No backend, schema, API, or app business-logic changes.
- No App Center / Settings / Sidebar / TopBar restyling; no palette, texture,
  animation or decoration additions.
- No changes to drag/resize/hide/reset semantics or persistence format (V2).
- No re-styling of PixelWindow or app detail pages.

## Acceptance criteria

- Default layout at 1600×900: no large right-side whitespace; first screen shows
  the hero + the tasks/focus/assets row; clock is still the hero.
- Clock renders the current task title and elapsed exactly once each.
- Focus has no large blank zone; the timer is the card's first visual element.
- Tasks / Notes / 2048 look composed at zero data.
- Reset Layout is absent from normal mode, present in edit mode.
- Existing persisted layouts render unchanged; reset applies the new defaults;
  fresh install matches reset; 1600/1440/1280/960/narrow show no overflow,
  overlap, clipping, or broken drag/resize.
- Canonical gates pass (`npm run check`, `build`, `test`, `test:integration`,
  `e2e`, `scripts/verify.sh`).

## Regression matrix

- Reset → defaults (unit + e2e, new sizes at the e2e canvas).
- Fresh install auto-placement collision-free + never persisted on load (e2e).
- Legacy V1 order migration still honors the user's order.
- Saved V2 layouts: clamp, collision repair, resize/drag isolation unchanged.
- Narrow viewport: flow layout, normal density, no horizontal overflow.
- Clock page (non-widget) rendering unchanged.
