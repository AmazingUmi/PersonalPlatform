import { describe, expect, it } from "vitest";
import {
  formatOffsetDiff,
  formatRepeatLabel,
  formatZoneTime,
  handAngles,
  humanDuration,
  nextAlarmOccurrence,
  parseAlarmTime,
  timeParts,
  weekdayLabel,
  zoneDateKey,
  zoneDayDiff,
  zoneOffsetMinutes,
} from "./timeMath";

/**
 * Pure clock math (worklist PHASE8 §8): 12/24 formatting, analog hand angles
 * (hour hand must track minutes), DST-correct zone offsets and day diffs,
 * alarm scheduling — all deterministic given a Date, no timers or network.
 */

describe("timeParts (12/24 formatting)", () => {
  it("formats midnight as 24h 00:00 and 12h 12 AM", () => {
    const parts = timeParts(new Date(2026, 7, 31, 0, 0, 0));
    expect(parts.hours24).toBe("00");
    expect(parts.hours12).toBe("12");
    expect(parts.meridiem).toBe("AM");
  });

  it("formats noon as 12 PM and 19:26 as 7:26 PM", () => {
    expect(timeParts(new Date(2026, 7, 31, 12, 0, 0)).meridiem).toBe("PM");
    const evening = timeParts(new Date(2026, 7, 31, 19, 26, 42));
    expect(evening.hours24).toBe("19");
    expect(evening.hours12).toBe("07");
    expect(evening.minutes).toBe("26");
    expect(evening.seconds).toBe("42");
    expect(evening.meridiem).toBe("PM");
  });
});

describe("weekdayLabel", () => {
  it("maps 2026-08-31 to MON", () => {
    expect(weekdayLabel(new Date(2026, 7, 31, 19, 26))).toBe("MON");
  });
});

describe("handAngles (analog)", () => {
  it("12:00:00 puts every hand at 0°", () => {
    const angles = handAngles(new Date(2026, 7, 31, 12, 0, 0));
    expect(angles.hour).toBe(0);
    expect(angles.minute).toBe(0);
    expect(angles.second).toBe(0);
  });

  it("3:00:00 is a 90° hour hand", () => {
    expect(handAngles(new Date(2026, 7, 31, 3, 0, 0)).hour).toBe(90);
    expect(handAngles(new Date(2026, 7, 31, 15, 0, 0)).hour).toBe(90);
  });

  it("the hour hand advances with minutes, not whole hours", () => {
    // 3:15 → (3 + 15/60) * 30 = 97.5° — never exactly 90°.
    expect(handAngles(new Date(2026, 7, 31, 3, 15, 0)).hour).toBe(97.5);
    // 6:30 → 195°.
    expect(handAngles(new Date(2026, 7, 31, 6, 30, 0)).hour).toBe(195);
  });

  it("the minute hand advances with seconds; the second hand ticks discretely", () => {
    expect(handAngles(new Date(2026, 7, 31, 12, 10, 30)).minute).toBe(63);
    expect(handAngles(new Date(2026, 7, 31, 12, 0, 15)).second).toBe(90);
  });
});

