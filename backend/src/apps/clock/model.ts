/**
 * Pure clock-app domain helpers: settings sanitizing, alarm-shape validation
 * and view mapping. No I/O (focus timer.ts precedent — everything here is
 * unit-testable without a database).
 */

export interface ClockSettingsView {
  displayMode: "digital" | "analog";
  showSeconds: boolean;
  showDate: boolean;
  hourFormat: 12 | 24;
}

export const DEFAULT_CLOCK_SETTINGS: ClockSettingsView = {
  displayMode: "digital",
  showSeconds: true,
  showDate: true,
  hourFormat: 24,
};

/**
 * Defensive settings read: a missing or poisoned row falls back to defaults
 * (focus getSettings precedent). Returns null only for a PUT payload that
 * survived JSON Schema but is still not a legal settings object.
 */
export function sanitizeClockSettings(value: unknown): ClockSettingsView | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { displayMode, hourFormat, showSeconds, showDate } = raw;
  if (displayMode !== "digital" && displayMode !== "analog") return null;
  if (hourFormat !== 12 && hourFormat !== 24) return null;
  if (typeof showSeconds !== "boolean" || typeof showDate !== "boolean") return null;
  return { displayMode, showSeconds, showDate, hourFormat };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Alarm wall-clock time, 'HH:MM' 24h (stored as text; the DB enforces the same shape). */
export const ALARM_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Weekday repeat set: 0 = Sunday … 6 = Saturday (JS Date / node-cron
 * convention). Sorted, deduped; throws on out-of-range input.
 */
export function normalizeRepeatDays(value: unknown): number[] {
  if (!Array.isArray(value)) throw new TypeError("repeatDays must be an array");
  const out = new Set<number>();
  for (const day of value) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      throw new TypeError(`repeatDays entry must be an integer 0-6 (got ${String(day)})`);
    }
    out.add(day);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * IANA timezone check without importing core/time (apps see TimeService only
 * through AppContext). Uses the runtime's own zone database, so validity and
 * DST behavior always agree with what Intl will format later.
 */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
