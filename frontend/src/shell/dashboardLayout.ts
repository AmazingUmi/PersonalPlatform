/**
 * Dashboard Free Layout V2 — pure layout math, no React/DOM dependencies.
 * The desktop dashboard is a logical grid canvas: every widget owns an
 * {x, y, w, h} grid position/size; visual geometry is `left = x * GRID_SIZE`
 * etc. All values are grid units (integers), never raw pixels.
 *
 * Geometry source of truth (Phase 10): the desktop collision footprint and
 * card geometry come from the placement itself. Content never stretches the
 * container — widgets adapt through density levels instead.
 *
 * Compatibility: the persisted `dashboard.widgets` setting is either a
 * legacy V1 `string[]` order or a versioned V2 object (see DashboardLayoutV2).
 * V1 is migrated on read; V2 entries without `w/h` are completed with widget
 * defaults at runtime and persist in full on the next user save.
 */

import type { WidgetDensity, WidgetLayoutSpec } from "../shared/appTypes";

/** Logical grid unit in px. Keep in sync with the CSS rules in apps.css. */
export const GRID_SIZE = 16;

/** Default card size in grid units (V2 cards were 320px wide, ~256px tall). */
export const DEFAULT_CARD_WIDTH_UNITS = 20;
export const DEFAULT_CARD_HEIGHT_UNITS = 16;

/** Platform floor for widgets without their own layout constraints. */
export const DEFAULT_MIN_WIDTH_UNITS = 12;
export const DEFAULT_MIN_HEIGHT_UNITS = 8;

/** Canvas never shrinks below this (30 units). */
export const MIN_CANVAS_HEIGHT_PX = 480;

/** Breathing room below the lowest card so low drops always fit. */
export const CANVAS_BOTTOM_PADDING_PX = 48;

/** Minimum edge-to-edge separation between cards, in grid units (16px). */
export const COLLISION_GAP_UNITS = 1;

/**
 * Desktop free-layout breakpoint. Mirrors the shell.css 959/960px dock
 * boundary; the media query in apps.css must use the same value.
 */
export const DASHBOARD_DESKTOP_BREAKPOINT_PX = 960;
export const DASHBOARD_DESKTOP_MEDIA_QUERY = `(min-width: ${DASHBOARD_DESKTOP_BREAKPOINT_PX}px)`;

/** Canvas width assumed when no DOM measurement is available (65 units). */
export const FALLBACK_CANVAS_WIDTH_PX = 1040;

/** Defensive ceiling for stored/suggested coordinates and sizes (160,000px). */
export const MAX_GRID_UNITS = 10_000;

export interface DashboardWidgetPlacement {
  x: number;
  y: number;
  /** Explicit size in grid units (Phase 10); missing = widget default. */
  w?: number;
  h?: number;
}

export interface DashboardLayoutV2 {
  version: 2;
  /** Visible widgets: key -> grid placement. */
  items: Record<string, DashboardWidgetPlacement>;
  /** Explicitly hidden widget keys. */
  hidden: string[];
}

export type ParsedDashboardLayout =
  | { kind: "v2"; items: Record<string, DashboardWidgetPlacement>; hidden: string[] }
  | { kind: "legacy"; order: string[] }
  | { kind: "none" };

/** Size in whole grid units (the canonical widget size representation). */
export interface SizeUnits {
  w: number;
  h: number;
}

/** Axis-aligned rect in grid units. */
export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A widget's declared layout constraints resolved against the platform
 * defaults. `maxW/maxH` null means "no widget-specific ceiling" (width is
 * still bounded by the canvas, height is unbounded — the canvas grows).
 */
export interface ResolvedWidgetLayout {
  minW: number;
  minH: number;
  maxW: number | null;
  maxH: number | null;
  defaultW: number;
  defaultH: number;
  density: WidgetLayoutSpec["density"];
}

// ---------- grid math ----------

/** Round a pixel offset to the nearest grid unit (`|| 0` normalizes -0). */
export function snapToGrid(px: number): number {
  return Math.round(px / GRID_SIZE) || 0;
}

/** Convert a pixel extent to covering grid units (never 0 for px > 0). */
export function gridUnits(px: number): number {
  return Math.max(1, Math.ceil(px / GRID_SIZE));
}

