import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SETTINGS,
  TimerStateError,
  applyNaturalComplete,
  applyPause,
  applyResume,
  applyStop,
  elapsedSeconds,
  expectedEndAt,
  formatDuration,
  isExpired,
  localDateString,
  nextKind,
  remainingSeconds,
  sanitizeSettings,
  toSessionView,
} from "../../src/apps/focus/timer.js";
import type { SessionRow } from "../../src/apps/focus/timer.js";

// Fixed clock: every test injects `now` as a literal offset from START.
const START = new Date("2026-08-30T08:00:00Z");
const MIN = 60;

/** Instant `seconds` after START, plus optional sub-second milliseconds. */
function at(seconds: number, extraMs = 0): Date {
  return new Date(START.getTime() + seconds * 1000 + extraMs);
}

/** Fresh 25-minute focus session, running since START (revision 0). */
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    kind: "focus",
    status: "running",
    plannedDurationSeconds: 25 * MIN,
    elapsedBeforePauseSeconds: 0,
    startedAt: START,
    lastResumedAt: START,
    pausedAt: null,
    endedAt: null,
    endReason: null,
    actualDurationSeconds: null,
    revision: 0,
    ...overrides,
  };
}

describe("elapsedSeconds (APP-1 F02)", () => {
  it("accumulates floor((now - lastResumedAt)/1000) on top of prior segments", () => {
    const row = makeRow({ elapsedBeforePauseSeconds: 300, lastResumedAt: at(600) });
    assert.equal(elapsedSeconds(row, at(600 + 240)), 540);
    assert.equal(elapsedSeconds(row, at(600 + 900)), 1200);
  });

  it("floors sub-second progress: 1500ms counts as 1s, 499ms as 0s", () => {
    const row = makeRow();
    assert.equal(elapsedSeconds(row, at(0, 1500)), 1);
    assert.equal(elapsedSeconds(row, at(0, 1000)), 1);
    assert.equal(elapsedSeconds(row, at(0, 999)), 0);
    assert.equal(elapsedSeconds(row, at(0, 499)), 0);
  });

  it("is frozen at elapsedBeforePauseSeconds while paused", () => {
    const row = makeRow({
      status: "paused",
      elapsedBeforePauseSeconds: 420,
      lastResumedAt: null,
      pausedAt: at(420),
    });
    assert.equal(elapsedSeconds(row, at(420 + 600)), 420);
    assert.equal(elapsedSeconds(row, at(10_000)), 420);
  });

  it("clamps to plannedDurationSeconds when the wall clock runs past the end", () => {
    const row = makeRow();
    assert.equal(elapsedSeconds(row, at(25 * MIN)), 1500, "exactly full at the end instant");
    assert.equal(elapsedSeconds(row, at(200 * MIN)), 1500, "capped far past the end");
  });

  it("clamps to 0 when now precedes lastResumedAt (defensive clock skew)", () => {
    const row = makeRow({ lastResumedAt: at(600) });
    assert.equal(elapsedSeconds(row, at(60)), 0);
  });

  it("reads actualDurationSeconds for terminal states, 0 when null (defensive)", () => {
    assert.equal(
      elapsedSeconds(
        makeRow({ status: "completed", lastResumedAt: null, actualDurationSeconds: 1500 }),
        at(9999),
      ),
      1500,
    );
    assert.equal(
      elapsedSeconds(
        makeRow({
          status: "cancelled",
          lastResumedAt: null,
          endReason: "manual_stop",
          actualDurationSeconds: 123,
        }),
        at(9999),
      ),
      123,
    );
    assert.equal(
      elapsedSeconds(makeRow({ status: "cancelled", lastResumedAt: null, actualDurationSeconds: null }), at(9999)),
      0,
    );
  });
});

describe("remainingSeconds (APP-1 F02)", () => {
  it("running: planned - elapsed", () => {
    assert.equal(remainingSeconds(makeRow(), at(600)), 900);
    assert.equal(remainingSeconds(makeRow({ elapsedBeforePauseSeconds: 300 }), at(300)), 900);
  });

  it("running past the end clamps to 0", () => {
    assert.equal(remainingSeconds(makeRow(), at(25 * MIN)), 0);
    assert.equal(remainingSeconds(makeRow(), at(25 * MIN + 3600)), 0);
  });

  it("paused: planned - elapsedBeforePauseSeconds", () => {
    const row = makeRow({
      status: "paused",
      elapsedBeforePauseSeconds: 480,
      lastResumedAt: null,
      pausedAt: at(480),
    });
    assert.equal(remainingSeconds(row, at(480 + 120)), 1020);
  });

  it("terminal: 0", () => {
    assert.equal(
      remainingSeconds(
        makeRow({ status: "completed", lastResumedAt: null, actualDurationSeconds: 1500 }),
        at(9999),
      ),
      0,
    );
  });
});

