import { AppError } from "../../core/api/errors.js";

/**
 * Pure functions for the notes app (worklist §3): validation, allowlists and
 * calendar helpers with zero I/O, so unit tests need no database or platform.
 */

/** The five mood values; mirrors the notes.mood CHECK constraint (worklist §1). */
export const MOODS = ["great", "good", "neutral", "low", "bad"] as const;

export type Mood = (typeof MOODS)[number];

/**
 * Explicit sort allowlist: request values never reach SQL as identifiers
 * (assets ITEM_SORT_COLUMNS precedent). occurredAt is the default.
 */
export const SORT_COLUMNS: Record<string, string> = {
  occurredAt: "occurred_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export const DEFAULT_SORT_BY = "occurredAt";

/** Same uuid shape every platform id column uses. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Tag names are 1..50 characters after trimming (POST /tags, worklist §2.2). */
const TAG_NAME_MAX_LENGTH = 50;

/**
 * Parse the `tags` query parameter: a single comma-separated list of tag ids.
 * Empty segments (trailing/double commas) are dropped, valid ids dedupe in
 * order, and any non-uuid segment is a 400 validation_error.
 */
export function parseTagsQuery(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  for (const segment of raw.split(",")) {
    if (segment === "") continue;
    if (!isUuid(segment)) {
      throw new AppError(400, "validation_error", `invalid tag id "${segment}" in tags query`, { tags: raw });
    }
    ids.push(segment);
  }
  return dedupeTagIds(ids);
}

/** Silent dedupe for request tagIds (worklist §2.3): Set semantics, order kept. */
export function dedupeTagIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Trim a tag name; null means "not usable" (empty or over the length limit)
 * and the handler turns that into a 400 validation_error.
 */
export function normalizeTagName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > TAG_NAME_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Local calendar date ("YYYY-MM-DD") of an instant in an IANA timezone.
 * en-CA formats as ISO-style YYYY-MM-DD. This is the only place day keys are
 * derived in JS — mirrors the SQL `(occurred_at AT TIME ZONE $tz)::date`
 * expression so both sides share one platform timezone.
 */
export function localDayKey(timeZone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

export interface DayKeys {
  todayKey: string;
  yesterdayKey: string;
}

/**
 * todayKey/yesterdayKey for list responses, derived from the UTC start of the
 * user's local "today" (ctx.time.todayRangeUtc().start). That start is the
 * exact local-midnight instant, so the millisecond just before it is by
 * definition the last moment of yesterday — DST-proof with no offset
 * arithmetic. (A "-36h" fallback would land two days back: from midnight,
 * 24h+ back crosses into the day before yesterday.)
 */
export function dayKeys(timeZone: string, todayStartUtc: Date): DayKeys {
  return {
    todayKey: localDayKey(timeZone, todayStartUtc),
    yesterdayKey: localDayKey(timeZone, new Date(todayStartUtc.getTime() - 1)),
  };
}
