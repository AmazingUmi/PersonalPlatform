import { describe, expect, it } from "vitest";
import type { WidgetLayoutSpec } from "../shared/appTypes";
import {
  COLLISION_GAP_UNITS,
  DEFAULT_CARD_HEIGHT_UNITS,
  DEFAULT_CARD_WIDTH_UNITS,
  DEFAULT_MIN_HEIGHT_UNITS,
  DEFAULT_MIN_WIDTH_UNITS,
  GRID_SIZE,
  applyWidgetDefaults,
  canvasCapacityUnits,
  canvasHeightFor,
  clampPlacement,
  clampWidgetSize,
  findFirstFreePosition,
  generateDefaultLayout,
  gridKeyboardCoordinateGetter,
  gridUnits,
  migrateLegacyLayout,
  normalizePlacement,
  parseDashboardLayout,
  placementRect,
  rectIsFree,
  rectsOverlap,
  repairCollisions,
  resolveEffectiveLayout,
  resolveWidgetDefaults,
  resolveWidgetDensity,
  resizePlacement,
  serializeLayout,
  snapToGrid,
  sortForMobile,
  type SizeUnits,
} from "./dashboardLayout";

const units = (w: number, h: number): SizeUnits => ({ w, h });
const defaultUnits = units(DEFAULT_CARD_WIDTH_UNITS, DEFAULT_CARD_HEIGHT_UNITS);

describe("grid math", () => {
  it("snaps pixel offsets to the nearest grid unit", () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(7)).toBe(0);
    expect(snapToGrid(8)).toBe(1);
    expect(snapToGrid(24)).toBe(2);
    expect(snapToGrid(-5)).toBe(0);
  });

  it("converts pixel extents to covering units (never 0)", () => {
    expect(gridUnits(1)).toBe(1);
    expect(gridUnits(GRID_SIZE)).toBe(1);
    expect(gridUnits(GRID_SIZE + 1)).toBe(2);
    expect(gridUnits(320)).toBe(20);
  });

  it("derives canvas capacity in whole units; 0 width means unknown", () => {
    expect(canvasCapacityUnits(0)).toBe(0);
    expect(canvasCapacityUnits(-10)).toBe(0);
    expect(canvasCapacityUnits(GRID_SIZE * 65)).toBe(65);
    expect(canvasCapacityUnits(GRID_SIZE * 65 + 15)).toBe(65);
  });
});

describe("parseDashboardLayout", () => {
  it("reads a V2 layout", () => {
    const parsed = parseDashboardLayout({
      version: 2,
      items: { "clock:clock": { x: 0, y: 0 }, "tasks:summary": { x: 6, y: 1 } },
      hidden: ["notes:quick"],
    });
    expect(parsed).toEqual({
      kind: "v2",
      items: { "clock:clock": { x: 0, y: 0 }, "tasks:summary": { x: 6, y: 1 } },
      hidden: ["notes:quick"],
    });
  });

  it("treats a legacy string array as an order", () => {
    expect(parseDashboardLayout(["a:1", "b:2"])).toEqual({ kind: "legacy", order: ["a:1", "b:2"] });
  });

  it("drops non-string entries from a legacy array instead of crashing", () => {
    expect(parseDashboardLayout(["a:1", 42, null, "b:2"] as unknown[])).toEqual({
      kind: "legacy",
      order: ["a:1", "b:2"],
    });
  });

  it("null / undefined / garbage fall back to the default layout", () => {
    expect(parseDashboardLayout(null)).toEqual({ kind: "none" });
    expect(parseDashboardLayout(undefined)).toEqual({ kind: "none" });
    expect(parseDashboardLayout("nonsense")).toEqual({ kind: "none" });
    expect(parseDashboardLayout({ version: 1, items: {} })).toEqual({ kind: "none" });
    expect(parseDashboardLayout({ version: 2 })).toEqual({ kind: "none" });
    expect(parseDashboardLayout({ version: 2, items: [] })).toEqual({ kind: "none" });
  });

  it("drops invalid V2 entries individually and keeps the valid ones", () => {
    const parsed = parseDashboardLayout({
      version: 2,
      items: { good: { x: 1, y: 2 }, bad: "nope", worse: { x: -4, y: 0 }, negative: { x: 3.6, y: "z" } },
      hidden: "not-an-array",
    });
    expect(parsed).toEqual({ kind: "v2", items: { good: { x: 1, y: 2 }, worse: { x: 0, y: 0 } }, hidden: [] });
  });

  it("normalizes placements: finite, non-negative, capped integers", () => {
    expect(normalizePlacement({ x: 2.4, y: -3 })).toEqual({ x: 2, y: 0 });
    expect(normalizePlacement({ x: "5", y: 1 })).toEqual({ x: 5, y: 1 });
    expect(normalizePlacement({ x: Number.MAX_SAFE_INTEGER, y: 0 })!.x).toBeLessThan(1_000_000);
    expect(normalizePlacement({ x: Number.NaN, y: 0 })).toBeNull();
    expect(normalizePlacement("x")).toBeNull();
    expect(normalizePlacement(null)).toBeNull();
  });

  it("keeps w/h through parsing and serialization (w/h serialization)", () => {
    expect(normalizePlacement({ x: 1, y: 2, w: 28.4, h: -5 })).toEqual({ x: 1, y: 2, w: 28 });
    expect(normalizePlacement({ x: 1, y: 2, w: 0, h: 3 })).toEqual({ x: 1, y: 2, h: 3 });
    const layout = serializeLayout({ a: { x: 1, y: 2, w: 28, h: 20 }, b: { x: 0, y: 9 } }, ["c"]);
    expect(parseDashboardLayout(layout)).toEqual({
      kind: "v2",
      items: { a: { x: 1, y: 2, w: 28, h: 20 }, b: { x: 0, y: 9 } },
      hidden: ["c"],
    });
  });

  it("round-trips through serializeLayout", () => {
    const layout = serializeLayout({ a: { x: 1, y: 2 }, b: { x: 0, y: 9 } }, ["c"]);
    expect(parseDashboardLayout(layout)).toEqual({ kind: "v2", items: { a: { x: 1, y: 2 }, b: { x: 0, y: 9 } }, hidden: ["c"] });
  });
});