describe("expectedEndAt (APP-1 F02)", () => {
  it("running: lastResumedAt + (planned - elapsedBeforePause) exactly", () => {
    const row = makeRow({ elapsedBeforePauseSeconds: 300, lastResumedAt: at(600) });
    assert.equal(expectedEndAt(row)?.toISOString(), at(600 + 1200).toISOString());
    assert.equal(expectedEndAt(makeRow())?.toISOString(), at(1500).toISOString());
  });

  it("paused and terminal rows have no expected end", () => {
    assert.equal(
      expectedEndAt(makeRow({ status: "paused", elapsedBeforePauseSeconds: 60, lastResumedAt: null })),
      null,
    );
    assert.equal(expectedEndAt(makeRow({ status: "completed", lastResumedAt: null })), null);
  });
});

describe("isExpired (APP-1 F02)", () => {
  it("is false before the end, true AT and after the exact end instant", () => {
    const row = makeRow(); // expected end at 08:25:00Z
    assert.equal(isExpired(row, at(1499)), false);
    assert.equal(isExpired(row, at(1500)), true, "expiry is inclusive (>=)");
    assert.equal(isExpired(row, at(1500 + 2 * 3600)), true);
  });

  it("paused sessions never expire on their own", () => {
    const row = makeRow({
      status: "paused",
      elapsedBeforePauseSeconds: 1499,
      lastResumedAt: null,
      pausedAt: at(1499),
    });
    assert.equal(isExpired(row, at(999_999)), false);
  });
});

describe("applyPause (APP-1 F02)", () => {
  it("folds the running segment, freezes it and bumps revision", () => {
    const row = applyPause(makeRow(), at(600));
    assert.equal(row.status, "paused");
    assert.equal(row.elapsedBeforePauseSeconds, 600);
    assert.equal(row.lastResumedAt, null);
    assert.equal(row.pausedAt?.toISOString(), at(600).toISOString());
    assert.equal(row.endedAt, null);
    assert.equal(row.endReason, null);
    assert.equal(row.actualDurationSeconds, null);
    assert.equal(row.revision, 1);
  });

  it("floors the folded segment: +1500ms → +1s, +499ms → +0s", () => {
    assert.equal(applyPause(makeRow(), at(0, 1500)).elapsedBeforePauseSeconds, 1);
    assert.equal(applyPause(makeRow(), at(0, 1000)).elapsedBeforePauseSeconds, 1);
    assert.equal(applyPause(makeRow(), at(0, 999)).elapsedBeforePauseSeconds, 0);
    assert.equal(applyPause(makeRow(), at(0, 499)).elapsedBeforePauseSeconds, 0);
  });

  it("clamps the folded total to plannedDurationSeconds", () => {
    const row = makeRow({ elapsedBeforePauseSeconds: 1400, lastResumedAt: at(1000) });
    assert.equal(applyPause(row, at(1200)).elapsedBeforePauseSeconds, 1500); // 1400 + 200 → clamp
  });

  it("rejects a non-running row", () => {
    assert.throws(
      () => applyPause(makeRow({ status: "paused", lastResumedAt: null, pausedAt: at(60) }), at(120)),
      TimerStateError,
    );
  });
});

describe("applyResume (APP-1 F02)", () => {
  it("restarts accrual at now while keeping pausedAt and prior elapsed", () => {
    const paused = applyPause(makeRow(), at(480));
    const row = applyResume(paused, at(900));
    assert.equal(row.status, "running");
    assert.equal(row.lastResumedAt?.toISOString(), at(900).toISOString());
    assert.equal(row.pausedAt?.toISOString(), at(480).toISOString(), "pausedAt is preserved");
    assert.equal(row.elapsedBeforePauseSeconds, 480);
    assert.equal(row.revision, 2);
    assert.equal(elapsedSeconds(row, at(900 + 120)), 600);
  });

  it("rejects a non-paused row", () => {
    assert.throws(() => applyResume(makeRow(), at(60)), TimerStateError);
  });
});

