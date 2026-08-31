/**
 * Pure clock math: no React, no I/O, no server state. Everything here is
 * deterministic given a Date, so the tests cover 12/24 formatting, analog
 * hand angles, DST-correct zone offsets/day diffs and alarm scheduling
 * without touching the network (focus timer.ts precedent).
 */

export const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export interface TimeParts {
  hours24: string;
  hours12: string;
  meridiem: "AM" | "PM";
  minutes: string;
  seconds: string;
}

export const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Clock-face time parts for a wall-clock Date (browser-local). */
export function timeParts(date: Date): TimeParts {
  const hours = date.getHours();
  const meridiem: "AM" | "PM" = hours < 12 ? "AM" : "PM";
  return {
    hours24: pad2(hours),
    hours12: pad2(hours % 12 === 0 ? 12 : hours % 12),
    meridiem,
    minutes: pad2(date.getMinutes()),
    seconds: pad2(date.getSeconds()),
  };
}

export function weekdayLabel(date: Date): string {
  return WEEKDAY_LABELS[date.getDay()];
}

/** "AUG 31 · 2026" line pieces. */
export function dateLine(date: Date): { monthDay: string; year: string } {
  const month = date.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  return { monthDay: `${month} ${pad2(date.getDate())}`, year: String(date.getFullYear()) };
}

/**
 * Analog hand angles in degrees (0 = 12 o'clock, clockwise). The hour hand
 * advances with minutes AND seconds — it must never jump whole hours.
 */
export function handAngles(date: Date): { hour: number; minute: number; second: number } {
  const { hours, minutes, seconds } = {
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
  };
  return {
    hour: ((hours % 12) + minutes / 60 + seconds / 3600) * 30,
    minute: (minutes + seconds / 60) * 6,
    // Discrete second ticks (no sweep) — matches the pixel aesthetic and is
    // stable for tests.
    second: seconds * 6,
  };
}

// ---------------------------------------------------------------------------
// World clock zone math (all DST handling delegated to Intl).

export interface ZoneWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock calendar fields of `date` as seen in `timeZone` (DST-correct). */
export function zoneWallClock(date: Date, timeZone: string): ZoneWallClock {
  const parts = wallFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    return Number(part?.value ?? 0);
  };
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // en-US + hour12:false yields "24" at midnight in some engines; normalize.
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Zone offset in minutes east of UTC at the given instant (DST-correct). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const wall = zoneWallClock(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "YYYY-MM-DD" of the calendar day `date` falls on in `timeZone`. */
export function zoneDateKey(date: Date, timeZone: string): string {
  const wall = zoneWallClock(date, timeZone);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

function dateKeyToUtc(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Calendar-day distance (otherZone minus home zone): -1 Yesterday, 0 Today, … */
export function zoneDayDiff(date: Date, homeZone: string, otherZone: string): number {
  const homeKey = zoneDateKey(date, homeZone);
  const otherKey = zoneDateKey(date, otherZone);
  return Math.round((dateKeyToUtc(otherKey) - dateKeyToUtc(homeKey)) / 86_400_000);
}

/** "+1h" / "-7h" / "+5h30" compact offset difference (other minus home). */
export function formatOffsetDiff(diffMinutes: number): string {
  const sign = diffMinutes < 0 ? "-" : "+";
  const abs = Math.abs(diffMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0 ? `${sign}${hours}h` : `${sign}${hours}h${pad2(minutes)}`;
}

/** "19:26" wall time in a zone. */
export function formatZoneTime(date: Date, timeZone: string): string {
  const wall = zoneWallClock(date, timeZone);
  return `${pad2(wall.hour)}:${pad2(wall.minute)}`;
}

// ---------------------------------------------------------------------------
// Durations (task elapsed / countdown).

/** Compact human duration: "45s" / "24m" / "1h 24m" / "2d 3h". */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${pad2(minutes)}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Alarms. Detection happens in the browser while the app is open; all math is
// local wall-clock time.

export interface AlarmSchedule {
  time: string; // "HH:MM" 24h
  repeatDays: number[]; // 0 = SUN … 6 = SAT; empty = one-shot
  enabled: boolean;
}

export function parseAlarmTime(value: string): { hours: number; minutes: number } | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Next instant this alarm would fire, in local wall-clock time. One-shot
 * alarms (empty repeatDays) fire at the next occurrence of HH:MM on any day;
 * repeating alarms advance to the next matching weekday. Disabled → null.
 */
export function nextAlarmOccurrence(alarm: AlarmSchedule, now: Date): Date | null {
  if (!alarm.enabled) return null;
  const parsed = parseAlarmTime(alarm.time);
  if (!parsed) return null;
  const repeat = new Set(alarm.repeatDays);
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(parsed.hours, parsed.minutes, 0, 0);
    if (candidate.getTime() <= now.getTime()) continue;
    if (repeat.size === 0 || repeat.has(candidate.getDay())) return candidate;
  }
  return null;
}

/** "Once" / "Every day" / "MON TUE WED" summary for the alarm list. */
export function formatRepeatLabel(repeatDays: number[]): string {
  if (repeatDays.length === 0) return "Once";
  if (repeatDays.length === 7) return "Every day";
  return [...repeatDays]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_LABELS[day])
    .join(" ");
}