describe("resolveWidgetDefaults", () => {
  it("falls back to the platform defaults without a spec", () => {
    const resolved = resolveWidgetDefaults(undefined);
    expect(resolved.defaultW).toBe(DEFAULT_CARD_WIDTH_UNITS);
    expect(resolved.defaultH).toBe(DEFAULT_CARD_HEIGHT_UNITS);
    expect(resolved.minW).toBe(DEFAULT_MIN_WIDTH_UNITS);
    expect(resolved.minH).toBe(DEFAULT_MIN_HEIGHT_UNITS);
    expect(resolved.maxW).toBeNull();
    expect(resolved.maxH).toBeNull();
    expect(resolved.density).toBeUndefined();
  });

  it("honors declared constraints, defaults and density thresholds", () => {
    const spec: WidgetLayoutSpec = {
      minW: 16,
      minH: 12,
      maxW: 40,
      defaultW: 24,
      defaultH: 18,
      density: { normal: { minW: 18, minH: 14 }, expanded: { minW: 26, minH: 20 } },
    };
    expect(resolveWidgetDefaults(spec)).toEqual({
      minW: 16,
      minH: 12,
      maxW: 40,
      maxH: null,
      defaultW: 24,
      defaultH: 18,
      density: spec.density,
    });
  });

  it("keeps the default size inside the declared range", () => {
    expect(resolveWidgetDefaults({ minW: 30, defaultW: 20 }).defaultW).toBe(30);
    expect(resolveWidgetDefaults({ maxW: 10, defaultW: 20, minW: 4 }).defaultW).toBe(10);
    expect(resolveWidgetDefaults({ minH: 40, defaultH: 16 }).defaultH).toBe(40);
  });
});

describe("applyWidgetDefaults", () => {
  it("completes old V2 x/y-only entries with per-widget defaults", () => {
    const specs: Record<string, WidgetLayoutSpec | undefined> = {
      a: { defaultW: 24, defaultH: 18 },
      b: undefined,
    };
    expect(applyWidgetDefaults({ a: { x: 5, y: 8 }, b: { x: 0, y: 0 } }, specs)).toEqual({
      a: { x: 5, y: 8, w: 24, h: 18 },
      b: { x: 0, y: 0, w: DEFAULT_CARD_WIDTH_UNITS, h: DEFAULT_CARD_HEIGHT_UNITS },
    });
  });

  it("never overwrites an explicit w/h", () => {
    expect(applyWidgetDefaults({ a: { x: 0, y: 0, w: 30, h: 22 } }, {})).toEqual({
      a: { x: 0, y: 0, w: 30, h: 22 },
    });
  });
});