describe("applyStop (APP-1 F02)", () => {
  it("from running: actual equals the elapsed total at stop time", () => {
    const now = at(600, 500); // 600.5s in → floor 600
    const row = applyStop(makeRow(), now);
    assert.equal(row.status, "cancelled");
    assert.equal(row.endReason, "manual_stop");
    assert.equal(row.actualDurationSeconds, 600);
    assert.equal(row.endedAt?.toISOString(), now.toISOString());
    assert.equal(row.revision, 1);
  });

  it("from paused: actual equals elapsedBeforePauseSeconds", () => {
    const paused = applyPause(makeRow(), at(480));
    const row = applyStop(paused, at(480 + 3600));
    assert.equal(row.actualDurationSeconds, 480);
    assert.equal(row.endedAt?.toISOString(), at(480 + 3600).toISOString());
    assert.equal(row.revision, 2);
  });

  it("clamps actual to planned when stopping long after expiry", () => {
    const row = applyStop(makeRow(), at(2000));
    assert.equal(row.actualDurationSeconds, 1500);
    assert.equal(row.status, "cancelled", "a late manual stop is still a stop, not a completion");
  });

  it("rejects terminal rows", () => {
    assert.throws(
      () =>
        applyStop(
          makeRow({ status: "completed", lastResumedAt: null, endedAt: at(1500), endReason: "natural", actualDurationSeconds: 1500 }),
          at(1600),
        ),
      TimerStateError,
    );
  });
});

describe("applyNaturalComplete (APP-1 F02)", () => {
  it("ends at expectedEndAt, not at the late now that noticed the expiry", () => {
    const row = makeRow(); // expected end 08:25:00Z
    const late = at(1500 + 2 * 3600); // expiry noticed two hours later
    const done = applyNaturalComplete(row, late);
    assert.equal(done.status, "completed");
    assert.equal(done.endReason, "natural");
    assert.equal(done.endedAt?.toISOString(), at(1500).toISOString());
    assert.notEqual(done.endedAt?.toISOString(), late.toISOString());
    assert.equal(done.elapsedBeforePauseSeconds, 1500);
    assert.equal(done.actualDurationSeconds, 1500);
    assert.equal(done.lastResumedAt, null);
    assert.equal(done.revision, 1);
  });

  it("rejects a running session that has not expired yet", () => {
    assert.throws(() => applyNaturalComplete(makeRow(), at(1499)), TimerStateError);
  });

  it("rejects paused sessions even long after their would-be end", () => {
    const paused = applyPause(makeRow({ elapsedBeforePauseSeconds: 1400 }), at(1400));
    assert.throws(() => applyNaturalComplete(paused, at(999_999)), TimerStateError);
  });
});

describe("pause/resume saga: three rounds, hand-computed (APP-1 F02)", () => {
  it("keeps elapsed/remaining continuous across three pause/resume rounds", () => {
    // Plan: 25 min focus starting 08:00:00Z.
    let row = makeRow();
    assert.equal(row.revision, 0);

    // Round 1: run 10 min → pause, sit paused 5 min.
    row = applyPause(row, at(10 * MIN));
    assert.equal(row.status, "paused");
    assert.equal(row.elapsedBeforePauseSeconds, 600);
    assert.equal(row.revision, 1);
    assert.equal(elapsedSeconds(row, at(12 * MIN)), 600, "frozen while paused");
    assert.equal(remainingSeconds(row, at(12 * MIN)), 900);

    row = applyResume(row, at(15 * MIN));
    assert.equal(row.revision, 2);
    assert.equal(elapsedSeconds(row, at(20 * MIN)), 900, "600 + 300");
    assert.equal(remainingSeconds(row, at(20 * MIN)), 600);

    // Round 2: run 8 min → pause 2 min.
    row = applyPause(row, at(23 * MIN));
    assert.equal(row.elapsedBeforePauseSeconds, 1080, "600 + 480");
    assert.equal(row.revision, 3);
    row = applyResume(row, at(25 * MIN));
    assert.equal(row.revision, 4);
    assert.equal(elapsedSeconds(row, at(28 * MIN)), 1260, "1080 + 180");
    assert.equal(remainingSeconds(row, at(28 * MIN)), 240);

    // Round 3: run 5 min → pause 5 min → resume for the final stretch.
    row = applyPause(row, at(30 * MIN));
    assert.equal(row.elapsedBeforePauseSeconds, 1380, "1080 + 300");
    assert.equal(row.revision, 5);
    assert.equal(remainingSeconds(row, at(34 * MIN)), 120, "frozen remaining while paused");
    row = applyResume(row, at(35 * MIN));
    assert.equal(row.revision, 6);
    assert.equal(row.pausedAt?.toISOString(), at(30 * MIN).toISOString(), "pausedAt survives resume");
    assert.equal(expectedEndAt(row)?.toISOString(), at(37 * MIN).toISOString(), "08:35 + 120s left");

    assert.equal(elapsedSeconds(row, at(36 * MIN)), 1440, "1380 + 60");
    assert.equal(remainingSeconds(row, at(36 * MIN)), 60);
    assert.equal(isExpired(row, at(36 * MIN)), false);
    assert.equal(elapsedSeconds(row, at(37 * MIN)), 1500, "exactly full at the end instant");
    assert.equal(remainingSeconds(row, at(37 * MIN)), 0);
    assert.equal(isExpired(row, at(37 * MIN)), true, "expiry is inclusive");

    const done = applyNaturalComplete(row, at(37 * MIN + 2 * 60 * MIN));
    assert.equal(done.status, "completed");
    assert.equal(done.endedAt?.toISOString(), at(37 * MIN).toISOString());
    assert.equal(done.actualDurationSeconds, 1500);
    assert.equal(done.revision, 7, "revision bumped on every transition: 0 → 7");
  });
});

