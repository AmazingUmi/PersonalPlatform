import { I18nProvider, useI18n } from "../../shared/i18n";
vi.mock("../../shell/AuthContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell/AuthContext")>();
  const value = { user: { id: "focus-test-user" } };
  return { ...actual, useAuth: () => value, useOptionalAuth: () => value };
});
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusPage } from "./FocusPage";
import type { ActiveSessionView, FocusHistoryItem, FocusState } from "./api";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function settingsFixture() {
  return {
    focusDurationSeconds: 1500,
    shortBreakDurationSeconds: 300,
    longBreakDurationSeconds: 900,
    longBreakInterval: 4,
  };
}

function activeSession(overrides: Partial<ActiveSessionView> = {}): ActiveSessionView {
  return {
    id: "s1",
    kind: "focus",
    status: "running",
    plannedDurationSeconds: 1500,
    elapsedSeconds: 0,
    remainingSeconds: 1500,
    expectedEndAt: null,
    startedAt: new Date().toISOString(),
    pausedAt: null,
    revision: 1,
    ...overrides,
  };
}

function focusState(active: ActiveSessionView | null = null, overrides: Partial<FocusState> = {}): FocusState {
  return {
    now: new Date().toISOString(),
    active,
    today: { focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 },
    nextKind: "focus",
    settings: settingsFixture(),
    ...overrides,
  };
}

const statsFixture = {
  timezone: "UTC",
  days: [
    { date: "2026-08-24", focusedSeconds: 1500, completedRounds: 1 },
    { date: "2026-08-25", focusedSeconds: 3000, completedRounds: 2 },
    { date: "2026-08-26", focusedSeconds: 0, completedRounds: 0 },
    { date: "2026-08-27", focusedSeconds: 4500, completedRounds: 3 },
    { date: "2026-08-28", focusedSeconds: 600, completedRounds: 0 },
    { date: "2026-08-29", focusedSeconds: 1800, completedRounds: 1 },
    { date: "2026-08-30", focusedSeconds: 900, completedRounds: 1 },
  ],
  totals: { focusedSeconds: 12300, completedRounds: 8 },
};

const historyItem: FocusHistoryItem = {
  id: "h1",
  kind: "short_break",
  status: "completed",
  plannedDurationSeconds: 300,
  actualDurationSeconds: 300,
  startedAt: "2026-08-30T09:00:00.000Z",
  endedAt: "2026-08-30T09:05:00.000Z",
  endReason: "natural",
};