describe("collision", () => {
  it("detects overlap between grid rects", () => {
    const a = { x: 0, y: 0, w: 4, h: 4 };
    expect(rectsOverlap(a, { x: 3, y: 3, w: 4, h: 4 })).toBe(true);
    expect(rectsOverlap(a, { x: 5, y: 5, w: 1, h: 1 })).toBe(false); // clear
  });

  it("enforces the collision gap: closer than one unit counts as overlap", () => {
    const a = { x: 0, y: 0, w: 4, h: 4 };
    // Right edge at unit 4; b one unit away (x=5) is free, at x=4 it is not.
    expect(rectsOverlap(a, { x: 4, y: 0, w: 2, h: 2 })).toBe(true);
    expect(rectsOverlap(a, { x: 5, y: 0, w: 2, h: 2 })).toBe(false);
    // Vertically the same.
    expect(rectsOverlap(a, { x: 0, y: 4, w: 2, h: 2 })).toBe(true);
    expect(rectsOverlap(a, { x: 0, y: 5, w: 2, h: 2 })).toBe(false);
    // A zero-gap check degenerates to plain AABB touching detection.
    expect(rectsOverlap(a, { x: 4, y: 0, w: 2, h: 2 }, 0)).toBe(false);
  });

  it("builds collision rects from placements, preferring explicit w/h", () => {
    // The pre-Phase-10 behavior: entries without w/h use the defaults.
    expect(placementRect({ x: 2, y: 3 }, units(20, 7))).toEqual({ x: 2, y: 3, w: 20, h: 7 });
    // Phase 10: the explicit size wins over any default.
    expect(placementRect({ x: 2, y: 3, w: 28, h: 20 }, units(20, 16))).toEqual({
      x: 2,
      y: 3,
      w: 28,
      h: 20,
    });
  });

  it("rectIsFree checks against a list of others", () => {
    const occupied = [{ x: 0, y: 0, w: 20, h: 16 }];
    expect(rectIsFree({ x: 21, y: 0, w: 20, h: 16 }, occupied)).toBe(true);
    expect(rectIsFree({ x: 10, y: 0, w: 20, h: 16 }, occupied)).toBe(false);
  });
});

describe("clampWidgetSize", () => {
  const layout = resolveWidgetDefaults({ minW: 16, minH: 12, maxW: 40, maxH: 30 });

  it("clamps below the minimum width/height", () => {
    expect(clampWidgetSize(units(3, 2), layout, 65)).toEqual(units(16, 12));
  });

  it("clamps above the maximum width/height", () => {
    expect(clampWidgetSize(units(99, 99), layout, 65)).toEqual(units(40, 30));
  });

  it("clamps the width to the canvas right edge relative to the anchor", () => {
    // Canvas 40 units wide, widget anchored at x=10: max w = 30.
    expect(clampWidgetSize(units(50, 16), layout, 40, 10)).toEqual(units(30, 16));
    // Anchor 0: the whole canvas.
    expect(clampWidgetSize(units(50, 16), layout, 40, 0)).toEqual(units(40, 16));
  });

  it("never lets the canvas push width below the minimum", () => {
    expect(clampWidgetSize(units(20, 16), layout, 10, 0)).toEqual(units(16, 16));
  });

  it("skips the horizontal bound when the capacity is unknown", () => {
    expect(clampWidgetSize(units(200, 16), layout, 0)).toEqual(units(40, 16));
  });

  it("height is unbounded without maxH (canvas grows downwards)", () => {
    const noMaxH = resolveWidgetDefaults({ minH: 8 });
    expect(clampWidgetSize(units(20, 5000), noMaxH, 65)).toEqual(units(20, 5000));
  });
});

describe("clampPlacement", () => {
  it("rejects negative x/y", () => {
    expect(clampPlacement({ x: -3, y: -1 }, defaultUnits, 1040)).toEqual({ x: 0, y: 0 });
  });

  it("clamps the right edge to the canvas width", () => {
    // Canvas 320px wide = 20 units; a 20-unit card may only sit at x=0.
    expect(clampPlacement({ x: 30, y: 4 }, units(20, 7), 320)).toEqual({ x: 0, y: 4 });
    // A 10-unit card in a 320px canvas: max x = 10.
    expect(clampPlacement({ x: 99, y: 0 }, units(10, 7), 320)).toEqual({ x: 10, y: 0 });
    expect(clampPlacement({ x: 5, y: 0 }, units(10, 7), 320)).toEqual({ x: 5, y: 0 });
  });

  it("uses the explicit w for the right-edge clamp", () => {
    // Explicit 28-wide card in a 40-unit canvas: max x = 12.
    expect(clampPlacement({ x: 30, y: 0, w: 28, h: 20 }, defaultUnits, 640)).toEqual({
      x: 12,
      y: 0,
      w: 28,
      h: 20,
    });
  });

  it("skips the horizontal clamp when the canvas width is unknown", () => {
    expect(clampPlacement({ x: 40, y: -2 }, units(20, 7), 0)).toEqual({ x: 40, y: 0 });
  });

  it("keeps w/h fields when clamping", () => {
    expect(clampPlacement({ x: -1, y: 2, w: 4, h: 3 }, defaultUnits, 0)).toEqual({ x: 0, y: 2, w: 4, h: 3 });
  });
});