describe("transition purity (APP-1 F02)", () => {
  it("transitions never mutate the input row", () => {
    const running = makeRow();
    const snapshotRunning: SessionRow = { ...running };
    applyPause(running, at(600));
    assert.deepEqual(running, snapshotRunning);

    const paused = applyPause(makeRow(), at(480));
    const snapshotPaused: SessionRow = { ...paused };
    applyResume(paused, at(600));
    applyStop(paused, at(700));
    assert.deepEqual(paused, snapshotPaused);

    const expired = makeRow();
    const snapshotExpired: SessionRow = { ...expired };
    applyNaturalComplete(expired, at(1500 + 3600));
    assert.deepEqual(expired, snapshotExpired);
  });
});

describe("nextKind (APP-1 F02)", () => {
  it("interval 4: 0→focus, 1..3→short_break, >=4→long_break", () => {
    assert.equal(nextKind(0, 4), "focus");
    assert.equal(nextKind(1, 4), "short_break");
    assert.equal(nextKind(2, 4), "short_break");
    assert.equal(nextKind(3, 4), "short_break");
    assert.equal(nextKind(4, 4), "long_break");
    assert.equal(nextKind(5, 4), "long_break");
  });

  it("interval 2: 0→focus, 1→short_break, >=2→long_break", () => {
    assert.equal(nextKind(0, 2), "focus");
    assert.equal(nextKind(1, 2), "short_break");
    assert.equal(nextKind(2, 2), "long_break");
    assert.equal(nextKind(3, 2), "long_break");
  });
});

describe("formatDuration (APP-1 F02)", () => {
  it("formats mm:ss with two-digit minutes under an hour", () => {
    assert.equal(formatDuration(0), "00:00");
    assert.equal(formatDuration(59), "00:59");
    assert.equal(formatDuration(60), "01:00");
    assert.equal(formatDuration(1500), "25:00");
    assert.equal(formatDuration(3599), "59:59");
  });

  it("formats h:mm:ss from one hour up", () => {
    assert.equal(formatDuration(3600), "1:00:00");
    assert.equal(formatDuration(3661), "1:01:01");
    assert.equal(formatDuration(7325), "2:02:05");
  });
});

describe("localDateString (APP-1 F02)", () => {
  it("buckets by the platform timezone's calendar day", () => {
    const instant = new Date("2026-08-30T22:30:00Z");
    // 22:30Z is already 06:30 next day in Shanghai (UTC+8)…
    assert.equal(localDateString(instant, "Asia/Shanghai"), "2026-08-31");
    // …but still 18:30 the same day in New York (EDT, UTC-4).
    assert.equal(localDateString(instant, "America/New_York"), "2026-08-30");
    assert.equal(localDateString(new Date("2026-08-30T00:00:00Z"), "UTC"), "2026-08-30");
  });

  it("throws RangeError for a non-IANA timezone", () => {
    assert.throws(() => localDateString(new Date(), "UTC+8"), RangeError);
  });
});

