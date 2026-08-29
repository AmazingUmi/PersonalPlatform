import { describe, expect, it } from "vitest";
import { normalizeOverrides, resolvePresentation } from "./presentation";
import type { AppInfo } from "./api";

function app(partial: Partial<AppInfo> = {}): Pick<AppInfo, "id" | "name"> {
  return { id: "assets", name: "Assets", ...partial };
}

describe("normalizeOverrides", () => {
  it("returns an empty map for invalid shapes", () => {
    expect(normalizeOverrides(null)).toEqual({});
    expect(normalizeOverrides("x")).toEqual({});
    expect(normalizeOverrides([1, 2])).toEqual({});
  });

  it("keeps valid entries and drops invalid fields", () => {
    const normalized = normalizeOverrides({
      assets: { displayName: "My Inventory", accent: "mint" },
      tasks: { displayName: "   " }, // whitespace-only is dropped
      mini_game: { accent: "hot-pink" }, // unknown accent is dropped
      broken: "not-an-object",
    });
    expect(normalized).toEqual({ assets: { displayName: "My Inventory", accent: "mint" } });
  });
});

describe("resolvePresentation (FP-6.2)", () => {
  it("falls back to manifest defaults without overrides", () => {
    const resolved = resolvePresentation(app(), {});
    expect(resolved.displayName).toBe("Assets");
    expect(resolved.accent).toBe("yellow"); // default assets accent
    expect(resolved.isCustomized).toBe(false);
  });

  it("applies the user nickname", () => {
    const resolved = resolvePresentation(app(), { assets: { displayName: "我的仓库" } });
    expect(resolved.displayName).toBe("我的仓库");
    expect(resolved.isCustomized).toBe(true);
  });

  it("applies an allowlisted accent", () => {
    const resolved = resolvePresentation(app(), { assets: { accent: "mint" } });
    expect(resolved.accent).toBe("mint");
    expect(resolved.isCustomized).toBe(true);
  });

  it("ignores invalid accent values and falls back to the default", () => {
    const resolved = resolvePresentation(app(), { assets: { accent: "nope" } });
    expect(resolved.accent).toBe("yellow");
  });

  it("an override equal to the defaults is not customized", () => {
    const resolved = resolvePresentation(app(), { assets: { displayName: "Assets", accent: "yellow" } });
    expect(resolved.isCustomized).toBe(false);
  });
});
