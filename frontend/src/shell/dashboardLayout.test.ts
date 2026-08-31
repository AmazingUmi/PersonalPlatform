import { describe, expect, it } from "vitest";
import {
  COLLISION_GAP_UNITS,
  DEFAULT_CARD_WIDTH_PX,
  ESTIMATED_CARD_HEIGHT_PX,
  GRID_SIZE,
  canvasCapacityUnits,
  canvasHeightFor,
  clampPlacement,
  findFirstFreePosition,
  generateDefaultLayout,
  gridKeyboardCoordinateGetter,
  gridUnits,
  migrateLegacyLayout,
  normalizeMeasuredSize,
  normalizePlacement,
  parseDashboardLayout,
  rectForPlacement,
  rectIsFree,
  rectsOverlap,
  serializeLayout,
  snapToGrid,
  sortForMobile,
  type WidgetSize,
} from "./dashboardLayout";

const size = (width: number, height: number): WidgetSize => ({ width, height });
const defaultSize = size(DEFAULT_CARD_WIDTH_PX, ESTIMATED_CARD_HEIGHT_PX);

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

  it("normalizes measured rects, falling back on zero sizes (jsdom)", () => {
    expect(normalizeMeasuredSize(0, 0)).toEqual(defaultSize);
    expect(normalizeMeasuredSize(320, 0)).toEqual({ width: 320, height: ESTIMATED_CARD_HEIGHT_PX });
    expect(normalizeMeasuredSize(320, 123)).toEqual({ width: 320, height: 123 });
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

  it("round-trips through serializeLayout", () => {
    const layout = serializeLayout({ a: { x: 1, y: 2 }, b: { x: 0, y: 9 } }, ["c"]);
    expect(parseDashboardLayout(layout)).toEqual({ kind: "v2", items: { a: { x: 1, y: 2 }, b: { x: 0, y: 9 } }, hidden: ["c"] });
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

  it("builds collision rects from placements with real pixel sizes", () => {
    expect(rectForPlacement({ x: 2, y: 3 }, size(320, 100))).toEqual({ x: 2, y: 3, w: 20, h: 7 });
  });

  it("rectIsFree checks against a list of others", () => {
    const occupied = [{ x: 0, y: 0, w: 20, h: 16 }];
    expect(rectIsFree({ x: 21, y: 0, w: 20, h: 16 }, occupied)).toBe(true);
    expect(rectIsFree({ x: 10, y: 0, w: 20, h: 16 }, occupied)).toBe(false);
  });
});

describe("clampPlacement", () => {
  it("rejects negative x/y", () => {
    expect(clampPlacement({ x: -3, y: -1 }, defaultSize, 1040)).toEqual({ x: 0, y: 0 });
  });

  it("clamps the right edge to the canvas width", () => {
    // Canvas 320px wide = 20 units; a 320px card (20 units) may only sit at x=0.
    expect(clampPlacement({ x: 30, y: 4 }, size(320, 100), 320)).toEqual({ x: 0, y: 4 });
    // A 160px card (10 units) in a 320px canvas: max x = 10.
    expect(clampPlacement({ x: 99, y: 0 }, size(160, 100), 320)).toEqual({ x: 10, y: 0 });
    expect(clampPlacement({ x: 5, y: 0 }, size(160, 100), 320)).toEqual({ x: 5, y: 0 });
  });

  it("skips the horizontal clamp when the canvas width is unknown", () => {
    expect(clampPlacement({ x: 40, y: -2 }, size(320, 100), 0)).toEqual({ x: 40, y: 0 });
  });

  it("keeps reserved w/h flags when clamping", () => {
    expect(clampPlacement({ x: -1, y: 2, w: 4, h: 3 }, defaultSize, 0)).toEqual({ x: 0, y: 2, w: 4, h: 3 });
  });
});

describe("findFirstFreePosition", () => {
  it("finds the top-left free slot for an empty canvas", () => {
    expect(findFirstFreePosition(defaultSize, [], 1040)).toEqual({ x: 0, y: 0 });
  });

  it("places to the right of an occupied slot when it fits", () => {
    const occupied = [rectForPlacement({ x: 0, y: 0 }, size(320, 200))];
    // Default card (20 units wide) lands right after the first + gap.
    expect(findFirstFreePosition(size(320, 200), occupied, 1040)).toEqual({ x: 21, y: 0 });
  });

  it("wraps below the stack when the row is full", () => {
    // 320px canvas = 20 units: a 20-unit card already fills the row.
    const occupied = [rectForPlacement({ x: 0, y: 0 }, size(320, 200))];
    const found = findFirstFreePosition(size(320, 200), occupied, 320);
    expect(found).toEqual({ x: 0, y: 14 }); // 200px = 13 units + 1 gap
  });

  it("navigates around multiple obstacles deterministically", () => {
    // Three cards fill the 65-unit row: 0..20, 21..41, 42..62.
    const occupied = [
      rectForPlacement({ x: 0, y: 0 }, size(320, 100)),
      rectForPlacement({ x: 21, y: 0 }, size(320, 100)),
      rectForPlacement({ x: 42, y: 0 }, size(320, 100)),
    ];
    // First free slot wraps to the next row (7 units + 1 gap).
    expect(findFirstFreePosition(size(320, 100), occupied, 1040)).toEqual({ x: 0, y: 8 });
    // But a narrow card still fits at the row's right margin (x 63..64).
    expect(findFirstFreePosition(size(32, 100), occupied, 1040)).toEqual({ x: 63, y: 0 });
  });

  it("always terminates even for widgets wider than the canvas", () => {
    const occupied = [rectForPlacement({ x: 0, y: 0 }, size(320, 100))];
    const found = findFirstFreePosition(size(4000, 100), occupied, 320);
    expect(found).toEqual({ x: 0, y: 8 });
  });
});

describe("generateDefaultLayout", () => {
  it("packs entries left-to-right and wraps at the canvas edge", () => {
    // 65-unit canvas: cards at 20 units + 1 gap pitch -> x 0, 21, 42, then wrap.
    const items = generateDefaultLayout(
      [
        { key: "a", size: size(320, 100) },
        { key: "b", size: size(320, 100) },
        { key: "c", size: size(320, 100) },
        { key: "d", size: size(320, 100) },
      ],
      1040,
    );
    expect(items).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 21, y: 0 },
      c: { x: 42, y: 0 },
      d: { x: 0, y: 8 }, // 100px = 7 units + 1 gap
    });
  });

  it("is deterministic for identical input", () => {
    const entries = [{ key: "a", size: size(320, 100) }, { key: "b", size: size(280, 300) }];
    expect(generateDefaultLayout(entries, 1040)).toEqual(generateDefaultLayout(entries, 1040));
  });

  it("produces a collision-free layout regardless of mixed sizes", () => {
    const entries = [
      { key: "a", size: size(320, 90) },
      { key: "b", size: size(280, 400) },
      { key: "c", size: size(600, 60) },
      { key: "d", size: size(320, 250) },
    ];
    const items = generateDefaultLayout(entries, 1040);
    const rects = entries.map((e) => rectForPlacement(items[e.key]!, e.size));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it("uses the fallback capacity when the canvas width is unknown", () => {
    const items = generateDefaultLayout([{ key: "a", size: size(320, 100) }], 0);
    expect(items.a).toEqual({ x: 0, y: 0 });
  });
});

describe("migrateLegacyLayout", () => {
  it("converts a V1 order into placements plus preserved hidden keys", () => {
    const layout = migrateLegacyLayout(
      ["beta:w", "alpha:w"],
      ["alpha:w", "beta:w", "gamma:w"],
      { "alpha:w": size(320, 100), "beta:w": size(320, 100), "gamma:w": size(320, 100) },
      1040,
    );
    expect(layout.version).toBe(2);
    expect(layout.items["beta:w"]).toEqual({ x: 0, y: 0 });
    expect(layout.items["alpha:w"]).toEqual({ x: 21, y: 0 });
    // V1 semantics: available but unlisted widgets stay hidden.
    expect(layout.hidden).toEqual(["gamma:w"]);
  });

  it("drops stale keys from the legacy order without occupying slots", () => {
    const layout = migrateLegacyLayout(["gone:w", "alpha:w"], ["alpha:w"], { "alpha:w": size(320, 100) }, 1040);
    expect(layout.items).toEqual({ "alpha:w": { x: 0, y: 0 } });
    expect(layout.hidden).toEqual([]);
  });

  it("an empty legacy order hides everything available", () => {
    const layout = migrateLegacyLayout([], ["alpha:w"], {}, 1040);
    expect(layout.items).toEqual({});
    expect(layout.hidden).toEqual(["alpha:w"]);
  });
});

describe("canvasHeightFor", () => {
  it("never shrinks below MIN_CANVAS_HEIGHT_PX", () => {
    expect(canvasHeightFor([])).toBeGreaterThanOrEqual(480);
  });

  it("grows below the lowest rect plus padding", () => {
    const height = canvasHeightFor([rectForPlacement({ x: 0, y: 20 }, size(320, 256))]);
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