describe("resizePlacement", () => {
  const layout = resolveWidgetDefaults({ minW: 16, minH: 12, defaultW: 20, defaultH: 16 });
  const canvas = 1040; // 65 units

  it("resizes both dimensions and keeps x/y anchored", () => {
    const { placement, valid } = resizePlacement({ x: 5, y: 7, w: 20, h: 16 }, units(28, 20), layout, canvas, []);
    expect(placement).toEqual({ x: 5, y: 7, w: 28, h: 20 });
    expect(valid).toBe(true);
  });

  it("snaps fractional attempts to whole units", () => {
    const { placement } = resizePlacement({ x: 0, y: 0, w: 20, h: 16 }, units(27.6, 19.2), layout, canvas, []);
    expect(placement).toEqual({ x: 0, y: 0, w: 28, h: 19 });
  });

  it("clamps to the minimum size", () => {
    const { placement } = resizePlacement({ x: 0, y: 0, w: 20, h: 16 }, units(2, 2), layout, canvas, []);
    expect(placement).toEqual({ x: 0, y: 0, w: 16, h: 12 });
  });

  it("clamps the right edge to the canvas", () => {
    // Anchor x=60 in a 65-unit canvas: max w = 5 — but minW floors it at 16.
    const { placement } = resizePlacement({ x: 60, y: 0, w: 4, h: 12 }, units(90, 16), layout, canvas, []);
    expect(placement).toEqual({ x: 60, y: 0, w: 16, h: 16 });
    // Comfortable anchor: 65 - 40 = 25 usable units.
    const wide = resizePlacement({ x: 40, y: 0, w: 20, h: 16 }, units(60, 16), layout, canvas, []);
    expect(wide.placement.w).toBe(25);
  });

  it("flags a resize that would collide with another widget", () => {
    // Neighbor right next to the widget (gap unit included in its rect).
    const others = [placementRect({ x: 21, y: 0 }, units(20, 16))];
    const collision = resizePlacement({ x: 0, y: 0, w: 20, h: 16 }, units(24, 16), layout, canvas, others);
    expect(collision.valid).toBe(false);
    expect(collision.placement).toEqual({ x: 0, y: 0, w: 24, h: 16 });
    // Shrinking away from it stays valid.
    const shrink = resizePlacement({ x: 0, y: 0, w: 24, h: 16 }, units(20, 16), layout, canvas, others);
    expect(shrink.valid).toBe(true);
  });

  it("grows the height without a ceiling (canvas growth is the caller's job)", () => {
    const { placement, valid } = resizePlacement({ x: 0, y: 0, w: 20, h: 16 }, units(20, 400), layout, canvas, []);
    expect(placement.h).toBe(400);
    expect(valid).toBe(true);
  });
});

describe("resolveWidgetDensity", () => {
  const layout = resolveWidgetDefaults({
    density: { normal: { minW: 18, minH: 14 }, expanded: { minW: 26, minH: 20 } },
  });

  it("is compact below the normal threshold", () => {
    expect(resolveWidgetDensity(layout, 17, 20)).toBe("compact");
    expect(resolveWidgetDensity(layout, 20, 13)).toBe("compact");
  });

  it("is normal when the normal threshold is met", () => {
    expect(resolveWidgetDensity(layout, 18, 14)).toBe("normal");
    expect(resolveWidgetDensity(layout, 25, 19)).toBe("normal");
  });

  it("is expanded only when BOTH width and height qualify", () => {
    expect(resolveWidgetDensity(layout, 26, 20)).toBe("expanded");
    expect(resolveWidgetDensity(layout, 26, 19)).toBe("normal");
    expect(resolveWidgetDensity(layout, 25, 20)).toBe("normal");
  });

  it("falls back to normal without any thresholds (legacy widgets)", () => {
    const bare = resolveWidgetDefaults(undefined);
    expect(resolveWidgetDensity(bare, 1, 1)).toBe("normal");
    expect(resolveWidgetDensity(bare, 60, 60)).toBe("normal");
  });

  it("treats a missing threshold field as 0 (always met)", () => {
    const widthOnly = resolveWidgetDefaults({ density: { normal: { minW: 18 } } });
    expect(resolveWidgetDensity(widthOnly, 18, 1)).toBe("normal");
    expect(resolveWidgetDensity(widthOnly, 17, 99)).toBe("compact");
  });

  it("expanded-only declarations keep sizes below it at normal", () => {
    const expandedOnly = resolveWidgetDefaults({ density: { expanded: { minW: 26, minH: 20 } } });
    expect(resolveWidgetDensity(expandedOnly, 10, 10)).toBe("normal");
    expect(resolveWidgetDensity(expandedOnly, 26, 20)).toBe("expanded");
  });
});

