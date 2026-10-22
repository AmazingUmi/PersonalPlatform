import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusState } from "./useFocusState";
import type { ActiveSessionView, FocusState } from "./api";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function failure(message: string, status = 500, state?: FocusState): Response {
  return jsonResponse({ error: { code: "test_failure", message, details: state ? { state } : undefined } }, false, status);
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
  vi.restoreAllMocks();
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
    // Polling samples the advancing simulated server clock instead of
    // replaying the initial timestamp and resetting the display anchor.
    stubFetch((url) => (url === "/api/apps/focus/state"
      ? jsonResponse({ ...running, now: new Date().toISOString() })
      : jsonResponse(null, false, 404)));

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

describe("Focus request ordering and lifecycle", () => {
  it("invalidates an older GET at mutation start, before the POST has completed", async () => {
    const oldRead = deferredResponse();
    const mutation = deferredResponse();
    let reads = 0;
    stubFetch((_url, method) => method === "POST" ? mutation.promise :
      ++reads === 1 ? jsonResponse(focusState(activeSession({ id: "initial" }))) : oldRead.promise);
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    act(() => result.current.reload());
    let done!: Promise<void>;
    act(() => { done = result.current.dispatch("pause"); });
    await act(async () => { oldRead.resolve(jsonResponse(focusState(activeSession({ id: "stale" })))); });
    expect(result.current.state?.active?.id).toBe("initial");
    expect(result.current.busy).toBe(true);
    await act(async () => {
      mutation.resolve(jsonResponse({ state: focusState(activeSession({ id: "paused", status: "paused" })) }));
      await done;
    });
    expect(result.current.state?.active?.id).toBe("paused");
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`ignores an old GET ${outcome} after a successful mutation`, async () => {
      const oldRead = deferredResponse();
      let reads = 0;
      stubFetch((_url, method) => method === "POST"
        ? jsonResponse({ state: focusState(activeSession({ id: "authoritative", revision: 2 })) })
        : ++reads === 1 ? jsonResponse(focusState(activeSession({ id: "initial" }))) : oldRead.promise);
      const { result } = renderHook(() => useFocusState());
      await act(async () => {});
      act(() => result.current.reload());
      await act(async () => { await result.current.dispatch("pause"); });
      await act(async () => {
        if (outcome === "success") oldRead.resolve(jsonResponse(focusState(activeSession({ id: "stale" }))));
        else oldRead.reject(new Error("stale GET failure"));
      });
      expect(result.current.state?.active?.id).toBe("authoritative");
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    it(`accepts the latest issued GET and ignores an older ${outcome}`, async () => {
      const first = deferredResponse();
      const second = deferredResponse();
      const queue = [first, second];
      let reads = 0;
      stubFetch(() => ++reads === 1 ? jsonResponse(focusState(activeSession({ id: "initial" }))) : queue.shift()!.promise);
      const { result } = renderHook(() => useFocusState());
      await act(async () => {});
      act(() => { result.current.reload(); result.current.reload(); });
      await act(async () => { second.resolve(jsonResponse(focusState(activeSession({ id: "latest" })))); });
      await act(async () => {
        if (outcome === "success") first.resolve(jsonResponse(focusState(activeSession({ id: "stale" }))));
        else first.reject(new Error("older failure"));
      });
      expect(result.current.state?.active?.id).toBe("latest");
      expect(result.current.error).toBeNull();
    });
  }

  it("retains the latest GET failure when an older success arrives afterward", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const queue = [first, second];
    let reads = 0;
    stubFetch(() => ++reads === 1 ? jsonResponse(focusState(activeSession({ id: "initial" }))) : queue.shift()!.promise);
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    act(() => { result.current.reload(); result.current.reload(); });
    await act(async () => { second.reject(new Error("latest request failed")); });
    await act(async () => { first.resolve(jsonResponse(focusState(activeSession({ id: "stale" })))); });
    expect(result.current.state?.active?.id).toBe("initial");
    expect(result.current.error).toBe("latest request failed");
    expect(result.current.loading).toBe(false);
  });

  it("settles loading when reload supersedes a pending initial GET", async () => {
    const initial = deferredResponse();
    let reads = 0;
    stubFetch(() => ++reads === 1 ? initial.promise : jsonResponse(focusState(activeSession({ id: "replacement" }))));
    const { result } = renderHook(() => useFocusState());
    await act(async () => { result.current.reload(); });
    expect(result.current.state?.active?.id).toBe("replacement");
    expect(result.current.loading).toBe(false);
    await act(async () => { initial.reject(new Error("stale initial failure")); });
    expect(result.current.error).toBeNull();
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`settles loading when a ${outcome} mutation replaces the initial GET`, async () => {
      const initial = deferredResponse();
      stubFetch((_url, method) => method === "GET" ? initial.promise : outcome === "success"
        ? jsonResponse({ state: focusState(activeSession({ id: "mutation" })) })
        : failure("mutation failed"));
      const { result } = renderHook(() => useFocusState());
      await act(async () => { await result.current.dispatch("start"); });
      expect(result.current.loading).toBe(false);
      expect(result.current.busy).toBe(false);
      expect(result.current.error).toBe(outcome === "success" ? null : "mutation failed");
      const accepted = result.current.state;
      await act(async () => { initial.resolve(jsonResponse(focusState(activeSession({ id: "stale initial" })))); });
      expect(result.current.state).toBe(accepted);
      expect(result.current.error).toBe(outcome === "success" ? null : "mutation failed");
    });
  }

  it("surfaces a background failure that superseded the only initial read", async () => {
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    const initial = deferredResponse();
    let reads = 0;
    stubFetch(() => ++reads === 1 ? initial.promise : failure("background initial failed"));
    const { result } = renderHook(() => useFocusState());
    await act(async () => { MockBroadcastChannel.instances[0]!.onmessage?.({ data: "sync" }); });
    expect(result.current.loading).toBe(false);
    expect(result.current.state).toBeNull();
    expect(result.current.error).toBe("background initial failed");
    await act(async () => { initial.resolve(jsonResponse(focusState())); });
    expect(result.current.state).toBeNull();
    expect(result.current.error).toBe("background initial failed");
  });

  it("preserves 409 authoritative state against a late GET", async () => {
    const oldRead = deferredResponse();
    let reads = 0;
    const authoritative = focusState(activeSession({ id: "conflict", revision: 9 }));
    stubFetch((_url, method) => method === "POST" ? failure("revision conflict", 409, authoritative) :
      ++reads === 1 ? jsonResponse(focusState(activeSession())) : oldRead.promise);
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    act(() => result.current.reload());
    await act(async () => { await result.current.dispatch("pause"); });
    await act(async () => { oldRead.resolve(jsonResponse(focusState(activeSession({ id: "stale" })))); });
    expect(result.current.state).toEqual(authoritative);
    expect(result.current.error).toBeNull();
  });

  it("does not self-heal from a non-409 error carrying details.state", async () => {
    const initial = focusState(activeSession({ id: "initial" }));
    stubFetch((_url, method) => method === "GET" ? jsonResponse(initial)
      : failure("server failure", 500, focusState(activeSession({ id: "untrusted error state" }))));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    await act(async () => { await result.current.dispatch("stop"); });
    expect(result.current.state).toEqual(initial);
    expect(result.current.error).toBe("server failure");
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`ignores a StrictMode setup's late ${outcome} after cleanup and remount`, async () => {
      const discarded = deferredResponse();
      const current = deferredResponse();
      const queue = [discarded, current];
      const fetchMock = stubFetch(() => queue.shift()!.promise);
      const { result } = renderHook(() => useFocusState(), { reactStrictMode: true });
      expect(stateGetCalls(fetchMock)).toBe(2);
      await act(async () => { current.resolve(jsonResponse(focusState(activeSession({ id: "current epoch" })))); });
      await act(async () => {
        if (outcome === "success") discarded.resolve(jsonResponse(focusState(activeSession({ id: "discarded epoch" }))));
        else discarded.reject(new Error("discarded epoch error"));
      });
      expect(result.current.state?.active?.id).toBe("current epoch");
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  }

  it("ignores outstanding reads and retained callbacks after unmount", async () => {
    const pending = deferredResponse();
    const fetchMock = stubFetch(() => pending.promise);
    const { result, unmount } = renderHook(() => useFocusState());
    const last = result.current;
    unmount();
    await act(async () => {
      last.reload();
      const action = last.dispatch("start");
      pending.resolve(jsonResponse(focusState(activeSession({ id: "late" }))));
      await action;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(last);
  });

  it("does not launch GETs or duplicate mutations while a POST is busy", async () => {
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    const mutation = deferredResponse();
    const fetchMock = stubFetch((_url, method) => method === "POST" ? mutation.promise : jsonResponse(focusState()));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    let done!: Promise<void>;
    act(() => { done = result.current.dispatch("start"); });
    await act(async () => {
      result.current.reload();
      MockBroadcastChannel.instances[0]!.onmessage?.({ data: "sync" });
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(15_000);
      await result.current.dispatch("start");
    });
    expect(stateGetCalls(fetchMock)).toBe(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => { mutation.resolve(jsonResponse({ state: focusState() })); await done; });
    expect(result.current.busy).toBe(false);
  });

  it("keeps background refresh errors silent once valid state exists", async () => {
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    const initial = focusState(activeSession());
    let reads = 0;
    stubFetch(() => ++reads === 1 ? jsonResponse(initial) : failure("temporary background failure"));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    await act(async () => { MockBroadcastChannel.instances[0]!.onmessage?.({ data: "sync" }); });
    expect(result.current.state).toEqual(initial);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe("Focus server-time and monotonic clock", () => {
  const serverNow = Date.parse("2026-10-22T12:00:00.000Z");
  let monotonic = 0;
  beforeEach(() => {
    monotonic = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  });
  async function advance(ms: number) {
    monotonic += ms;
    await act(async () => { vi.advanceTimersByTime(ms); });
  }
  function runningAt(now: number, end = serverNow + 60_000): FocusState {
    return focusState(activeSession({ expectedEndAt: new Date(end).toISOString(), remainingSeconds: 60 }), {
      now: new Date(now).toISOString(),
    });
  }

  for (const offset of [-300_000, 300_000]) {
    it(`ignores a client wall clock offset of ${offset / 1000}s and later wall-clock jumps`, async () => {
      vi.setSystemTime(new Date(serverNow + offset));
      stubFetch(() => jsonResponse(runningAt(serverNow)));
      const { result } = renderHook(() => useFocusState());
      await act(async () => {});
      expect(result.current.displayNow).toBe(serverNow);
      expect(result.current.remainingSeconds).toBe(60);
      await advance(3000);
      expect(result.current.remainingSeconds).toBe(57);
      vi.setSystemTime(new Date(serverNow + 12 * 60 * 60 * 1000));
      await advance(1000);
      expect(result.current.remainingSeconds).toBe(56);
      vi.setSystemTime(new Date(serverNow - 12 * 60 * 60 * 1000));
      await advance(1000);
      expect(result.current.remainingSeconds).toBe(55);
    });
  }

  it("recalibrates from a 409 state and then advances only with the monotonic clock", async () => {
    stubFetch((_url, method) => method === "GET" ? jsonResponse(runningAt(serverNow))
      : failure("conflict", 409, runningAt(serverNow + 30_000)));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    await advance(5000);
    await act(async () => { await result.current.dispatch("pause"); });
    expect(result.current.remainingSeconds).toBe(30);
    await advance(1000);
    expect(result.current.remainingSeconds).toBe(29);
  });

  it("recalibrates when the page becomes visible and polls only while visible", async () => {
    let time = serverNow;
    const fetchMock = stubFetch(() => jsonResponse(runningAt(time)));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    visibility = "hidden";
    await advance(15_000);
    expect(stateGetCalls(fetchMock)).toBe(1);
    time = serverNow + 25_000;
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.remainingSeconds).toBe(35);
    time = serverNow + 40_000;
    await advance(15_000);
    expect(stateGetCalls(fetchMock)).toBe(3);
    expect(result.current.remainingSeconds).toBe(20);
  });

  it("holds paused remainingSeconds and clamps an expired running countdown to zero", async () => {
    const paused = focusState(activeSession({ status: "paused", remainingSeconds: 23 }), {
      now: new Date(serverNow).toISOString(),
    });
    let next = paused;
    stubFetch(() => jsonResponse(next));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    await advance(5000);
    expect(result.current.remainingSeconds).toBe(23);
    next = runningAt(serverNow, serverNow + 2000);
    await act(async () => { result.current.reload(); });
    expect(result.current.remainingSeconds).toBe(2);
    await advance(3000);
    expect(result.current.remainingSeconds).toBe(0);
  });

  it("rejects an invalid server.now without accepting a NaN clock anchor", async () => {
    stubFetch(() => jsonResponse(focusState(null, { now: "not-a-timestamp" })));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    expect(result.current.state).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toMatch(/server|time|invalid/i);
    expect(Number.isFinite(result.current.displayNow)).toBe(true);
  });

  it("retains valid state when a 409 payload has an invalid server.now", async () => {
    const initial = runningAt(serverNow);
    stubFetch((_url, method) => method === "GET" ? jsonResponse(initial)
      : failure("invalid conflict state", 409, focusState(null, { now: "invalid" })));
    const { result } = renderHook(() => useFocusState());
    await act(async () => {});
    await act(async () => { await result.current.dispatch("stop"); });
    expect(result.current.state).toEqual(initial);
    expect(result.current.error).not.toBeNull();
    expect(Number.isFinite(result.current.displayNow)).toBe(true);
  });
});