/** Canvas capacity in whole grid units; 0 means "unknown width". */
export function canvasCapacityUnits(canvasWidthPx: number): number {
  return canvasWidthPx > 0 ? Math.floor(canvasWidthPx / GRID_SIZE) : 0;
}

// ---------- parsing / serializing ----------

function toGridInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.max(0, Math.min(MAX_GRID_UNITS, Math.round(n)));
  return i;
}

/** Coerce an unknown JSON value into a valid placement; null if unusable. */
export function normalizePlacement(value: unknown): DashboardWidgetPlacement | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const x = toGridInt(raw.x);
  const y = toGridInt(raw.y);
  if (x === null || y === null) return null;
  const w = toGridInt(raw.w);
  const h = toGridInt(raw.h);
  return {
    x,
    y,
    ...(w !== null && w > 0 ? { w } : {}),
    ...(h !== null && h > 0 ? { h } : {}),
  };
}

/**
 * Parse the persisted `dashboard.widgets` value. Never throws: corrupt input
 * degrades to `{kind: "none"}` (default layout), bad V2 entries are dropped
 * individually.
 */
export function parseDashboardLayout(value: unknown): ParsedDashboardLayout {
  if (value === null || value === undefined) return { kind: "none" };
  if (Array.isArray(value)) {
    return { kind: "legacy", order: value.filter((k): k is string => typeof k === "string") };
  }
  if (typeof value !== "object") return { kind: "none" };
  const raw = value as Record<string, unknown>;
  if (raw.version !== 2 || typeof raw.items !== "object" || raw.items === null || Array.isArray(raw.items)) {
    return { kind: "none" };
  }
  const items: Record<string, DashboardWidgetPlacement> = {};
  for (const [key, entry] of Object.entries(raw.items as Record<string, unknown>)) {
    const placement = normalizePlacement(entry);
    if (placement) items[key] = placement;
  }
  const hidden = Array.isArray(raw.hidden)
    ? raw.hidden.filter((k): k is string => typeof k === "string")
    : [];
  return { kind: "v2", items, hidden };
}

export function serializeLayout(
  items: Record<string, DashboardWidgetPlacement>,
  hidden: string[],
): DashboardLayoutV2 {
  const clean: Record<string, DashboardWidgetPlacement> = {};
  for (const [key, placement] of Object.entries(items)) {
    const normalized = normalizePlacement(placement);
    if (normalized) clean[key] = normalized;
  }
  return { version: 2, items: clean, hidden: [...hidden] };
}

// ---------- widget layout spec resolution ----------

/** Clamp an optional positive grid-unit value, or fall back. */
function unitOr(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_GRID_UNITS, Math.round(value)));
}

/**
 * Resolve a widget's declared layout against the platform defaults.
 * Malformed spec fields degrade to the defaults; the default size is kept
 * inside [min, max] so a bad spec can never produce an unusable card.
 */
export function resolveWidgetDefaults(spec?: WidgetLayoutSpec): ResolvedWidgetLayout {
  const minW = unitOr(spec?.minW, DEFAULT_MIN_WIDTH_UNITS);
  const minH = unitOr(spec?.minH, DEFAULT_MIN_HEIGHT_UNITS);
  const maxWRaw = spec?.maxW;
  const maxHRaw = spec?.maxH;
  const maxW =
    typeof maxWRaw === "number" && Number.isFinite(maxWRaw)
      ? Math.max(minW, Math.min(MAX_GRID_UNITS, Math.round(maxWRaw)))
      : null;
  const maxH =
    typeof maxHRaw === "number" && Number.isFinite(maxHRaw)
      ? Math.max(minH, Math.min(MAX_GRID_UNITS, Math.round(maxHRaw)))
      : null;
  let defaultW = unitOr(spec?.defaultW, DEFAULT_CARD_WIDTH_UNITS);
  let defaultH = unitOr(spec?.defaultH, DEFAULT_CARD_HEIGHT_UNITS);
  defaultW = Math.max(minW, Math.min(defaultW, maxW ?? MAX_GRID_UNITS));
  defaultH = Math.max(minH, Math.min(defaultH, maxH ?? MAX_GRID_UNITS));
  return { minW, minH, maxW, maxH, defaultW, defaultH, density: spec?.density };
}

