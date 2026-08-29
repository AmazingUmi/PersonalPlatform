/**
 * Platform time semantics (FP-10): one source of truth for "now" and for the
 * user's local calendar day. Apps must never derive "today" from
 * `due_at::date = CURRENT_DATE` (server timezone) or their own timezone
 * logic — they ask this service, which follows the platform timezone.
 */

/** `UTC+8` / `GMT-7` style offsets are rejected: IANA names only. */
export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timezone` relative to UTC at the given instant, in ms. */
function timezoneOffsetMs(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  const utcSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return wallClockAsUtc - utcSeconds;
}

/** Start of the local calendar day containing instant `ms`, as a UTC Date. */
function startOfLocalDay(timezone: string, ms: number): Date {
  // Two passes so a DST transition between now and midnight is accounted for.
  let offset = timezoneOffsetMs(new Date(ms), timezone);
  let startMs = Math.floor((ms + offset) / 86_400_000) * 86_400_000 - offset;
  offset = timezoneOffsetMs(new Date(startMs), timezone);
  startMs = Math.floor((ms + offset) / 86_400_000) * 86_400_000 - offset;
  return new Date(startMs);
}

export interface UtcRange {
  start: Date;
  end: Date;
}

/**
 * The user's local "today" expressed in UTC as [start, end). Handles DST:
 * start and end are the actual local midnights, so the range is 23h/24h/25h
 * exactly when the user's calendar day is.
 */
export function localDayRangeUtc(timezone: string, now: Date = new Date()): UtcRange {
  const start = startOfLocalDay(timezone, now.getTime());
  // 36h after local midnight always lands inside the NEXT local day
  // regardless of a ±1h DST shift.
  const end = startOfLocalDay(timezone, start.getTime() + 36 * 3_600_000);
  return { start, end };
}

export interface TimeService {
  now(): Date;
  timezone(): string;
  todayRangeUtc(now?: Date): UtcRange;
}

export interface TimeServiceOptions {
  /** Seed timezone, e.g. from config `platform.timezone`. */
  defaultTimezone: string;
  /** Fixed clock for tests. */
  clock?: () => Date;
}

export class PlatformTimeService implements TimeService {
  private current: string;

  constructor(private readonly options: TimeServiceOptions) {
    this.current = isValidTimezone(options.defaultTimezone)
      ? options.defaultTimezone
      : "UTC";
  }

  now(): Date {
    return this.options.clock ? this.options.clock() : new Date();
  }

  timezone(): string {
    return this.current;
  }

  todayRangeUtc(now: Date = this.now()): UtcRange {
    return localDayRangeUtc(this.current, now);
  }

  /**
   * Switch the platform timezone at runtime (settings update). Invalid names
   * are rejected so the service can never sit on a broken timezone.
   */
  setTimezone(timezone: string): void {
    if (!isValidTimezone(timezone)) {
      throw new RangeError(`invalid IANA timezone '${timezone}'`);
    }
    this.current = timezone;
  }
}

export function createTimeService(options: TimeServiceOptions): PlatformTimeService {
  return new PlatformTimeService(options);
}
