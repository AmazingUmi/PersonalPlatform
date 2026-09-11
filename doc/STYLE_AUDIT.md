# STYLE_AUDIT — Pocket Pixel OS 2.0 "Living Desktop"

> Phase A deliverable for the system-level visual upgrade.
> Scope: frontend visual layer only. No backend / layout-algorithm / motion-system changes.

---

## 1. Current strengths (keep)

- **Information architecture is right**: topbar + left dock + routed content; mobile bottom nav.
- **Production-grade dashboard engine**: free 2D placement, drag/resize, density contracts,
  persistence — untouched by this pass.
- **Motion system is mature**: Anime.js v4 scoped presets, CSS-owned mounts, reduced-motion
  kill-switch, transform-ownership rules — untouched.
- **Per-app accents** (mint/yellow/coral/info/violet/warning) are established and recognizable.
- **Component primitives** (PixelWindow/Button/Badge/Meter/chips) exist and are consistent.
- **Contrast discipline**: semantic `-text`/`-light` pairings already verified ≥ 4.5:1.

## 2. Current visual problems

1. **No world.** `paper texture + 16px grid` is a pleasant *texture*, not a *place*. The page
   reads "dashboard on beige" — nothing spatial to remember.
2. **Shell reads as admin chrome.** Parchment dock + dark topbar mix warm furniture with dark
   chrome; the L-shaped "room frame" that an OS desktop needs doesn't exist.
3. **Satellite widgets share one grammar**: white rectangle + 4px accent top strip + label
   header. Only the color differs — "same card, recolored" (confirmed in baseline screenshots).
4. **App Center is a SaaS card grid**: uniform white cards, small icon squares, no
   library/shelf character.
5. **The "pixel font" doesn't exist** — `--font-pixel` falls back to plain monospace, so all
   "pixel" typography is fake (the single biggest identity gap).
6. **Flat shadow everywhere**: one 4px shadow + one 2px border for hero, satellites, dialogs,
   buttons — no depth hierarchy.

## 3. Reference extraction (principles only, no assets)

| Reference | Extracted principle | Implementation here |
| --- | --- | --- |
| Nic Chan | background is part of the scene; window↔desktop spatial gap; system-settings feel; retro + real a11y | Fixed dusk-world backdrop layer under everything; opaque parchment windows floating over it; a11y/contrast kept |
| NENRIKIDO | heterogeneous widgets = a *lived-in* desk; density variance; mixed decorative/functional, one theme | Satellites differentiated by content metaphor (spine / drawer plate / base stand / memo pad / cartridge label), not by color alone |
| WINDOWS93 | desktop → launcher → window metaphor; consistent OS chrome; taskbar/status strip | Chrome = one deep-slate "room frame" (topbar + dock + mobile nav); workspace-title chip in topbar; App Center as software shelf |
| Stardew Valley | pixel art carries world warmth; body text stays modern/readable; restrained saturation | World is muted dusk pastels; all dense content (Tasks/Assets tables, forms) keeps UI font + high contrast |

## 4. New visual thesis

> **"A pocket desk by the window at dusk."**
> The viewport is a small world — a muted pixel dusk sky over stepped hills, sparse stars,
> drifting clouds — seen through a deep-slate OS frame (topbar + dock). Your tools are warm
> parchment objects placed on that world: an LCD clock instrument, a clipboard, a drawer
> ledger, a control panel, a memo pad, a game cartridge.

Three-layer contract:

```
WORLD   (fixed backdrop: sky bands, stars, clouds, hills, ground)   Level 0
SHELL   (chrome frame: topbar / dock / mobile nav — deep slate)     Level 1
APP     (parchment windows + paper grain)                           Level 2
RAISED  (buttons, inputs, chips on windows)                         Level 3
DIALOG  (modal windows)                                             Level 4
```

Boldness budget: the **world layer** carries the memorable moment. Widgets and detail pages
get *quieter* framing so content wins.

This is NOT: cyberpunk, CRT, Win95 clone, glassmorphism, gradient-tech, candy pastel.

## 5. Core color tokens (verified WCAG)

| Token | Value | Role |
| --- | --- | --- |
| `--px-chrome` | `#262f47` | OS frame (topbar/dock/nav) — inverse text 12.6:1 |
| `--px-sky-1..4` | `#8ea0cc → #a3b1d7 → #bcc7e2 → #d9d7e3` | stepped dusk sky bands |
| `--px-hill-far / -near` | `#9aa3c4 / #7e89b0` | stepped silhouettes above ground line |
| `--px-ground` | `#e6dcc6` | warm desk plain at the bottom of the world |
| `--px-surface*` | unchanged parchment `#fff9e8` family | app windows keep warm paper |
| `--px-ink` | `#263247` unchanged | 4.94:1 on deepest sky band, 12.3:1 on parchment |
| `--px-ink-world` | `#2c3652` | secondary text directly on world ≥ 4.58:1 |
| `--px-shadow` | `#8a92b5` (dusk navy, replaces tan) | hard shadows read as "floating over world" |