/**
 * Complete placements that predate explicit sizes: entries without `w/h`
 * keep their position and gain the widget's default size (runtime
 * normalization only — callers decide when to persist).
 */
export function applyWidgetDefaults(
  items: Record<string, DashboardWidgetPlacement>,
  specs: Record<string, WidgetLayoutSpec | undefined>,
): Record<string, DashboardWidgetPlacement> {
  const out: Record<string, DashboardWidgetPlacement> = {};
  for (const [key, placement] of Object.entries(items)) {
    const layout = resolveWidgetDefaults(specs[key]);
    out[key] = { x: placement.x, y: placement.y, w: placement.w ?? layout.defaultW, h: placement.h ?? layout.defaultH };
  }
  return out;
}

/**
 * Density for a concrete size: compact below the `normal` threshold, normal
 * when met, expanded when the (stricter) expanded threshold is met —
 * expanded wins. Missing threshold fields count as 0 (always met); a widget
 * without any density declaration is always `normal`.
 */
export function resolveWidgetDensity(layout: ResolvedWidgetLayout, w: number, h: number): WidgetDensity {
  const meets = (threshold: { minW?: number; minH?: number }) =>
    w >= (threshold.minW ?? 0) && h >= (threshold.minH ?? 0);
  if (layout.density?.expanded && meets(layout.density.expanded)) return "expanded";
  if (layout.density?.normal) return meets(layout.density.normal) ? "normal" : "compact";
  // Expanded-only declarations keep sizes below the threshold at normal.
  return "normal";
}

// ---------- collision ----------

/**
 * True when two grid rects are closer than `gapUnits` edge-to-edge. Touching
 * at exactly the gap distance is allowed, so the generated default layout
 * (packed with COLLISION_GAP_UNITS spacing) is collision-free by construction.
 */
export function rectsOverlap(a: GridRect, b: GridRect, gapUnits = COLLISION_GAP_UNITS): boolean {
  const g = gapUnits / 2;
  return (
    a.x - g < b.x + b.w + g &&
    b.x - g < a.x + a.w + g &&
    a.y - g < b.y + b.h + g &&
    b.y - g < a.y + a.h + g
  );
}

/**
 * Grid rect covered by a placed widget: the explicit placement size wins
 * (Phase 10 geometry source of truth); entries without `w/h` fall back to
 * the widget defaults.
 */
export function placementRect(placement: DashboardWidgetPlacement, defaults: SizeUnits): GridRect {
  return {
    x: placement.x,
    y: placement.y,
    w: placement.w ?? defaults.w,
    h: placement.h ?? defaults.h,
  };
}

/** True when `rect` keeps at least the collision gap from every other rect. */
export function rectIsFree(rect: GridRect, others: GridRect[]): boolean {
  return !others.some((other) => rectsOverlap(rect, other));
}

// ---------- bounds ----------

/**
 * Clamp a widget size into the usable range: min/max constraints plus, for
 * width, the canvas right edge relative to the anchor column (`anchorX`).
 * The canvas floor never pushes below `minW` — on a very narrow canvas the
 * widget stays usable and may overlap instead (runtime clamp, not persisted).
 * An unknown capacity (<= 0) disables the horizontal bound.
 */
export function clampWidgetSize(
  size: SizeUnits,
  layout: ResolvedWidgetLayout,
  capacityUnits: number,
  anchorX = 0,
): SizeUnits {
  const canvasMaxW = capacityUnits > 0 ? capacityUnits - anchorX : Number.POSITIVE_INFINITY;
  const maxW = Math.min(layout.maxW ?? Number.POSITIVE_INFINITY, canvasMaxW);
  const maxH = layout.maxH ?? Number.POSITIVE_INFINITY;
  return {
    w: Math.round(Math.max(layout.minW, Math.min(Math.max(maxW, layout.minW), size.w))),
    h: Math.round(Math.max(layout.minH, Math.min(Math.max(maxH, layout.minH), size.h))),
  };
}

/**
 * Clamp a placement into the canvas: x >= 0, y >= 0, right edge <= canvas
 * width (using the explicit `w` when present). An unknown canvas width
 * (<= 0) disables the horizontal clamp — callers without DOM measurement
 * (tests, SSR) still get sane positions.
 */