/** Routes every endpoint FocusPage touches; state GETs return `state`. */
function setupFetch(state: FocusState) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/apps/focus/state") return jsonResponse(state);
    if (url === "/api/apps/focus/start" && method === "POST") {
      return jsonResponse({ state: focusState(activeSession()) });
    }
    if (url === "/api/apps/focus/settings" && method === "PUT") {
      return jsonResponse({ ...state.settings, ...JSON.parse(String(init?.body ?? "{}")) });
    }
    if (url.startsWith("/api/apps/focus/stats")) return jsonResponse(statsFixture);
    if (url.startsWith("/api/apps/focus/sessions")) {
      return jsonResponse({ items: [historyItem], total: 1 });
    }
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(<FocusPage />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FocusPage", () => {
  it("renders the idle timer: READY badge, next-session length and START", async () => {
    setupFetch(focusState(null));
    renderPage();

    expect(await screen.findByText("25:00")).toBeDefined();
    expect(screen.getByText("READY")).toBeDefined();
    expect(screen.getByRole("button", { name: "START" })).toBeDefined();
    expect(screen.getByText(/next: focus/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: "STOP" })).toBeNull();
  });

  it("renders the running timer from remainingSeconds with PAUSE and STOP", async () => {
    // +0.9s sub-second buffer: remainingSeconds floors (expectedEndAt - now),
    // so without it the fetch/render milliseconds already show "10:14".
    const running = focusState(
      activeSession({
        expectedEndAt: new Date(Date.now() + 615_900).toISOString(),
        remainingSeconds: 615,
      }),
    );
    setupFetch(running);
    renderPage();

    expect(await screen.findByText("10:15")).toBeDefined();
    expect(screen.getByText("FOCUSING")).toBeDefined();
    expect(screen.getByRole("button", { name: "PAUSE" })).toBeDefined();
    expect(screen.getByRole("button", { name: "STOP" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "START" })).toBeNull();
  });

  it("renders the paused timer with RESUME and STOP", async () => {
    const paused = focusState(
      activeSession({
        status: "paused",
        expectedEndAt: null,
        pausedAt: new Date().toISOString(),
        remainingSeconds: 600,
      }),
    );
    setupFetch(paused);
    renderPage();

    expect(await screen.findByText("10:00")).toBeDefined();
    expect(screen.getByText("PAUSED")).toBeDefined();
    expect(screen.getByRole("button", { name: "RESUME" })).toBeDefined();
    expect(screen.getByRole("button", { name: "STOP" })).toBeDefined();
  });

  it("POSTs /start with the next kind when START is clicked", async () => {
    const fetchMock = setupFetch(focusState(null));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "START" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === "/api/apps/focus/start" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ kind: "focus" });
    });
  });

  it("maps today's summary into the three stat blocks", async () => {
    setupFetch(focusState(null, { today: { focusedSeconds: 8100, completedRounds: 3, sessionsEnded: 5 } }));
    renderPage();

    expect(await screen.findByText("Focused", { selector: ".px-stat__label" })).toBeDefined();
    expect(screen.getByText("2h 15m", { selector: ".px-stat__value" })).toBeDefined();
    expect(screen.getByText("3", { selector: ".px-stat__value" })).toBeDefined();
    expect(screen.getByText("5", { selector: ".px-stat__value" })).toBeDefined();
  });

  it("renders the 7-day chart and session rows", async () => {
    setupFetch(focusState(null));
    const { container } = renderPage();

    expect(await screen.findByText("Short Break", { selector: ".px-badge" })).toBeDefined();
    expect(screen.getByText("Completed", { selector: ".px-badge" })).toBeDefined();
    expect(screen.getByText("05:00 → 05:00", { selector: ".focus-history__durations" })).toBeDefined();
    expect(container.querySelectorAll(".focus-stats__col")).toHaveLength(7);
    expect(screen.getByText("08-27", { selector: ".focus-stats__label" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("PUTs /settings with minute fields converted to seconds", async () => {
    const fetchMock = setupFetch(focusState(null));
    renderPage();

    await screen.findByText("25:00");
    fireEvent.change(screen.getByLabelText("Focus minutes"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === "/api/apps/focus/settings" && (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        focusDurationSeconds: 1800,
        shortBreakDurationSeconds: 300,
        longBreakDurationSeconds: 900,
        longBreakInterval: 4,
      });
    });
    expect(await screen.findByText("Settings saved")).toBeDefined();
  });

  it("keeps dirty settings after a 409 fence and adopts hash after an accepted save", async () => {
    const HASH_A = "a".repeat(64);
    const HASH_B = "b".repeat(64);
    let settings = { ...settingsFixture(), baseHash: HASH_A };
    let putConflict = true;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/apps/focus/state") return jsonResponse(focusState(null, { settings }));
      if (url === "/api/apps/focus/settings" && method === "PUT") {
        if (putConflict) return jsonResponse({ error: { code: "sync_stale", message: "stale" } }, false, 409);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        settings = { ...settings, ...body, baseHash: HASH_B };
        return jsonResponse(settings);
      }
      if (url.startsWith("/api/apps/focus/stats")) return jsonResponse(statsFixture);
      if (url.startsWith("/api/apps/focus/sessions")) return jsonResponse({ items: [historyItem], total: 1 });
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await screen.findByText("25:00");
    fireEvent.change(screen.getByLabelText("Focus minutes"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    expect(screen.getByLabelText("Focus minutes")).toHaveValue(30);
    putConflict = false;
    settings = { ...settingsFixture(), focusDurationSeconds: 1200, baseHash: HASH_B };
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Focus minutes")).toHaveValue(20));
    expect(screen.queryByRole("button", { name: "Discard draft and reload" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Focus minutes"), { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/apps/focus/settings" && (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(JSON.parse(String((puts[puts.length - 1]![1] as RequestInit).body))).toMatchObject({
        focusDurationSeconds: 2100,
        baseHash: HASH_B,
      });
    });
    expect(await screen.findByText("Settings saved")).toBeDefined();
  });
});

function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <button onClick={() => setLanguage(language === "en" ? "zh" : "en")}>Switch language</button>;
}

it("switches a paused timer, history, settings and alert statuses without resetting the timer or draft", async () => {
  const fetchMock = setupFetch(focusState(activeSession({ status: "paused", remainingSeconds: 1200 }), { today: { focusedSeconds: 300, completedRounds: 1, sessionsEnded: 1 } }));
  render(<I18nProvider initialLanguage="en"><LanguageSwitch /><FocusPage /></I18nProvider>);
  const minutes = await screen.findByRole("spinbutton", { name: "Focus minutes" });
  fireEvent.change(minutes, { target: { value: "42" } });
  expect(screen.getByRole("timer")).toHaveTextContent("20:00");
  expect(await screen.findByText("Short Break")).toBeVisible();
  const requests = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByRole("timer", { name: "剩余时间" })).toHaveTextContent("20:00");
  expect(screen.getByRole("spinbutton", { name: "专注时长（分钟）" })).toHaveValue(42);
  expect(screen.getByRole("button", { name: "继续" })).toBeVisible();
  expect(screen.getByText(/声音已关闭/)).toBeVisible();
  expect(screen.getByText("短休息")).toBeVisible();
  expect(screen.getAllByText("5分").length).toBeGreaterThan(0);
  expect(fetchMock.mock.calls.length).toBe(requests);
  expect(screen.queryByText("番茄计时、每日统计与历史记录")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "帮助：关于专注" }));
  expect(screen.getByText("番茄计时、每日统计与历史记录")).toBeVisible();
});