Accents unchanged. Full pair-wise contrast numbers computed and logged in §10.

## 6. Typography roles

- **Real pixel font**: self-hosted subset **Fusion Pixel 12px Proportional (latin, OFL)**,
  8 KB woff2 + license under `frontend/public/fonts/`. Covers A–Z/0–9/·×●▸ arrows/blocks used
  in the UI; CJK text already routes to the UI font by design.
- **Pixel font** (unchanged usage): window titles, metrics, clock, OS status, badges, buttons.
- **UI font** (unchanged usage): forms, tables, long text, descriptions.
- Uppercase stays only where it's genuine OS-label language (badges, dock sections, pixel
  buttons); no new mechanical ALL-CAPS labels.

## 7. Shell + dashboard concept

```
┌──────────────────────────────────────────────────────────────┐
│ ▓ chrome topbar: [▣ PP] Personal Platform │▸ DASHBOARD│ ⏻status 22:34 │  ← slate frame
├───────────┬──────────────────────────────────────────────────┤
│ ▓ dock    │   dusk sky (stepped bands, stars, drifting cloud) │
│ CORE      │   ~ ~ ~                                                        │
│  ▸Dash    │  ┌────────────────────────────────────────────┐   │
│  ▸Apps    │  │ CLOCK  — dark system header + LCD readout  │   │ ← hero instrument
│ APPS      │  └────────────────────────────────────────────┘   │
│  Tasks ▐  │  ┌clipboard┐ ┌drawer──┐ ┌panel──┐ ┌memo──┐ ┌cart┐ │
│  Assets   │  │mint     │ │yellow  │ │coral  │ │paper │ │violet│ ← per-metaphor frames
│  Focus ●  │  └─────────┘ └────────┘ └───────┘ └──────┘ └────┘ │
│  ...      │  ▲▲▲ stepped hills over a warm ground line ▲▲▲    │
└───────────┴──────────────────────────────────────────────────┘
```

- Dock → dark tool rail: inverse labels, accent inset bar for active, hover raise.
- Topbar: workspace-title chip (keeps `▸ Title` text contract), LCD-yellow wall clock,
  dithered bottom edge.
- App Center → **software shelf**: every app is a "box" standing on a shelf (4px ink bottom
  edge + hard shadow); disabled apps are boxed-up (dashed, flat, no shadow); real counts strip.

## 8. Files expected to change

```
frontend/public/fonts/fusion-pixel-…latin.woff2   (new, + OFL license)
frontend/index.html                                (font preload)
frontend/src/styles/tokens.css                     (world/chrome/shadow tokens)
frontend/src/styles/base.css                       (@font-face, world layers, on-world text)
frontend/src/styles/shell.css                      (chrome topbar/dock, page headers, nav)
frontend/src/styles/components.css                 (parchment grain, depth hierarchy)
frontend/src/styles/apps.css                       (widget metaphors, shelf, LCD, memo…)
frontend/src/shell/AppCenter.tsx                   (additive summary strip only)
doc/STYLE_AUDIT.md                                 (this file)
```

Non-goals: dashboard layout/persistence/drag/resize, motion system, route/registry/backend
changes, widget DOM semantics (all decoration is CSS-scoped to existing nodes).

## 9. Self-check against "generic retro dashboard"

- A beige grid page with recolored cards would fail this audit — the world layer + chrome
  frame + per-metaphor widget grammar are structural changes, not recolors.
- The plan avoids AI-default tells: no cream+serif+terracotta, no dark+acid-green, no rounded
  SaaS cards, no gradient washes, no ALL-CAPS eyebrows added, no `→` on buttons.

## 10. Contrast log (computed, WCAG 2.1)

| Pair | Ratio |
| --- | --- |
| ink #263247 on sky-1 #8ea0cc (worst-case world band) | 4.94 |
| ink-world #2c3652 on sky-1 | 4.58 |
| ink on ground #e6dcc6 | 9.46 |
| inverse #fff9e8 on chrome #262f47 | 12.64 |
| inverse-muted on chrome | 8.41 |
| yellow #ddb653 on chrome (wall clock) | 6.89 |
| ink on surface #fff9e8 | 12.25 |
| ink-muted on surface | 4.54 |
| yellow on ink LCD bg (clock digits in focus mode) | 6.68 |