export function clampPlacement(
  placement: DashboardWidgetPlacement,
  defaults: SizeUnits,
  canvasWidthPx: number,
): DashboardWidgetPlacement {
  const capacity = canvasCapacityUnits(canvasWidthPx);
  const w = placement.w ?? defaults.w;
  const x = capacity > 0 ? Math.max(0, Math.min(placement.x, Math.max(0, capacity - w))) : Math.max(0, placement.x);
  return {
    x,
    y: Math.max(0, placement.y),
    ...(placement.w !== undefined ? { w: placement.w } : {}),
    ...(placement.h !== undefined ? { h: placement.h } : {}),
  };
}

// ---------- resize ----------

/** A placement with an explicit size — what every runtime path produces. */
export interface SizedPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResizeEvaluation {
  /** Snapped + clamped candidate; x/y are always the origin's. */
  placement: SizedPlacement;
  /** False when the candidate rect collides with another widget. */
  valid: boolean;
}

/**
 * Evaluate a bottom-right anchored resize of `origin` towards an attempted
 * size (grid units, pre-snapping tolerated — values are rounded). The
 * candidate is clamped to min/max/canvas bounds; collision against `others`
 * decides validity. The caller reverts on invalid release.
 */
export function resizePlacement(
  origin: DashboardWidgetPlacement,
  attempted: SizeUnits,
  layout: ResolvedWidgetLayout,
  canvasWidthPx: number,
  others: GridRect[],
): ResizeEvaluation {
  const capacity = canvasCapacityUnits(canvasWidthPx);
  const size = clampWidgetSize(
    { w: Math.max(1, Math.round(attempted.w)), h: Math.max(1, Math.round(attempted.h)) },
    layout,
    capacity,
    origin.x,
  );
  const placement: SizedPlacement = { x: origin.x, y: origin.y, w: size.w, h: size.h };
  return { placement, valid: rectIsFree(placementRect(placement, size), others) };
}

// ---------- placement search ----------

/**
 * Deterministic top-left row-major scan for the first collision-free slot
 * for a widget of the given size. Falls back to (0, lowest bottom) when the
 * widget can never fit the width — placement must always succeed (Show /
 * new-widget flows depend on it). Returns the complete placement including
 * the searched-for size.
 */
export function findFirstFreePosition(
  size: SizeUnits,
  occupied: GridRect[],
  canvasWidthPx: number,
): DashboardWidgetPlacement {
  const { w, h } = size;
  const capacity = canvasCapacityUnits(canvasWidthPx) || canvasCapacityUnits(FALLBACK_CANVAS_WIDTH_PX);
  const maxX = Math.max(0, capacity - w);
  const stackBottom = occupied.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  // A free slot strictly below every occupied rect always exists, so scanning
  // to stackBottom + h terminates in the worst case.
  for (let y = 0; y <= stackBottom + h; y++) {
    for (let x = 0; x <= maxX; x++) {
      if (rectIsFree({ x, y, w, h }, occupied)) return { x, y, w, h };
    }
  }
  return { x: 0, y: stackBottom, w, h };
}

export interface DefaultLayoutEntry {
  key: string;
  size: SizeUnits;
}

/**
 * Deterministic default layout: pack entries left-to-right in list order,
 * wrap when the row is full (compact by design — the user's own layout is
 * never compacted). Every placement carries the entry's size so restoring
 * defaults also restores default sizes.
 */
export function generateDefaultLayout(
  entries: DefaultLayoutEntry[],
  canvasWidthPx: number,
): Record<string, DashboardWidgetPlacement> {
  const capacity = canvasCapacityUnits(canvasWidthPx) || canvasCapacityUnits(FALLBACK_CANVAS_WIDTH_PX);
  const items: Record<string, DashboardWidgetPlacement> = {};
  let cursorX = 0;
  let cursorY = 0;
  let rowHeightUnits = 0;
  for (const entry of entries) {
    const { w, h } = entry.size;
    if (cursorX > 0 && cursorX + w > capacity) {
      cursorX = 0;
      cursorY += rowHeightUnits + COLLISION_GAP_UNITS;
      rowHeightUnits = 0;
    }
    items[entry.key] = { x: cursorX, y: cursorY, w, h };
    cursorX += w + COLLISION_GAP_UNITS;
    rowHeightUnits = Math.max(rowHeightUnits, h);
  }
  return items;
}

