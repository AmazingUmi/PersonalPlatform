import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "../../src/core/api/errors.js";
import {
  DEFAULT_SORT_BY,
  MOODS,
  SORT_COLUMNS,
  dayKeys,
  dedupeTagIds,
  isUuid,
  localDayKey,
  normalizeTagName,
  parseTagsQuery,
} from "../../src/apps/notes/model.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_B_UPPER = "22222222-2222-4222-8222-222222222222".toUpperCase();

describe("notes model MOODS", () => {
  it("is exactly the five fixed moods", () => {
    assert.deepEqual([...MOODS], ["great", "good", "neutral", "low", "bad"]);
  });
});

describe("notes model SORT_COLUMNS", () => {
  it("maps every allowed sortBy to its snake_case column", () => {
    assert.deepEqual(SORT_COLUMNS, {
      occurredAt: "occurred_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
  });

  it("defaults to occurredAt and the default resolves through the allowlist", () => {
    assert.equal(DEFAULT_SORT_BY, "occurredAt");
    assert.ok(SORT_COLUMNS[DEFAULT_SORT_BY] === "occurred_at");
  });
});

describe("notes model parseTagsQuery", () => {
  it("returns [] for undefined and empty input", () => {
    assert.deepEqual(parseTagsQuery(undefined), []);
    assert.deepEqual(parseTagsQuery(""), []);
  });

  it("parses a single id", () => {
    assert.deepEqual(parseTagsQuery(UUID_A), [UUID_A]);
  });

  it("parses multiple comma-separated ids in order", () => {
    assert.deepEqual(parseTagsQuery(`${UUID_A},${UUID_B}`), [UUID_A, UUID_B]);
  });

  it("dedupes repeated ids", () => {
    assert.deepEqual(parseTagsQuery(`${UUID_A},${UUID_B},${UUID_A}`), [UUID_A, UUID_B]);
  });

  it("drops empty segments (double commas, trailing comma)", () => {
    assert.deepEqual(parseTagsQuery(`${UUID_A},,${UUID_B}`), [UUID_A, UUID_B]);
    assert.deepEqual(parseTagsQuery(`${UUID_A},`), [UUID_A]);
    assert.deepEqual(parseTagsQuery(`,${UUID_A}`), [UUID_A]);
    assert.deepEqual(parseTagsQuery(","), []);
  });

  it("accepts uppercase uuid hex", () => {
    assert.deepEqual(parseTagsQuery(UUID_B_UPPER), [UUID_B]);
  });

  it("throws AppError 400 validation_error on a non-uuid segment", () => {
    assert.throws(
      () => parseTagsQuery(`${UUID_A},not-a-uuid`),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "validation_error");
        return true;
      },
    );
  });
});

describe("notes model dedupeTagIds", () => {
  it("removes duplicates while preserving first-seen order", () => {
    assert.deepEqual(dedupeTagIds([UUID_B, UUID_A, UUID_B, UUID_A, UUID_B]), [UUID_B, UUID_A]);
  });

  it("passes through empty and single-element arrays", () => {
    assert.deepEqual(dedupeTagIds([]), []);
    assert.deepEqual(dedupeTagIds([UUID_A]), [UUID_A]);
  });
});

describe("notes model isUuid", () => {
  it("accepts canonical uuids and rejects everything else", () => {
    assert.equal(isUuid(UUID_A), true);
    assert.equal(isUuid(UUID_B_UPPER), true);
    assert.equal(isUuid("notes"), false);
    assert.equal(isUuid(`${UUID_A}extra`), false);
  });
});

describe("notes model normalizeTagName", () => {
  it("trims surrounding whitespace", () => {
    assert.equal(normalizeTagName("  ideas  "), "ideas");
  });

  it("returns null for empty and whitespace-only names", () => {
    assert.equal(normalizeTagName(""), null);
    assert.equal(normalizeTagName("   "), null);
  });

  it("returns null above 50 characters, accepts exactly 50", () => {
    assert.equal(normalizeTagName("a".repeat(50)), "a".repeat(50));
    assert.equal(normalizeTagName("a".repeat(51)), null);
  });
});

describe("notes model localDayKey/dayKeys", () => {
  it("derives the local date across a day boundary (Asia/Shanghai)", () => {
    // 16:00Z is midnight next day at UTC+8.
    assert.equal(localDayKey("Asia/Shanghai", new Date("2026-08-31T16:00:00Z")), "2026-09-01");
    assert.equal(localDayKey("Asia/Shanghai", new Date("2026-08-31T15:59:59Z")), "2026-08-31");
  });

  it("is UTC-neutral for UTC", () => {
    assert.equal(localDayKey("UTC", new Date("2026-08-31T23:59:59Z")), "2026-08-31");
    assert.equal(localDayKey("UTC", new Date("2026-09-01T00:00:00Z")), "2026-09-01");
  });

  it("handles a DST transition day (America/New_York)", () => {
    // US DST ends 2026-11-01 at 02:00 EDT (06:00Z). Midnight of Nov 1 is
    // 04:00Z; 2026-11-01T05:00:00Z is 01:00 EDT — still Nov 1 local.
    assert.equal(localDayKey("America/New_York", new Date("2026-11-01T05:00:00Z")), "2026-11-01");
    // One millisecond before local midnight: 2026-11-01T03:59:59Z is
    // 23:59:59 EDT on Oct 31.
    assert.equal(localDayKey("America/New_York", new Date("2026-11-01T03:59:59Z")), "2026-10-31");
    // After the fall-back (06:00Z) the repeated 01:00 hour is still Nov 1.
    assert.equal(localDayKey("America/New_York", new Date("2026-11-01T06:30:00Z")), "2026-11-01");
  });

  it("dayKeys: today from the local-day start, yesterday from the instant before midnight", () => {
    // Local midnight in Shanghai on 2026-09-01.
    const todayStart = new Date("2026-08-31T16:00:00Z");
    assert.deepEqual(dayKeys("Asia/Shanghai", todayStart), {
      todayKey: "2026-09-01",
      yesterdayKey: "2026-08-31",
    });
    // UTC edge: today starts at 2026-09-01T00:00:00Z; yesterday is Aug 31.
    assert.deepEqual(dayKeys("UTC", new Date("2026-09-01T00:00:00Z")), {
      todayKey: "2026-09-01",
      yesterdayKey: "2026-08-31",
    });
  });

  it("dayKeys: yesterday stays adjacent across DST transitions", () => {
    // America/New_York fall-back on 2026-11-01: local midnight is 04:00Z (EDT).
    assert.deepEqual(dayKeys("America/New_York", new Date("2026-11-01T04:00:00Z")), {
      todayKey: "2026-11-01",
      yesterdayKey: "2026-10-31",
    });
    // Spring-forward on 2026-03-08: local midnight is 05:00Z (EST).
    assert.deepEqual(dayKeys("America/New_York", new Date("2026-03-08T05:00:00Z")), {
      todayKey: "2026-03-08",
      yesterdayKey: "2026-03-07",
    });
  });
});
