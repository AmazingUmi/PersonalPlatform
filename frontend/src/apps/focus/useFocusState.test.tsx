import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusState } from "./useFocusState";
import type { ActiveSessionView, FocusState } from "./api";

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

/** Minimal spyable stand-in for BroadcastChannel (jsdom has no cross-tab delivery anyway). */
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(_data: unknown): void {
    /* recorded via vi.spyOn */
  }
  close(): void {
    /* no-op */
  }
}

let visibility = "visible";
let originalVisibilityDescriptor: PropertyDescriptor | undefined;

function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(String(input), init?.method ?? "GET"),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stateGetCalls(fetchMock: ReturnType<typeof stubFetch>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url) === "/api/apps/focus/state").length;
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  MockBroadcastChannel.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { visibilityState?: string }).visibilityState;
  if (originalVisibilityDescriptor) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
  }
});

describe("useFocusState", () => {
  it("fetches GET /state once on mount and unwraps FocusState", async () => {
    const idle = focusState(null, { nextKind: "focus" });
    const fetchMock = stubFetch((url) =>
      url === "/api/apps/focus/state" ? jsonResponse(idle) : jsonResponse(null, false, 404),
    );

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.state).not.toBeNull();
    expect(result.current.state?.nextKind).toBe("focus");
    expect(result.current.state?.settings).toEqual(settingsFixture());
    expect(result.current.state?.today).toEqual({ focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 });
    expect(result.current.remainingSeconds).toBe(0);
    expect(stateGetCalls(fetchMock)).toBe(1);
  });

  it("dispatch(start) POSTs the kind, tracks busy, and swaps in the response state", async () => {
    const idle = focusState(null);
    const started = focusState(activeSession({ id: "s2", remainingSeconds: 1500 }));
    let resolveStart!: (value: Response) => void;
    const startResponse = new Promise<Response>((resolve) => {
      resolveStart = resolve;
    });

    const fetchMock = stubFetch((url, method) => {
      if (url === "/api/apps/focus/state") return jsonResponse(idle);
      if (url === "/api/apps/focus/start" && method === "POST") return startResponse;
      return jsonResponse(null, false, 404);
    });

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    expect(result.current.busy).toBe(false);
    let done!: Promise<void>;
    await act(async () => {
      done = result.current.dispatch("start", "focus");
    });

    // Busy is set while the mutation is in flight.
    expect(result.current.busy).toBe(true);

    await act(async () => {
      resolveStart(jsonResponse({ state: started }));
      await done;
    });

    const startCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/apps/focus/start" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(startCall).toBeDefined();
    expect(JSON.parse(String((startCall![1] as RequestInit).body))).toEqual({ kind: "focus" });
    expect(result.current.busy).toBe(false);
    expect(result.current.state?.active?.id).toBe("s2");
    expect(result.current.error).toBeNull();
  });

  it("self-heals from a 409 conflict body carrying details.state", async () => {
    const initial = focusState(activeSession({ id: "local", revision: 3 }));
    const authoritative = focusState(activeSession({ id: "server", revision: 7, remainingSeconds: 999 }));
    const conflictBody = {
      error: {
        code: "revision_conflict",
        message: "Session was modified concurrently",
        details: { state: authoritative },
      },
    };

    const fetchMock = stubFetch((url, method) => {
      if (url === "/api/apps/focus/state") return jsonResponse(initial);
      if (url === "/api/apps/focus/pause" && method === "POST") {
        return jsonResponse(conflictBody, false, 409);
      }
      return jsonResponse(null, false, 404);
    });

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    await act(async () => {
      await result.current.dispatch("pause");
    });

    expect(result.current.state?.active?.id).toBe("server");
    expect(result.current.state?.active?.revision).toBe(7);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    // Self-heal adopts the conflict state; no extra refetch is issued.
    expect(stateGetCalls(fetchMock)).toBe(1);
  });

  it("surfaces the message of a non-conflict mutation failure", async () => {
    const initial = focusState(activeSession());
    stubFetch((url, method) => {
      if (url === "/api/apps/focus/state") return jsonResponse(initial);
      if (url === "/api/apps/focus/stop" && method === "POST") {
        return jsonResponse({ error: { code: "internal", message: "Backend exploded" } }, false, 500);
      }
      return jsonResponse(null, false, 404);
    });

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    await act(async () => {
      await result.current.dispatch("stop");
    });

    expect(result.current.error).toBe("Backend exploded");
    expect(result.current.busy).toBe(false);
  });

  it("derives running remainingSeconds from expectedEndAt as the 1s tick advances", async () => {
    const running = focusState(
      activeSession({
        expectedEndAt: new Date(Date.now() + 10_000).toISOString(),
        remainingSeconds: 10,
      }),
    );
    stubFetch((url) => (url === "/api/apps/focus/state" ? jsonResponse(running) : jsonResponse(null, false, 404)));

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    expect(result.current.remainingSeconds).toBe(10);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.remainingSeconds).toBe(7);
    // Never accumulates below zero.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.remainingSeconds).toBe(0);
  });

  it("keeps paused remainingSeconds constant across ticks", async () => {
    const paused = focusState(
      activeSession({ status: "paused", expectedEndAt: null, pausedAt: new Date().toISOString(), remainingSeconds: 600 }),
    );
    stubFetch((url) => (url === "/api/apps/focus/state" ? jsonResponse(paused) : jsonResponse(null, false, 404)));

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    expect(result.current.remainingSeconds).toBe(600);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.remainingSeconds).toBe(600);
  });

  it("broadcasts { type: 'sync' } on the focus channel after a successful dispatch", async () => {
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    const running = focusState(activeSession());
    const stopped = focusState(null);
    const fetchMock = stubFetch((url, method) => {
      if (url === "/api/apps/focus/state") return jsonResponse(running);
      if (url === "/api/apps/focus/stop" && method === "POST") return jsonResponse({ state: stopped });
      return jsonResponse(null, false, 404);
    });

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});

    const channel = MockBroadcastChannel.instances[0]!;
    expect(channel.name).toBe("focus");
    const postSpy = vi.spyOn(channel, "postMessage");

    await act(async () => {
      await result.current.dispatch("stop");
    });

    expect(postSpy).toHaveBeenCalledWith({ type: "sync" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/apps/focus/stop")).toHaveLength(1);
  });

  it("silently refetches /state when another tab posts a channel message", async () => {
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    const first = focusState(activeSession({ id: "s1" }));
    const second = focusState(activeSession({ id: "s2" }));
    const queue = [first, second];
    const fetchMock = stubFetch((url) =>
      url === "/api/apps/focus/state" ? jsonResponse(queue.length > 1 ? queue.shift()! : queue[0]) : jsonResponse(null, false, 404),
    );

    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    expect(result.current.state?.active?.id).toBe("s1");
    expect(stateGetCalls(fetchMock)).toBe(1);

    const channel = MockBroadcastChannel.instances[0]!;
    await act(async () => {
      channel.onmessage?.({ data: { type: "sync" } });
    });

    expect(stateGetCalls(fetchMock)).toBe(2);
    expect(result.current.state?.active?.id).toBe("s2");
  });

  it("refetches on visibilitychange back to visible but not on hidden", async () => {
    const state = focusState(activeSession());
    const fetchMock = stubFetch((url) =>
      url === "/api/apps/focus/state" ? jsonResponse(state) : jsonResponse(null, false, 404),
    );

    renderHook(() => useFocusState());
    await act(async () => {});
    expect(stateGetCalls(fetchMock)).toBe(1);

    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stateGetCalls(fetchMock)).toBe(1);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stateGetCalls(fetchMock)).toBe(2);
  });

  it("stops ticking, polling and listening after unmount", async () => {
    const state = focusState(activeSession());
    const fetchMock = stubFetch((url) =>
      url === "/api/apps/focus/state" ? jsonResponse(state) : jsonResponse(null, false, 404),
    );

    const { unmount } = renderHook(() => useFocusState());
    await act(async () => {});
    expect(stateGetCalls(fetchMock)).toBe(1);

    unmount();
    visibility = "visible";
    await act(async () => {
      // Well past both the 1s tick and the 15s poll interval.
      vi.advanceTimersByTime(60_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(stateGetCalls(fetchMock)).toBe(1);
  });
});