/**
 * Repair collisions among loaded placements: walking in deterministic reading
 * order, a placement that is collision-free against the already kept ones
 * stays exactly where it was; a conflicting widget keeps its size and moves
 * to the first free position. Runtime normalization only — the repaired
 * geometry is persisted by the next real user save, never on read.
 *
 * Rationale: every save path is collision-checked, so overlaps observed after
 * the runtime canvas clamp are introduced by the clamp itself (e.g. a layout
 * saved on a wide canvas opened narrower). Even for hand-edited overlapping
 * data this moves only the later widget in reading order.
 */
export function repairCollisions(
  items: Record<string, DashboardWidgetPlacement>,
  specs: Record<string, WidgetLayoutSpec | undefined>,
  canvasWidthPx: number,
): Record<string, DashboardWidgetPlacement> {
  const defaultsOf = (key: string): SizeUnits => {
    const layout = resolveWidgetDefaults(specs[key]);
    return { w: layout.defaultW, h: layout.defaultH };
  };
  const kept: Record<string, DashboardWidgetPlacement> = {};
  const occupied: GridRect[] = [];
  for (const key of sortForMobile(items)) {
    const placement = items[key]!;
    const rect = placementRect(placement, defaultsOf(key));
    if (rectIsFree(rect, occupied)) {
      kept[key] = placement;
    } else {
      kept[key] = findFirstFreePosition({ w: rect.w, h: rect.h }, occupied, canvasWidthPx);
    }
    occupied.push(placementRect(kept[key]!, defaultsOf(key)));
  }
  return kept;
}

// ---------- migration ----------

/**
 * Migrate a legacy V1 order into a V2 layout. Stale keys (unavailable apps)
 * occupy no slot and never count as hidden; V1's "not listed = hidden"
 * semantics are preserved for the remaining keys.
 */
export function migrateLegacyLayout(
  order: string[],
  availableKeys: string[],
  defaults: Record<string, SizeUnits>,
  canvasWidthPx: number,
): DashboardLayoutV2 {
  const available = new Set(availableKeys);
  const known = order.filter((key) => available.has(key));
  const entries = known.map((key) => ({ key, size: defaults[key] ?? defaultWidgetSize() }));
  return serializeLayout(
    generateDefaultLayout(entries, canvasWidthPx),
    availableKeys.filter((k) => !known.includes(k)),
  );
}

// ---------- effective layout ----------

export interface EffectiveLayout {
  /** Visible widgets (including runtime auto-placed ones): key -> placement. */
  items: Record<string, DashboardWidgetPlacement>;
  /** Explicitly hidden widgets among the available keys. */
  hidden: string[];
}

/**
 * Normalize any parsed persisted value into the effective visible layout.
 * Saved placements are clamped to the current canvas (position AND size —
 * runtime only, never written back) and then collision-repaired in reading
 * order so the clamp can never render overlapping cards; widgets that are
 * neither placed nor hidden (e.g. a newly shipped widget) are auto-placed at
 * the first free position. Every returned placement carries explicit w/h.
 */