describe("sanitizeSettings (APP-1 F02)", () => {
  it("accepts the shipped defaults", () => {
    assert.deepEqual(sanitizeSettings(DEFAULT_SETTINGS), {
      focusDurationSeconds: 1500,
      shortBreakDurationSeconds: 300,
      longBreakDurationSeconds: 900,
      longBreakInterval: 4,
    });
  });

  it("accepts the boundary values (1, 86400, interval 2 and 10)", () => {
    assert.deepEqual(
      sanitizeSettings({
        focusDurationSeconds: 1,
        shortBreakDurationSeconds: 86_400,
        longBreakDurationSeconds: 86_400,
        longBreakInterval: 2,
      }),
      { focusDurationSeconds: 1, shortBreakDurationSeconds: 86_400, longBreakDurationSeconds: 86_400, longBreakInterval: 2 },
    );
    assert.deepEqual(sanitizeSettings({ ...DEFAULT_SETTINGS, longBreakInterval: 10 }), {
      ...DEFAULT_SETTINGS,
      longBreakInterval: 10,
    });
  });

  it("rejects out-of-bounds values (0, 86401, interval 1 and 11)", () => {
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, focusDurationSeconds: 0 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, focusDurationSeconds: 86_401 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, shortBreakDurationSeconds: 0 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, longBreakDurationSeconds: 86_401 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, longBreakInterval: 1 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, longBreakInterval: 11 }), null);
  });

  it("rejects missing fields", () => {
    const missing: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    delete missing.focusDurationSeconds;
    assert.equal(sanitizeSettings(missing), null);
    const missingInterval: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    delete missingInterval.longBreakInterval;
    assert.equal(sanitizeSettings(missingInterval), null);
  });

  it("rejects non-integers and non-number types", () => {
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, focusDurationSeconds: 1500.5 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, longBreakInterval: 2.5 }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, focusDurationSeconds: Number.NaN }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, focusDurationSeconds: "1500" }), null);
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, focusDurationSeconds: true }), null);
    assert.equal(sanitizeSettings(null), null);
    assert.equal(sanitizeSettings("nope"), null);
    assert.equal(sanitizeSettings([1500, 300, 900, 4]), null);
  });

  it("strips unknown extra fields", () => {
    const padded = { ...DEFAULT_SETTINGS, extra: "x", focusDurationSeconds: 1800 };
    assert.deepEqual(sanitizeSettings(padded), { ...DEFAULT_SETTINGS, focusDurationSeconds: 1800 });
  });
});

describe("toSessionView (APP-1 F02)", () => {
  it("maps a running row with derived timing", () => {
    const view = toSessionView(makeRow(), at(600));
    assert.deepEqual(view, {
      id: "sess-1",
      kind: "focus",
      status: "running",
      plannedDurationSeconds: 1500,
      elapsedSeconds: 600,
      remainingSeconds: 900,
      expectedEndAt: "2026-08-30T08:25:00.000Z",
      startedAt: "2026-08-30T08:00:00.000Z",
      pausedAt: null,
      revision: 0,
    });
    // Past the end the view still exposes the (now capped) derived totals.
    const late = toSessionView(makeRow(), at(1500 + 60));
    assert.equal(late.elapsedSeconds, 1500);
    assert.equal(late.remainingSeconds, 0);
    assert.equal(late.expectedEndAt, "2026-08-30T08:25:00.000Z");
  });

  it("maps a paused row: expectedEndAt null, pausedAt as ISO", () => {
    const paused = applyPause(makeRow(), at(600));
    const view = toSessionView(paused, at(600 + 300));
    assert.deepEqual(view, {
      id: "sess-1",
      kind: "focus",
      status: "paused",
      plannedDurationSeconds: 1500,
      elapsedSeconds: 600,
      remainingSeconds: 900,
      expectedEndAt: null,
      startedAt: "2026-08-30T08:00:00.000Z",
      pausedAt: "2026-08-30T08:10:00.000Z",
      revision: 1,
    });
  });

  it("rejects terminal rows (history is not live state)", () => {
    assert.throws(
      () =>
        toSessionView(
          makeRow({ status: "cancelled", lastResumedAt: null, endedAt: at(600), endReason: "manual_stop", actualDurationSeconds: 600 }),
          at(700),
        ),
      TimerStateError,
    );
  });
});