describe("findFirstFreePosition", () => {
  it("finds the top-left free slot for an empty canvas", () => {
    expect(findFirstFreePosition(defaultUnits, [], 1040)).toEqual({ x: 0, y: 0, w: 20, h: 16 });
  });

  it("places to the right of an occupied slot when it fits", () => {
    const occupied = [placementRect({ x: 0, y: 0 }, units(20, 13))];
    // Default card (20 units wide) lands right after the first + gap.
    expect(findFirstFreePosition(units(20, 13), occupied, 1040)).toEqual({ x: 21, y: 0, w: 20, h: 13 });
  });

  it("wraps below the stack when the row is full", () => {
    // 320px canvas = 20 units: a 20-unit card already fills the row.
    const occupied = [placementRect({ x: 0, y: 0 }, units(20, 13))];
    const found = findFirstFreePosition(units(20, 13), occupied, 320);
    expect(found).toEqual({ x: 0, y: 14, w: 20, h: 13 }); // 13 units + 1 gap
  });

  it("navigates around multiple obstacles deterministically", () => {
    // Three cards fill the 65-unit row: 0..20, 21..41, 42..62.
    const occupied = [
      placementRect({ x: 0, y: 0 }, units(20, 7)),
      placementRect({ x: 21, y: 0 }, units(20, 7)),
      placementRect({ x: 42, y: 0 }, units(20, 7)),
    ];
    // First free slot wraps to the next row (7 units + 1 gap).
    expect(findFirstFreePosition(units(20, 7), occupied, 1040)).toEqual({ x: 0, y: 8, w: 20, h: 7 });
    // But a narrow card still fits at the row's right margin (x 63..64).
    expect(findFirstFreePosition(units(2, 7), occupied, 1040)).toEqual({ x: 63, y: 0, w: 2, h: 7 });
  });

  it("always terminates even for widgets wider than the canvas", () => {
    const occupied = [placementRect({ x: 0, y: 0 }, units(20, 7))];
    const found = findFirstFreePosition(units(250, 7), occupied, 320);
    expect(found).toEqual({ x: 0, y: 8, w: 250, h: 7 });
  });

  it("returns the searched-for size so new/shown widgets get default w/h", () => {
    const found = findFirstFreePosition(units(24, 18), [], 1040);
    expect(found).toMatchObject({ w: 24, h: 18 });
  });
});

