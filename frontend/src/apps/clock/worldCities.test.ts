import { describe, expect, it } from "vitest";
import { WORLD_CITY_PRESETS, findWorldCityPreset, worldCityValue } from "./worldCities";

describe("world city presets", () => {
  it("only contains valid IANA timezones", () => {
    // Intl rejects unknown zone names at construction time, so building a
    // formatter per preset is the validity check.
    for (const preset of WORLD_CITY_PRESETS) {
      expect(() => new Intl.DateTimeFormat("en", { timeZone: preset.timezone })).not.toThrow();
    }
  });

  it("binds each city to exactly one timezone (unique select values)", () => {
    const zones = WORLD_CITY_PRESETS.map(worldCityValue);
    expect(new Set(zones).size).toBe(zones.length);
    const cities = WORLD_CITY_PRESETS.map((preset) => preset.city);
    expect(new Set(cities).size).toBe(cities.length);
  });

  it("covers the major UTC bands", () => {
    const zones = new Set(WORLD_CITY_PRESETS.map((preset) => preset.timezone));
    for (const zone of ["Asia/Tokyo", "Europe/London", "America/New_York", "Australia/Sydney", "Etc/UTC"]) {
      expect(zones.has(zone)).toBe(true);
    }
  });

  it("looks presets up by their select value", () => {
    const tokyo = findWorldCityPreset("Asia/Tokyo");
    expect(tokyo).toMatchObject({ city: "Tokyo", timezone: "Asia/Tokyo" });
    expect(findWorldCityPreset("Nowhere/None")).toBeUndefined();
  });
});
