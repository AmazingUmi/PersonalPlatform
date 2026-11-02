import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../shared/api";
import * as api from "./api";
import { useFocusState } from "./useFocusState";

const auth = vi.hoisted(() => ({ user: { id: "completion-user" } as { id: string } | null }));
vi.mock("../../shell/AuthContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell/AuthContext")>();
  return { ...actual, useAuth: () => auth, useOptionalAuth: () => auth };
});
vi.mock("./api", async (original) => ({ ...await original<typeof api>(), fetchFocusState: vi.fn(), fetchFocusSession: vi.fn(), startFocusSession: vi.fn(), pauseFocusSession: vi.fn(), resumeFocusSession: vi.fn(), stopFocusSession: vi.fn() }));
const now = Date.parse("2026-11-01T12:00:00.000Z");
function state(id: string | null = "current", end = now + 1500): api.FocusState {
  return {
    now: new Date(now).toISOString(),
    active: id ? { id, kind: "focus", status: "running", expectedEndAt: new Date(end).toISOString(), startedAt: new Date(now).toISOString(), pausedAt: null, revision: 1, plannedDurationSeconds: 2, elapsedSeconds: 0, remainingSeconds: 2 } : null,
    nextKind: "short_break", today: { focusedSeconds: 0, completedRounds: 0, sessionsEnded: 0 },
    settings: { focusDurationSeconds: 1500, shortBreakDurationSeconds: 300, longBreakDurationSeconds: 900, longBreakInterval: 4 },
  };
}
function terminal(id = "current", kind: api.SessionKind = "focus"): api.FocusHistoryItem {
  return { id, kind, status: "completed", plannedDurationSeconds: 2, actualDurationSeconds: 2, startedAt: new Date(now).toISOString(), endedAt: new Date(now + 1500).toISOString(), endReason: "natural" };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); auth.user = { id: "completion-user" };
  vi.mocked(api.fetchFocusState).mockResolvedValue(state());
  vi.mocked(api.fetchFocusSession).mockResolvedValue(terminal());
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function settle() { await act(async () => {}); }

describe("verified Focus completion", () => {
  for (const kind of ["focus", "short_break", "long_break"] as const) {
    it(`reconciles the exact deadline and retains the ${kind} completion until dismissed`, async () => {
      vi.mocked(api.fetchFocusSession).mockResolvedValue(terminal("current", kind));
      const { result } = renderHook(useFocusState); await settle();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(result.current.remainingSeconds).toBe(0);
      expect(api.fetchFocusState).toHaveBeenCalledTimes(1);
      expect(result.current.completion).toBeNull();
      vi.mocked(api.fetchFocusState).mockResolvedValue(state(null));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(api.fetchFocusState).toHaveBeenCalledTimes(2);
      expect(result.current.completion?.kind).toBe(kind);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(result.current.completion?.id).toBe("current");
      act(() => result.current.dismissCompletion());
      await act(async () => { result.current.reload(); });
      expect(result.current.completion).toBeNull();
      expect(api.fetchFocusSession).toHaveBeenCalledTimes(1);
    });
  }
  it("does not replay history on initial idle load", async () => {
    vi.mocked(api.fetchFocusState).mockResolvedValue(state(null));
    const { result } = renderHook(useFocusState); await settle();
    expect(api.fetchFocusSession).not.toHaveBeenCalled(); expect(result.current.completion).toBeNull();
  });
  it("does not treat a manual stop or cross-tab cancelled replacement as completion", async () => {
    vi.mocked(api.fetchFocusSession).mockResolvedValue({ ...terminal(), status: "cancelled", endReason: "manual_stop" });
    const { result } = renderHook(useFocusState); await settle();
    vi.mocked(api.fetchFocusState).mockResolvedValue(state("replacement"));
    await act(async () => { result.current.reload(); });
    expect(result.current.completion).toBeNull();
    expect(api.fetchFocusSession).toHaveBeenCalledWith("current");
  });
  it("cancels a paused deadline and arms a resumed deadline", async () => {
    const { result } = renderHook(useFocusState); await settle();
    const paused = state(); paused.active = { ...paused.active!, status: "paused", expectedEndAt: null };
    vi.mocked(api.pauseFocusSession).mockResolvedValue(paused);
    await act(async () => { await result.current.dispatch("pause"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.fetchFocusState).toHaveBeenCalledTimes(1);
    expect(api.fetchFocusSession).not.toHaveBeenCalled();
    vi.mocked(api.resumeFocusSession).mockResolvedValue(state("current", now + 1000));
    await act(async () => { await result.current.dispatch("resume"); });
    vi.mocked(api.fetchFocusState).mockResolvedValue(state(null));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.completion?.id).toBe("current");
  });
  it("retries failed evidence at a bounded cadence even after a newer session is accepted", async () => {
    vi.mocked(api.fetchFocusSession).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(terminal());
    const { result } = renderHook(useFocusState); await settle();
    vi.mocked(api.fetchFocusState).mockResolvedValue(state("replacement", now + 60000));
    await act(async () => { result.current.reload(); });
    expect(result.current.completion).toBeNull();
    await act(async () => { result.current.reload(); await vi.advanceTimersByTimeAsync(4999); });
    expect(api.fetchFocusSession).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.completion?.id).toBe("current");
  });
  it("does not spin when reconciliation still returns an expired running row", async () => {
    vi.mocked(api.fetchFocusState).mockImplementation(async () => state("current", now));
    renderHook(useFocusState); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.fetchFocusState).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4998); });
    expect(api.fetchFocusState).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(api.fetchFocusState).toHaveBeenCalledTimes(3);
  });
  it("accepts natural completion from a 409 authoritative self-heal", async () => {
    const { result } = renderHook(useFocusState); await settle();
    vi.mocked(api.pauseFocusSession).mockRejectedValue(new ApiError("expired", 409, "conflict", { state: state(null) }));
    await act(async () => { await result.current.dispatch("pause"); });
    expect(result.current.completion?.id).toBe("current");
  });
  for (const action of ["unmount", "identity"] as const) {
    it(`rejects stale terminal evidence after ${action}`, async () => {
      const pending = deferred<api.FocusHistoryItem>(); vi.mocked(api.fetchFocusSession).mockReturnValue(pending.promise);
      const { result, unmount, rerender } = renderHook(useFocusState); await settle();
      vi.mocked(api.fetchFocusState).mockResolvedValue(state(null));
      await act(async () => { result.current.reload(); });
      if (action === "unmount") unmount(); else { auth.user = { id: "different-user" }; rerender(); await settle(); }
      await act(async () => { pending.resolve(terminal()); });
      expect(result.current.completion).toBeNull();
    });
  }
  it("keeps malformed/missing evidence silent", async () => {
    vi.mocked(api.fetchFocusSession).mockResolvedValue({ ...terminal(), endedAt: null } as unknown as api.FocusHistoryItem);
    const { result } = renderHook(useFocusState); await settle();
    vi.mocked(api.fetchFocusState).mockResolvedValue(state(null));
    await act(async () => { result.current.reload(); });
    expect(result.current.completion).toBeNull();
  });
});