describe("generateDefaultLayout", () => {
  it("packs entries left-to-right and wraps at the canvas edge", () => {
    // 65-unit canvas: cards at 20 units + 1 gap pitch -> x 0, 21, 42, then wrap.
    const items = generateDefaultLayout(
      [
        { key: "a", size: units(20, 7) },
        { key: "b", size: units(20, 7) },
        { key: "c", size: units(20, 7) },
        { key: "d", size: units(20, 7) },
      ],
      1040,
    );
    expect(items).toEqual({
      a: { x: 0, y: 0, w: 20, h: 7 },
      b: { x: 21, y: 0, w: 20, h: 7 },
      c: { x: 42, y: 0, w: 20, h: 7 },
      d: { x: 0, y: 8, w: 20, h: 7 }, // 7 units + 1 gap
    });
  });

  it("is deterministic for identical input", () => {
    const entries = [{ key: "a", size: units(20, 6) }, { key: "b", size: units(18, 19) }];
    expect(generateDefaultLayout(entries, 1040)).toEqual(generateDefaultLayout(entries, 1040));
  });

  it("produces a collision-free layout regardless of mixed sizes", () => {
    const entries = [
      { key: "a", size: units(20, 6) },
      { key: "b", size: units(18, 25) },
      { key: "c", size: units(38, 4) },
      { key: "d", size: units(20, 16) },
    ];
    const items = generateDefaultLayout(entries, 1040);
    const rects = entries.map((e) => placementRect(items[e.key]!, e.size));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it("uses the fallback capacity when the canvas width is unknown", () => {
    const items = generateDefaultLayout([{ key: "a", size: units(20, 7) }], 0);
    expect(items.a).toEqual({ x: 0, y: 0, w: 20, h: 7 });
  });
});

describe("migrateLegacyLayout", () => {
  it("converts a V1 order into placements (with sizes) plus preserved hidden keys", () => {
    const layout = migrateLegacyLayout(
      ["beta:w", "alpha:w"],
      ["alpha:w", "beta:w", "gamma:w"],
      { "alpha:w": units(20, 7), "beta:w": units(20, 7), "gamma:w": units(20, 7) },
      1040,
    );
    expect(layout.version).toBe(2);
    expect(layout.items["beta:w"]).toEqual({ x: 0, y: 0, w: 20, h: 7 });
    expect(layout.items["alpha:w"]).toEqual({ x: 21, y: 0, w: 20, h: 7 });
    // V1 semantics: available but unlisted widgets stay hidden.
    expect(layout.hidden).toEqual(["gamma:w"]);
  });

  it("drops stale keys from the legacy order without occupying slots", () => {
    const layout = migrateLegacyLayout(["gone:w", "alpha:w"], ["alpha:w"], { "alpha:w": units(20, 7) }, 1040);
    expect(layout.items).toEqual({ "alpha:w": { x: 0, y: 0, w: 20, h: 7 } });
    expect(layout.hidden).toEqual([]);
  });

  it("an empty legacy order hides everything available", () => {
    const layout = migrateLegacyLayout([], ["alpha:w"], {}, 1040);
    expect(layout.items).toEqual({});
    expect(layout.hidden).toEqual(["alpha:w"]);
  });
});

describe("resolveEffectiveLayout", () => {
  const specs: Record<string, WidgetLayoutSpec | undefined> = {
    clock: { defaultW: 24, defaultH: 18, minW: 16, minH: 12 },
    plain: undefined,
  };

  it("normalizes old V2 x/y-only entries to widget defaults (runtime only)", () => {
    const effective = resolveEffectiveLayout(
      // Non-overlapping positions: clock 24 wide to the right of plain.
      { kind: "v2", items: { clock: { x: 25, y: 4 }, plain: { x: 0, y: 0 } }, hidden: [] },
      ["clock", "plain"],
      specs,
      1040,
    );
    expect(effective.items).toEqual({
      clock: { x: 25, y: 4, w: 24, h: 18 },
      plain: { x: 0, y: 0, w: DEFAULT_CARD_WIDTH_UNITS, h: DEFAULT_CARD_HEIGHT_UNITS },
    });
  });

  it("keeps explicit saved w/h", () => {
    const effective = resolveEffectiveLayout(
      { kind: "v2", items: { clock: { x: 0, y: 0, w: 28, h: 20 } }, hidden: [] },
      ["clock"],
      specs,
      1040,
    );
    expect(effective.items.clock).toEqual({ x: 0, y: 0, w: 28, h: 20 });
  });

  it("runtime-clamps a saved size that exceeds the current canvas", () => {
    // 320px canvas = 20 units: a 28-wide card clamps down to 20.
    const effective = resolveEffectiveLayout(
      { kind: "v2", items: { clock: { x: 0, y: 0, w: 28, h: 20 } }, hidden: [] },
      ["clock"],
      specs,
      320,
    );
    expect(effective.items.clock).toEqual({ x: 0, y: 0, w: 20, h: 20 });
  });

  it("auto-places unplaced widgets with their default size", () => {
    const effective = resolveEffectiveLayout(
      { kind: "v2", items: { clock: { x: 0, y: 0 } }, hidden: [] },
      ["clock", "plain"],
      specs,
      1040,
    );
    // plain lands one gap right of the 24-wide clock.
    expect(effective.items.plain).toEqual({ x: 25, y: 0, w: DEFAULT_CARD_WIDTH_UNITS, h: DEFAULT_CARD_HEIGHT_UNITS });
  });
});

describe("collision repair (Phase 11)", () => {
  const repairSpecs: Record<string, WidgetLayoutSpec | undefined> = {};
  const card = (x: number, y: number, w = 20, h = 16) => ({ x, y, w, h });

  /** All pairwise rect combinations must be collision-free (gap included). */
  function expectCollisionFree(items: Record<string, { x: number; y: number; w?: number; h?: number }>) {
    const keys = Object.keys(items);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = items[keys[i]!]!;
        const b = items[keys[j]!]!;
        expect(
          rectsOverlap(
            { x: a.x, y: a.y, w: a.w ?? 20, h: a.h ?? 16 },
            { x: b.x, y: b.y, w: b.w ?? 20, h: b.h ?? 16 },
          ),
          `${keys[i]} overlaps ${keys[j]}`,
        ).toBe(false);
      }
    }
  }

  it("keeps a collision-free layout exactly as saved", () => {
    const items = { a: card(0, 0), b: card(21, 0), c: card(0, 17) };
    expect(repairCollisions(items, repairSpecs, 1040)).toEqual(items);
  });

  it("moves only the later conflicting widget in reading order, keeping its size", () => {
    // Two cards stacked on the same slot (e.g. by the runtime clamp): the
    // first in reading order stays, the second keeps 20x16 and moves to the
    // first free slot (row-major scan: right of the keeper, not below).
    const repaired = repairCollisions({ a: card(0, 0), b: card(0, 0) }, repairSpecs, 1040);
    expect(repaired.a).toEqual(card(0, 0));
    expect(repaired.b).toEqual(card(21, 0));
  });

  it("is deterministic for identical input", () => {
    const items = { b: card(0, 0), a: card(0, 0), c: card(21, 0, 24, 18) };
    expect(repairCollisions(items, repairSpecs, 960)).toEqual(repairCollisions(items, repairSpecs, 960));
  });

  it("P1 repro: a layout saved wide and opened narrow is collision free", () => {
    // Saved at 1440px (4 cards in a row); the 960px clamp stacks the last
    // three onto the right edge — the repair must resolve every conflict.
    const savedWide = {
      a: card(0, 0),
      b: card(21, 0),
      c: card(42, 0),
      d: card(63, 0),
    };
    for (const width of [960, 1000, 1040, 1088, 1130]) {
      const effective = resolveEffectiveLayout(
        { kind: "v2", items: savedWide, hidden: [] },
        ["a", "b", "c", "d"],
        repairSpecs,
        width,
      );
      expectCollisionFree(effective.items);
      // The leading cards keep their saved slots.
      expect(effective.items.a).toEqual(card(0, 0));
      expect(effective.items.b).toEqual(card(21, 0));
    }
  });

  it("repairs hand-edited overlapping saved data without writing back", () => {
    const parsed = { kind: "v2" as const, items: { a: card(0, 0), b: card(10, 5) }, hidden: [] };
    const effective = resolveEffectiveLayout(parsed, ["a", "b"], repairSpecs, 1040);
    expectCollisionFree(effective.items);
    // The original parsed value is untouched (repair is runtime-only).
    expect(parsed.items.b).toEqual(card(10, 5));
  });
});