export function resolveEffectiveLayout(
  parsed: ParsedDashboardLayout,
  availableKeys: string[],
  specs: Record<string, WidgetLayoutSpec | undefined>,
  canvasWidthPx: number,
): EffectiveLayout {
  const layoutOf = (key: string) => resolveWidgetDefaults(specs[key]);
  const defaultsOf = (key: string): SizeUnits => {
    const layout = layoutOf(key);
    return { w: layout.defaultW, h: layout.defaultH };
  };
  if (parsed.kind === "legacy") {
    const defaults: Record<string, SizeUnits> = {};
    for (const key of availableKeys) defaults[key] = defaultsOf(key);
    const migrated = migrateLegacyLayout(parsed.order, availableKeys, defaults, canvasWidthPx);
    return { items: migrated.items, hidden: migrated.hidden };
  }
  const capacity = canvasCapacityUnits(canvasWidthPx);
  const hiddenSet = new Set(
    parsed.kind === "v2" ? parsed.hidden.filter((key) => availableKeys.includes(key)) : [],
  );
  let items: Record<string, DashboardWidgetPlacement> = {};
  if (parsed.kind === "v2") {
    const clamped: Record<string, DashboardWidgetPlacement> = {};
    for (const key of availableKeys) {
      const saved = parsed.items[key];
      if (!saved) continue;
      const layout = layoutOf(key);
      const defaults = { w: layout.defaultW, h: layout.defaultH };
      const positioned = clampPlacement(saved, defaults, canvasWidthPx);
      const size = clampWidgetSize(
        { w: positioned.w ?? layout.defaultW, h: positioned.h ?? layout.defaultH },
        layout,
        capacity,
        positioned.x,
      );
      clamped[key] = { x: positioned.x, y: positioned.y, w: size.w, h: size.h };
    }
    // The clamp squeezes cards towards the right edge independently, which
    // can stack two saved placements onto the same slot — repair before
    // anything renders or auto-places against them.
    items = repairCollisions(clamped, specs, canvasWidthPx);
  }
  const occupied = () => Object.entries(items).map(([key, p]) => placementRect(p, defaultsOf(key)));
  for (const key of availableKeys) {
    if (items[key] !== undefined || hiddenSet.has(key)) continue;
    items[key] = findFirstFreePosition(defaultsOf(key), occupied(), canvasWidthPx);
  }
  // Final normalization: the returned layout guarantees explicit w/h on
  // every placement (auto-placed entries already carry theirs).
  return { items: applyWidgetDefaults(items, specs), hidden: availableKeys.filter((key) => hiddenSet.has(key)) };
}

// ---------- canvas geometry ----------

/**
 * Canvas height keeps every rect visible plus bottom padding, floored at
 * MIN_CANVAS_HEIGHT_PX so there is always room to drag downwards.
 */
export function canvasHeightFor(rects: GridRect[]): number {
  const bottomUnits = rects.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  return Math.max(MIN_CANVAS_HEIGHT_PX, bottomUnits * GRID_SIZE + CANVAS_BOTTOM_PADDING_PX);
}

/**
 * Reading order for the narrow flow layout: top-to-bottom, left-to-right.
 * Also used as the universal DOM order — desktop visual position comes from
 * each widget's placement, never from this ordering.
 */
export function sortForMobile(items: Record<string, DashboardWidgetPlacement>): string[] {
  return Object.keys(items).sort((a, b) => {
    const pa = items[a]!;
    const pb = items[b]!;
    if (pa.y !== pb.y) return pa.y - pb.y;
    if (pa.x !== pb.x) return pa.x - pb.x;
    return a.localeCompare(b);
  });
}

// ---------- keyboard drag ----------

/** Minimal structural types so this module stays free of @dnd-kit imports. */
interface KeyboardDragEvent {
  code: string;
}

interface KeyboardDragCoordinates {
  x: number;
  y: number;
}

const KEYBOARD_UNIT_DELTAS: Record<string, KeyboardDragCoordinates> = {
  ArrowUp: { x: 0, y: -GRID_SIZE },
  ArrowDown: { x: 0, y: GRID_SIZE },
  ArrowLeft: { x: -GRID_SIZE, y: 0 },
  ArrowRight: { x: GRID_SIZE, y: 0 },
};

/**
 * Keyboard coordinate getter for free-layout dragging: each arrow press moves
 * the active card by exactly one grid unit, so keyboard drags stay snapped.
 * Compatible with @dnd-kit's KeyboardSensor `coordinateGetter` option.
 */
export function gridKeyboardCoordinateGetter(
  event: KeyboardDragEvent,
  { currentCoordinates }: { currentCoordinates: KeyboardDragCoordinates },
): KeyboardDragCoordinates | undefined {
  const delta = KEYBOARD_UNIT_DELTAS[event.code];
  if (!delta) return undefined;
  return { x: currentCoordinates.x + delta.x, y: currentCoordinates.y + delta.y };
}

// ---------- defaults ----------

/** Platform default size for widgets without a layout spec. */
export function defaultWidgetSize(): SizeUnits {
  return { w: DEFAULT_CARD_WIDTH_UNITS, h: DEFAULT_CARD_HEIGHT_UNITS };
}
