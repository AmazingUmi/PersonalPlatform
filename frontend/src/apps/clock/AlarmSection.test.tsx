import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlarmSection, type AlarmView } from "./AlarmSection";

/**
 * Alarm firing orchestration (patch round 2): the in-app detector must fire
 * every alarm whose minute window is open — keyed by `<alarmId>:<occurrence>`
 * so two alarms at the same HH:MM each ring, a rerender inside the same
 * window never re-rings, a repeating alarm rings again on its next
 * occurrence, and a one-shot disables itself with exactly one PATCH.
 *
 * useClockNow ticks on a 1s setTimeout chain reading the (faked) system
 * clock, so advancing fake timers drives the detector exactly like a real
 * second passing. jsdom has no Notification — the in-app banner is the
 * observable surface.
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

let seq = 0;
function alarmView(overrides: Partial<AlarmView>): AlarmView {
  seq += 1;
  const iso = new Date(0).toISOString();
  return {
    id: `alarm-${seq}`,
    time: "07:30",
    label: "",
    enabled: true,
    repeatDays: [0, 1, 2, 3, 4, 5, 6],
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

/** Mutable alarm store + call recorder; GET/POST/PATCH behave like the real API. */
function stubAlarmApi(initial: AlarmView[]) {
  let alarms = initial.map((alarm) => ({ ...alarm }));
  const calls: { method: string; url: string; body: unknown }[] = [];
  const record = (url: string, method: string, init?: RequestInit): Record<string, unknown> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, url, body });
    return body;
  };
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/apps/clock/alarms" && method === "GET") {
      return jsonResponse({ items: alarms });
    }
    if (url === "/api/apps/clock/alarms" && method === "POST") {
      const body = record(url, method, init);
      const created = alarmView({ ...(body as Partial<AlarmView>) });
      alarms = [...alarms, created];
      return jsonResponse(created);
    }
    if (url.startsWith("/api/apps/clock/alarms/") && method === "PATCH") {
      const body = record(url, method, init) as { enabled?: boolean };
      const id = url.split("/").pop()!;
      alarms = alarms.map((alarm) =>
        alarm.id === id ? { ...alarm, ...body, enabled: body.enabled ?? alarm.enabled } : alarm,
      );
      return jsonResponse(alarms.find((alarm) => alarm.id === id)!);
    }
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    patchCount: () => calls.filter((call) => call.method === "PATCH").length,
  };
}

function ringingCount(): number {
  return screen.queryAllByRole("button", { name: "Dismiss" }).length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AlarmSection firing orchestration", () => {
  it("A+B: two alarms at the same HH:MM each fire exactly once; the next tick in the same window does not re-fire", async () => {
    stubAlarmApi([
      alarmView({ time: "07:30", label: "Alpha" }),
      alarmView({ time: "07:30", label: "Beta" }),
    ]);
    vi.setSystemTime(new Date(2026, 7, 31, 7, 30, 10, 0)); // 07:30:10

    render(<AlarmSection />);
    await act(async () => {});

    // "⏰ 07:30" exists only in ringing banners; the list rows show the bare
    // time, so this counts fires without colliding with the alarm list.
    expect(screen.getAllByText("⏰ 07:30")).toHaveLength(2);
    expect(ringingCount()).toBe(2);

    // 07:30:20 — same occurrence, rerendered by the second tick.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(ringingCount()).toBe(2) // no alarm rings twice for one occurrence;
  });

  it("C: a repeating alarm fires again on its next occurrence", async () => {
    stubAlarmApi([alarmView({ time: "07:30", label: "Daily", repeatDays: [0, 1, 2, 3, 4, 5, 6] })]);
    vi.setSystemTime(new Date(2026, 7, 31, 7, 30, 10, 0)); // Mon 07:30:10

    render(<AlarmSection />);
    await act(async () => {});
    expect(ringingCount()).toBe(1);

    // Leave the firing window entirely, then arrive at the next occurrence.
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(ringingCount()).toBe(1) // outside the 60s window nothing re-fires;

    vi.setSystemTime(new Date(2026, 8, 1, 7, 30, 10, 0)); // Tue 07:30:10
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(ringingCount()).toBe(2) // the next day's occurrence is a new fire;
  });

  it("D: a one-shot alarm fires once and PATCHes enabled=false exactly once", async () => {
    const api = stubAlarmApi([alarmView({ time: "07:30", label: "Once", repeatDays: [] })]);
    vi.setSystemTime(new Date(2026, 7, 31, 7, 30, 10, 0));

    render(<AlarmSection />);
    await act(async () => {});
    expect(ringingCount()).toBe(1);

    // The auto-disable PATCH round-trip (and the refetch it triggers).
    await act(async () => {});
    expect(api.patchCount()).toBe(1);
    expect(api.calls[0]!.body).toEqual({ enabled: false });

    // Even a next-day occurrence must not re-fire: the alarm is disabled now.
    vi.setSystemTime(new Date(2026, 8, 1, 7, 30, 10, 0));
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(ringingCount()).toBe(1) // a spent one-shot never fires again;
    expect(api.patchCount()).toBe(1) // no duplicate disable PATCH;
  });

  it("a disabled alarm never fires", async () => {
    stubAlarmApi([alarmView({ time: "07:30", label: "Muted", enabled: false })]);
    vi.setSystemTime(new Date(2026, 7, 31, 7, 30, 10, 0));

    render(<AlarmSection />);
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(ringingCount()).toBe(0);
  });

  it("creating with an empty label POSTs without the label field; editing sends null to clear", async () => {
    const existing = alarmView({ time: "08:00", label: "Old label" });
    const api = stubAlarmApi([existing]);
    vi.setSystemTime(new Date(2026, 7, 31, 12, 0, 0, 0)); // far from any alarm time

    render(<AlarmSection />);
    await act(async () => {});

    // Create: default (empty) label must be omitted — the POST schema takes a
    // non-nullable string; "" would also work, but omitting is the contract.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ Add Alarm" }));
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("alarm-editor"));
    });
    const post = api.calls.find((call) => call.method === "POST");
    expect(post).toBeDefined();
    // An empty label is omitted entirely on create, not sent as null or "".
    expect("label" in (post!.body as Record<string, unknown>)).toBe(false);
    expect(post!.body).toMatchObject({ time: "07:30" });

    // Edit: clearing the label field sends label: null (PATCH clear semantics).
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Alarm label"), { target: { value: "" } });
      fireEvent.submit(screen.getByTestId("alarm-editor"));
    });
    const patch = api.calls.find((call) => call.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.body).toMatchObject({ label: null });
  });
});