describe("default layout collision (Phase 11)", () => {
  /** Heterogeneous widget set from the Phase 11 brief. */
  const heteroSpecs: Record<string, WidgetLayoutSpec | undefined> = {
    A: { defaultW: 30, defaultH: 20 },
    B: { defaultW: 14, defaultH: 10 },
    C: { defaultW: 24, defaultH: 16 },
    D: { defaultW: 18, defaultH: 28 },
  };
  const heteroKeys = ["A", "B", "C", "D"];

  /** Grid rect view of a placement (generateDefaultLayout output always has w/h). */
  const asRect = (p: { x: number; y: number; w?: number; h?: number }) => ({
    x: p.x,
    y: p.y,
    w: p.w ?? 0,
    h: p.h ?? 0,
  });

  function expectDefaultCollisionFree(widthPx: number) {
    const entries = heteroKeys.map((key) => {
      const spec = heteroSpecs[key]!;
      return { key, size: units(spec.defaultW!, spec.defaultH!) };
    });
    const items = generateDefaultLayout(entries, widthPx);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        expect(rectsOverlap(asRect(items[entries[i]!.key]!), asRect(items[entries[j]!.key]!)), `${widthPx}px`).toBe(false);
      }
    }
  }

  it("heterogeneous default sizes stay collision free, including fallback width", () => {
    for (const width of [0, 500, 700, 960, 1040, 1280, 1920]) expectDefaultCollisionFree(width);
  });

  it("default sizes are never shrunk to fit a narrow canvas (wrap instead)", () => {
    const items = generateDefaultLayout(
      heteroKeys.map((key) => ({ key, size: units(heteroSpecs[key]!.defaultW!, heteroSpecs[key]!.defaultH!) })),
      320, // 20-unit canvas: nothing fits beside A (30 wide) — pack downward.
    );
    expect(items.A).toEqual({ x: 0, y: 0, w: 30, h: 20 });
    expect(items.B!.w).toBe(14);
    expect(items.B!.h).toBe(10);
  });

  it("restore-default result is collision free (all widgets, defaults, hidden cleared)", () => {
    const effective = resolveEffectiveLayout(
      { kind: "v2", items: { A: { x: 3, y: 4, w: 40, h: 12 } }, hidden: ["B", "C"] },
      heteroKeys,
      heteroSpecs,
      1040,
    );
    // Restore-default is generateDefaultLayout over every available key.
    const restored = generateDefaultLayout(
      heteroKeys.map((key) => ({ key, size: units(heteroSpecs[key]!.defaultW!, heteroSpecs[key]!.defaultH!) })),
      1040,
    );
    expect(Object.keys(restored).sort()).toEqual([...heteroKeys].sort());
    for (let i = 0; i < heteroKeys.length; i++) {
      for (let j = i + 1; j < heteroKeys.length; j++) {
        expect(rectsOverlap(asRect(restored[heteroKeys[i]!]!), asRect(restored[heteroKeys[j]!]!))).toBe(false);
      }
    }
    // Sanity: the input layout above stays repaired too.
    expect(effective.items.A).toBeDefined();
  });

  it("V1 migration result is collision free with heterogeneous sizes", () => {
    const migrated = migrateLegacyLayout(
      ["D", "A", "C"],
      heteroKeys,
      Object.fromEntries(heteroKeys.map((key) => [key, units(heteroSpecs[key]!.defaultW!, heteroSpecs[key]!.defaultH!)])),
      1040,
    );
    const rects = Object.values(migrated.items).map(asRect);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it("new-widget auto-placement and hidden->show land collision free", () => {
    // A shipped widget missing from the saved layout is auto-placed.
    const effective = resolveEffectiveLayout(
      { kind: "v2", items: { A: { x: 0, y: 0, w: 30, h: 20 } }, hidden: [] },
      heteroKeys,
      heteroSpecs,
      1040,
    );
    // Hidden -> show uses the same primitive against full occupancy.
    const occupied = Object.entries(effective.items).map(([key, p]) =>
      placementRect(p, { w: heteroSpecs[key]!.defaultW!, h: heteroSpecs[key]!.defaultH! }),
    );
    const shown = findFirstFreePosition(units(18, 28), occupied, 1040);
    expect(rectIsFree(asRect(shown), occupied)).toBe(true);
    // And the effective layout itself is collision free.
    const rects = Object.entries(effective.items).map(([key, p]) =>
      placementRect(p, { w: heteroSpecs[key]!.defaultW!, h: heteroSpecs[key]!.defaultH! }),
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it("V2 x/y-only entries with heterogeneous defaults normalize to collision-free explicit sizes", () => {
    const effective = resolveEffectiveLayout(
      { kind: "v2", items: { A: { x: 0, y: 0 }, B: { x: 31, y: 0 } }, hidden: [] },
      heteroKeys,
      heteroSpecs,
      1040,
    );
    for (const key of heteroKeys) {
      expect(effective.items[key]!.w).toBeDefined();
      expect(effective.items[key]!.h).toBeDefined();
    }
    const rects = Object.entries(effective.items).map(([key, p]) =>
      placementRect(p, { w: heteroSpecs[key]!.defaultW!, h: heteroSpecs[key]!.defaultH! }),
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });
});

describe("resize isolation invariant (Phase 11)", () => {
  const layout = resolveWidgetDefaults({ minW: 16, minH: 12, defaultW: 20, defaultH: 16 });

  it("resizePlacement changes only w/h — x/y stay anchored", () => {
    const origin = { x: 7, y: 9, w: 20, h: 16 };
    const before = structuredClone(origin);
    const { placement } = resizePlacement(origin, units(26, 22), layout, 1040, []);
    expect(placement.x).toBe(before.x);
    expect(placement.y).toBe(before.y);
    expect(placement.w).toBe(26);
    expect(placement.h).toBe(22);
  });

  it("a colliding candidate is flagged invalid — never someone else's job", () => {
    const others = [placementRect({ x: 21, y: 0 }, units(20, 16))];
    const { valid } = resizePlacement({ x: 0, y: 0, w: 20, h: 16 }, units(30, 16), layout, 1040, others);
    expect(valid).toBe(false);
  });
});

describe("canvasHeightFor", () => {
  it("never shrinks below MIN_CANVAS_HEIGHT_PX", () => {
    expect(canvasHeightFor([])).toBeGreaterThanOrEqual(480);
  });

  it("grows below the lowest rect plus padding", () => {
    const height = canvasHeightFor([placementRect({ x: 0, y: 20 }, units(20, 16))]);
    // bottom = 20 + 16 = 36 units -> 576px + 48 padding = 624
    expect(height).toBe(36 * GRID_SIZE + 48);
  });
});

describe("sortForMobile", () => {
  it("sorts by y then x with a deterministic key tiebreak", () => {
    const sorted = sortForMobile({
      "b:2": { x: 5, y: 1 },
      "a:1": { x: 0, y: 2 },
      "c:3": { x: 1, y: 1 },
      "d:4": { x: 1, y: 1 },
    });
    expect(sorted).toEqual(["c:3", "d:4", "b:2", "a:1"]);
  });
});

describe("gridKeyboardCoordinateGetter", () => {
  const coords = { x: 100, y: 50 };

  it("moves one grid unit per arrow key", () => {
    expect(gridKeyboardCoordinateGetter({ code: "ArrowRight" }, { currentCoordinates: coords })).toEqual({ x: 116, y: 50 });
    expect(gridKeyboardCoordinateGetter({ code: "ArrowLeft" }, { currentCoordinates: coords })).toEqual({ x: 84, y: 50 });
    expect(gridKeyboardCoordinateGetter({ code: "ArrowUp" }, { currentCoordinates: coords })).toEqual({ x: 100, y: 34 });
    expect(gridKeyboardCoordinateGetter({ code: "ArrowDown" }, { currentCoordinates: coords })).toEqual({ x: 100, y: 66 });
  });

  it("ignores non-arrow keys", () => {
    expect(gridKeyboardCoordinateGetter({ code: "Space" }, { currentCoordinates: coords })).toBeUndefined();
    expect(gridKeyboardCoordinateGetter({ code: "KeyA" }, { currentCoordinates: coords })).toBeUndefined();
  });
});

describe("collision gap constant", () => {
  it("keeps the documented 16px minimum separation", () => {
    expect(COLLISION_GAP_UNITS * GRID_SIZE).toBe(16);
  });
});