describe("world clock zone math (DST via Intl)", () => {
  // America/New_York: EST (UTC-5) in winter, EDT (UTC-4) after the March
  // DST transition — 2026-03-08 is the second Sunday of March.
  it("New York offset flips across the DST boundary", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
  });

  it("Shanghai has no DST and stays UTC+8", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "Asia/Shanghai")).toBe(480);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Shanghai")).toBe(480);
  });

  it("half-hour zones round-trip exactly (Asia/Kolkata +5:30)", () => {
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(formatOffsetDiff(330)).toBe("+5h30");
  });

  it("formatZoneTime renders wall-clock HH:MM in the zone", () => {
    expect(formatZoneTime(new Date("2026-08-31T11:26:00Z"), "Asia/Shanghai")).toBe("19:26");
    expect(formatZoneTime(new Date("2026-08-31T11:26:00Z"), "Asia/Tokyo")).toBe("20:26");
    expect(formatZoneTime(new Date("2026-08-31T11:26:00Z"), "Europe/London")).toBe("12:26");
  });

  it("day diff handles cross-midnight and DST-correct day keys", () => {
    // 23:30 in Shanghai is already the next calendar day in Tokyo.
    const lateEvening = new Date("2026-08-31T15:30:00Z"); // 23:30 Shanghai
    expect(zoneDayDiff(lateEvening, "Asia/Shanghai", "Asia/Tokyo")).toBe(1);
    expect(zoneDayDiff(lateEvening, "Asia/Shanghai", "Europe/London")).toBe(0);
    // Shanghai Sep 1 07:00 vs New York Aug 31 19:00 (EDT) → -1 day.
    const shanghaiMorning = new Date("2026-08-31T23:00:00Z");
    expect(zoneDayDiff(shanghaiMorning, "Asia/Shanghai", "America/New_York")).toBe(-1);
    expect(zoneDayDiff(shanghaiMorning, "Asia/Shanghai", "Asia/Tokyo")).toBe(0);
    expect(zoneDateKey(lateEvening, "Asia/Shanghai")).toBe("2026-08-31");
    expect(zoneDateKey(lateEvening, "Asia/Tokyo")).toBe("2026-09-01");
  });

  it("formatOffsetDiff renders compact signed labels", () => {
    expect(formatOffsetDiff(60)).toBe("+1h");
    expect(formatOffsetDiff(-420)).toBe("-7h");
    expect(formatOffsetDiff(0)).toBe("+0h");
  });
});

describe("humanDuration", () => {
  it("formats seconds, minutes, hours and days", () => {
    expect(humanDuration(45_000)).toBe("45s");
    expect(humanDuration(24 * 60_000)).toBe("24m");
    expect(humanDuration((1 * 3600 + 24 * 60) * 1000)).toBe("1h 24m");
    expect(humanDuration((2 * 86_400 + 3 * 3600) * 1000)).toBe("2d 3h");
    expect(humanDuration(-5000)).toBe("0s");
  });
});

describe("alarm scheduling", () => {
  it("parses HH:MM and rejects anything else", () => {
    expect(parseAlarmTime("07:30")).toEqual({ hours: 7, minutes: 30 });
    expect(parseAlarmTime("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(parseAlarmTime("24:00")).toBeNull();
    expect(parseAlarmTime("7:30")).toBeNull();
    expect(parseAlarmTime("0730")).toBeNull();
    expect(parseAlarmTime("07:60")).toBeNull();
  });

  const wednesday = new Date(2026, 7, 26, 10, 0, 0); // 2026-08-26 is a Wednesday

  it("one-shot alarm later today fires today", () => {
    const at = nextAlarmOccurrence({ time: "18:45", repeatDays: [], enabled: true }, wednesday);
    expect(at).toEqual(new Date(2026, 7, 26, 18, 45, 0));
  });

  it("one-shot alarm whose time passed fires tomorrow", () => {
    const at = nextAlarmOccurrence({ time: "06:15", repeatDays: [], enabled: true }, wednesday);
    expect(at).toEqual(new Date(2026, 7, 27, 6, 15, 0));
  });

  it("weekday repeat skips to the next matching weekday", () => {
    // MON(1)/FRI(5) alarm on a Wednesday morning → Friday 07:30.
    const at = nextAlarmOccurrence({ time: "07:30", repeatDays: [1, 5], enabled: true }, wednesday);
    expect(at).toEqual(new Date(2026, 7, 28, 7, 30, 0));
    expect(at!.getDay()).toBe(5);
  });

  it("an occurrence exactly at now is not in the future — the next one is returned", () => {
    const at = nextAlarmOccurrence({ time: "10:00", repeatDays: [], enabled: true }, wednesday);
    expect(at).toEqual(new Date(2026, 7, 27, 10, 0, 0));
  });

  it("disabled alarms never fire", () => {
    expect(nextAlarmOccurrence({ time: "07:30", repeatDays: [3], enabled: false }, wednesday)).toBeNull();
  });

  it("labels repeat sets", () => {
    expect(formatRepeatLabel([])).toBe("Once");
    expect(formatRepeatLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(formatRepeatLabel([5, 1, 2, 3, 4])).toBe("MON TUE WED THU FRI");
    expect(formatRepeatLabel([6, 0])).toBe("SUN SAT");
  });
});
