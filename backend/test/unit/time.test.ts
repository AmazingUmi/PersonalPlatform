import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTimeService,
  isValidTimezone,
  localDayRangeUtc,
} from "../../src/core/time/index.js";

describe("isValidTimezone (FP-10.1)", () => {
  it("accepts IANA names", () => {
    assert.equal(isValidTimezone("Asia/Shanghai"), true);
    assert.equal(isValidTimezone("America/Los_Angeles"), true);
    assert.equal(isValidTimezone("Europe/Berlin"), true);
    assert.equal(isValidTimezone("UTC"), true);
  });

  it("rejects offset-style names and garbage", () => {
    assert.equal(isValidTimezone("UTC+8"), false);
    assert.equal(isValidTimezone("GMT-7"), false);
    assert.equal(isValidTimezone("Not/AZone"), false);
    assert.equal(isValidTimezone(""), false);
  });
});

describe("localDayRangeUtc (FP-10.2)", () => {
  it("returns [start, end) covering the user's local day in Shanghai", () => {
    // 2026-08-30T10:00Z is 18:00 local in Shanghai (UTC+8, no DST).
    const now = new Date("2026-08-30T10:00:00Z");
    const range = localDayRangeUtc("Asia/Shanghai", now);
    assert.equal(range.start.toISOString(), "2026-08-29T16:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-08-30T16:00:00.000Z");
    assert.ok(range.start <= now && now < range.end, "now falls inside today's range");
  });

  it("handles negative offsets around UTC midnight (Los Angeles)", () => {
    // 2026-08-30T02:00Z is Aug 29 19:00 in LA (UTC-7 during PDT), so the
    // user's "today" spans UTC Aug 29 07:00 -> Aug 30 07:00.
    const now = new Date("2026-08-30T02:00:00Z");
    const range = localDayRangeUtc("America/Los_Angeles", now);
    assert.equal(range.start.toISOString(), "2026-08-29T07:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-08-30T07:00:00.000Z");
  });

  it("crossing local midnight flips the range even though UTC date is unchanged", () => {
    const before = new Date("2026-08-29T15:59:59Z"); // 23:59:59 Shanghai
    const after = new Date("2026-08-29T16:00:00Z"); // 00:00:00 Shanghai next day
    const r1 = localDayRangeUtc("Asia/Shanghai", before);
    const r2 = localDayRangeUtc("Asia/Shanghai", after);
    assert.equal(r1.end.getTime(), r2.start.getTime(), "adjacent days share the midnight boundary");
    assert.notEqual(r1.start.getTime(), r2.start.getTime());
  });

  it("produces a 23h local day across a spring-forward DST transition", () => {
    // Europe/Berlin sprang forward 2026-03-29 02:00 -> 03:00 local.
    const now = new Date("2026-03-29T12:00:00Z"); // 14:00 local (CEST, UTC+2)
    const range = localDayRangeUtc("Europe/Berlin", now);
    assert.equal(range.start.toISOString(), "2026-03-28T23:00:00.000Z"); // 00:00 CET
    assert.equal(range.end.toISOString(), "2026-03-29T22:00:00.000Z"); // 00:00 CEST next day
    assert.equal(range.end.getTime() - range.start.getTime(), 23 * 3_600_000);
  });

  it("UTC today is an exact 24h day", () => {
    const range = localDayRangeUtc("UTC", new Date("2026-08-30T23:59:59.999Z"));
    assert.equal(range.start.toISOString(), "2026-08-30T00:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-08-31T00:00:00.000Z");
  });
});

describe("PlatformTimeService (FP-10.2)", () => {
  it("uses the configured timezone and a fixed clock", () => {
    const time = createTimeService({
      defaultTimezone: "Asia/Shanghai",
      clock: () => new Date("2026-08-30T10:00:00Z"),
    });
    assert.equal(time.timezone(), "Asia/Shanghai");
    assert.equal(time.now().toISOString(), "2026-08-30T10:00:00.000Z");
    assert.equal(time.todayRangeUtc().start.toISOString(), "2026-08-29T16:00:00.000Z");
  });

  it("falls back to UTC for an invalid configured timezone", () => {
    const time = createTimeService({ defaultTimezone: "UTC+8" });
    assert.equal(time.timezone(), "UTC");
  });

  it("setTimezone switches today's range and rejects invalid names", () => {
    const time = createTimeService({ defaultTimezone: "UTC" });
    const now = new Date("2026-08-30T02:00:00Z");
    assert.equal(time.todayRangeUtc(now).start.toISOString(), "2026-08-30T00:00:00.000Z");

    time.setTimezone("America/Los_Angeles");
    assert.equal(time.todayRangeUtc(now).start.toISOString(), "2026-08-29T07:00:00.000Z");

    assert.throws(() => time.setTimezone("GMT-7"), RangeError);
    assert.equal(time.timezone(), "America/Los_Angeles", "invalid switch leaves timezone unchanged");
  });
});
