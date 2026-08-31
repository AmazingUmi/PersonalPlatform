/**
 * Dashboard Free Layout V2 — pure layout math, no React/DOM dependencies.
 * The desktop dashboard is a logical grid canvas: every widget owns an
 * {x, y} grid position; visual position is `left = x * GRID_SIZE` etc.
 * Coordinates are grid units (integers), never raw pixels.
 *
 * Compatibility: the persisted `dashboard.widgets` setting is either a
 * legacy V1 `string[]` order or a versioned V2 object (see DashboardLayoutV2).
 * V1 is migrated on read; V2 is written on the next user save.
 */

/** Logical grid unit in px. Keep in sync with the CSS rules in apps.css. */
export const GRID_SIZE = 16;

/** Desktop card width (V1 grid used ~300-340px columns; 320 = 20 units). */
export const DEFAULT_CARD_WIDTH_PX = 320;

/** Height estimate used before/without DOM measurement (16 units). */
export const ESTIMATED_CARD_HEIGHT_PX = 256;

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

/** Defensive ceiling for stored/suggested coordinates (160,000px). */
export const MAX_GRID_UNITS = 10_000;

export interface DashboardWidgetPlacement {
  x: number;
  y: number;
  /** Reserved for a future resize feature; unused by this layout version. */
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

export interface WidgetSize {
  width: number;
  height: number;
}

/** Axis-aligned rect in grid units. */
export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
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

/** Grid rect covered by a placed widget with a pixel size. */
export function rectForPlacement(placement: DashboardWidgetPlacement, size: WidgetSize): GridRect {
  return {
    x: placement.x,
    y: placement.y,
    w: gridUnits(size.width),
    h: gridUnits(size.height),
  };
}

/** True when `rect` keeps at least the collision gap from every other rect. */
export function rectIsFree(rect: GridRect, others: GridRect[]): boolean {
  return !others.some((other) => rectsOverlap(rect, other));
}

// ---------- bounds ----------

/**
 * Clamp a placement into the canvas: x >= 0, y >= 0, right edge <= canvas
 * width. An unknown canvas width (<= 0) disables the horizontal clamp —
 * callers without DOM measurement (tests, SSR) still get sane positions.
 */
export function clampPlacement(
  placement: DashboardWidgetPlacement,
  size: WidgetSize,
  canvasWidthPx: number,
): DashboardWidgetPlacement {
  const capacity = canvasCapacityUnits(canvasWidthPx);
  const w = gridUnits(size.width);
  const x = capacity > 0 ? Math.max(0, Math.min(placement.x, capacity - w)) : Math.max(0, placement.x);
  return { x, y: Math.max(0, placement.y), ...(placement.w !== undefined ? { w: placement.w } : {}), ...(placement.h !== undefined ? { h: placement.h } : {}) };
}

// ---------- placement search ----------

/**
 * Deterministic top-left row-major scan for the first collision-free slot.
 * Falls back to (0, lowest bottom) when the widget can never fit the width —
 * placement must always succeed (Show/new-widget flows depend on it).
 */
export function findFirstFreePosition(
  size: WidgetSize,
  occupied: GridRect[],
  canvasWidthPx: number,
): DashboardWidgetPlacement {
  const w = gridUnits(size.width);
  const h = gridUnits(size.height);
  const capacity = canvasCapacityUnits(canvasWidthPx) || canvasCapacityUnits(FALLBACK_CANVAS_WIDTH_PX);
  const maxX = Math.max(0, capacity - w);
  const stackBottom = occupied.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  // A free slot strictly below every occupied rect always exists, so scanning
  // to stackBottom + h terminates in the worst case.
  for (let y = 0; y <= stackBottom + h; y++) {
    for (let x = 0; x <= maxX; x++) {
      if (rectIsFree({ x, y, w, h }, occupied)) return { x, y };
    }
  }
  return { x: 0, y: stackBottom };
}

export interface DefaultLayoutEntry {
  key: string;
  size: WidgetSize;
}

/**
 * Deterministic default layout: pack entries left-to-right in list order,
 * wrap when the row is full (compact by design — the user's own layout is
 * never compacted). Sizes are measured or estimated by the caller.
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
    const w = gridUnits(entry.size.width);
    const h = gridUnits(entry.size.height);
    if (cursorX > 0 && cursorX + w > capacity) {
      cursorX = 0;
      cursorY += rowHeightUnits + COLLISION_GAP_UNITS;
      rowHeightUnits = 0;
    }
    items[entry.key] = { x: cursorX, y: cursorY };
    cursorX += w + COLLISION_GAP_UNITS;
    rowHeightUnits = Math.max(rowHeightUnits, h);
  }
  return items;
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
  sizes: Record<string, WidgetSize>,
  canvasWidthPx: number,
): DashboardLayoutV2 {
  const available = new Set(availableKeys);
  const known = order.filter((key) => available.has(key));
  const entries = known.map((key) => ({ key, size: sizes[key] ?? defaultWidgetSize() }));
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
 * Saved placements are clamped to the current canvas; widgets that are
 * neither placed nor hidden (e.g. a newly shipped widget) are auto-placed at
 * the first free position at RUNTIME only — they persist on the next save.
 */
export function resolveEffectiveLayout(
  parsed: ParsedDashboardLayout,
  availableKeys: string[],
  sizes: Record<string, WidgetSize>,
  canvasWidthPx: number,
): EffectiveLayout {
  const sizeOf = (key: string) => sizes[key] ?? defaultWidgetSize();
  if (parsed.kind === "legacy") {
    const migrated = migrateLegacyLayout(parsed.order, availableKeys, sizes, canvasWidthPx);
    return { items: migrated.items, hidden: migrated.hidden };
  }
  const hiddenSet = new Set(
    parsed.kind === "v2" ? parsed.hidden.filter((key) => availableKeys.includes(key)) : [],
  );
  const items: Record<string, DashboardWidgetPlacement> = {};
  if (parsed.kind === "v2") {
    for (const key of availableKeys) {
      const saved = parsed.items[key];
      if (saved) items[key] = clampPlacement(saved, sizeOf(key), canvasWidthPx);
    }
  }
  const occupied = () => Object.entries(items).map(([key, p]) => rectForPlacement(p, sizeOf(key)));
  for (const key of availableKeys) {
    if (items[key] !== undefined || hiddenSet.has(key)) continue;
    const size = sizeOf(key);
    const found = findFirstFreePosition(size, occupied(), canvasWidthPx);
    items[key] = clampPlacement(found, size, canvasWidthPx);
  }
  return { items, hidden: availableKeys.filter((key) => hiddenSet.has(key)) };
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

// ---------- measurement helpers ----------

/** Estimated size used before a real DOM measurement exists. */
export function defaultWidgetSize(): WidgetSize {
  return { width: DEFAULT_CARD_WIDTH_PX, height: ESTIMATED_CARD_HEIGHT_PX };
}

/**
 * Normalize a measured DOM rect: jsdom (and pre-layout renders) report 0x0,
 * which would collapse collision rects — fall back to the constants instead.
 */
export function normalizeMeasuredSize(width: number, height: number): WidgetSize {
  return {
    width: width > 0 ? width : DEFAULT_CARD_WIDTH_PX,
    height: height > 0 ? height : ESTIMATED_CARD_HEIGHT_PX,
  };
}
