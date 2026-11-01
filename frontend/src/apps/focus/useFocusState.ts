import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../shell/AuthContext";
import { useFocusAlerts } from "./useFocusAlerts";
import { ApiError } from "../../shared/api";
import {
  fetchFocusState,
  fetchFocusSession,
  type FocusHistoryItem,
  pauseFocusSession,
  resumeFocusSession,
  startFocusSession,
  stopFocusSession,
  type FocusState,
  type SessionKind,
} from "./api";

export type FocusAction = "start" | "pause" | "resume" | "stop";

/** Cross-tab sync channel; arbitrary focus tabs/widgets stay coherent. */
export const FOCUS_CHANNEL = "focus";
/** Background poll safety net while the tab is visible. */
const POLL_INTERVAL_MS = 15_000;

/** Structural guard for the 409 self-heal payload (details.state). */
function isFocusStateLike(value: unknown): value is FocusState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FocusState>;
  return (
    typeof candidate.now === "string" &&
    Number.isFinite(Date.parse(candidate.now)) &&
    (candidate.active === null || typeof candidate.active === "object") &&
    typeof candidate.today === "object" &&
    candidate.today !== null &&
    (candidate.nextKind === "focus" ||
      candidate.nextKind === "short_break" ||
      candidate.nextKind === "long_break") &&
    typeof candidate.settings === "object" &&
    candidate.settings !== null
  );
}

/**
 * Server-authoritative state with ordered reads and a monotonic display clock.
 * All reads share sequence/generation/epoch guards; starting a mutation
 * invalidates earlier reads. Each accepted response anchors server `now` to
 * performance.now(), so client wall-clock changes cannot move the countdown.
 */
export function useFocusState(): {
  state: FocusState | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  displayNow: number;
  remainingSeconds: number;
  dispatch: (action: FocusAction, kind?: SessionKind) => Promise<void>;
  reload: () => void;
  completion: FocusHistoryItem | null;
  dismissCompletion: () => void;
  alerts: ReturnType<typeof useFocusAlerts>;
} {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const alerts = useFocusAlerts(userId);
  const [hasPending, setHasPending] = useState(false);
  const [completion, setCompletion] = useState<FocusHistoryItem | null>(null);
  const pendingRef = useRef(new Map<string, { inFlight: boolean; retryAt: number }>());
  const handledRef = useRef(new Set<string>());
  const identityRef = useRef(userId);
  identityRef.current = userId;
  const [state, setState] = useState<FocusState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayNow, setDisplayNow] = useState(0);

  const mountedRef = useRef(false);
  const mountEpochRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const stateRef = useRef<FocusState | null>(null);
  const anchorRef = useRef<{ serverNow: number; receivedAt: number } | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const verifyPending = useCallback(() => {
    if (!mountedRef.current || !userId || identityRef.current !== userId) return;
    const epoch = mountEpochRef.current;
    for (const [id, pending] of pendingRef.current) {
      if (pending.inFlight || pending.retryAt > performance.now()) continue;
      pending.inFlight = true;
      const current = () => mountedRef.current && mountEpochRef.current === epoch && identityRef.current === userId;
      void fetchFocusSession(id).then((terminal) => {
        if (!current()) return;
        // Exact-session evidence only. Malformed responses never establish success.
        if (terminal?.id !== id || !["completed", "cancelled"].includes(terminal.status)) return;
        pendingRef.current.delete(id);
        setHasPending(pendingRef.current.size > 0);
        handledRef.current.add(id);
        if (terminal.status === "completed" && terminal.endReason === "natural" &&
            ["focus", "short_break", "long_break"].includes(terminal.kind) &&
            typeof terminal.endedAt === "string" && Number.isFinite(Date.parse(terminal.endedAt))) {
          setCompletion((previous) => !previous || Date.parse(terminal.endedAt) >= Date.parse(previous.endedAt) ? terminal : previous);
          alerts.announce(terminal);
        }
      }).catch(() => {
        // Includes temporary 404s: reconciliation and terminal visibility can race.
        // Never infer success from a disappearance or a failed lookup.
      }).finally(() => {
        if (!current()) return;
        pending.inFlight = false;
        pending.retryAt = performance.now() + 5000;
      });
    }
  }, [userId, alerts.announce]);

  const applyState = useCallback((next: FocusState) => {
    const serverNow = Date.parse(next?.now);
    if (!Number.isFinite(serverNow)) throw new Error("Invalid focus server time");
    const previousId = stateRef.current?.active?.id;
    if (previousId && previousId !== next.active?.id && !handledRef.current.has(previousId) && !pendingRef.current.has(previousId)) {
      pendingRef.current.set(previousId, { inFlight: false, retryAt: 0 });
      setHasPending(true);
    }
    anchorRef.current = { serverNow, receivedAt: performance.now() };
    stateRef.current = next;
    setState(next);
    setDisplayNow(serverNow);
    verifyPending();
  }, [verifyPending]);

  const loadState = useCallback(async (mode: "foreground" | "background") => {
    if (!mountedRef.current || busyRef.current || !userId || identityRef.current !== userId) return;
    const epoch = mountEpochRef.current;
    const generation = mutationGenerationRef.current;
    const sequence = ++requestSequenceRef.current;
    const current = () => mountedRef.current && mountEpochRef.current === epoch && identityRef.current === userId &&
      mutationGenerationRef.current === generation && requestSequenceRef.current === sequence;
    if (stateRef.current === null) setLoading(true);
    try {
      const next = await fetchFocusState();
      if (!current()) return;
      applyState(next);
      setError(null);
    } catch (err) {
      if (!current()) return;
      // A background failure is silent only when there is valid state to
      // keep displaying; it must not strand a superseded initial load.
      if (mode === "foreground" || stateRef.current === null) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [applyState, userId]);

  const refetch = useCallback(() => loadState("background"), [loadState]);
  const reload = useCallback(() => {
    void loadState("foreground");
  }, [loadState]);

  // StrictMode cleanup/setup is a new epoch even though refs survive it.
  useEffect(() => {
    mountEpochRef.current += 1;
    mountedRef.current = true;
    busyRef.current = false;
    setBusy(false);
    stateRef.current = null;
    anchorRef.current = null;
    pendingRef.current.clear();
    setHasPending(false);
    handledRef.current.clear();
    setState(null);
    setCompletion(null);
    setError(null);
    setLoading(Boolean(userId));
    void loadState("foreground");
    return () => {
      mountedRef.current = false;
      mountEpochRef.current += 1;
      requestSequenceRef.current += 1;
      busyRef.current = false;
    };
  }, [loadState, userId]);

  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(verifyPending, 5000);
    return () => clearInterval(id);
  }, [verifyPending, hasPending]);

  // Reconcile at the real server deadline, never the floored display zero.
  // Repeated expired responses retry at most every five seconds. Polling and
  // visibility return also recover failed reads without a zero-delay loop.
  const deadlineAttemptRef = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    const active = state?.active;
    const anchor = anchorRef.current;
    if (busy || active?.status !== "running" || !active.expectedEndAt || !anchor) return;
    const end = Date.parse(active.expectedEndAt);
    if (!Number.isFinite(end)) return;
    const key = `${userId}:${active.id}:${active.revision}:${active.expectedEndAt}`;
    const now = performance.now();
    const remaining = end - anchor.serverNow - Math.max(0, now - anchor.receivedAt);
    const previous = deadlineAttemptRef.current;
    const delay = Math.max(0, remaining, previous?.key === key ? previous.at + 5000 - now : 0);
    const id = setTimeout(() => {
      deadlineAttemptRef.current = { key, at: performance.now() };
      void refetch();
    }, delay);
    return () => clearTimeout(id);
  }, [state, busy, refetch, userId]);

  // Intervals schedule paints; elapsed time always comes from one monotonic
  // delta, rather than adding a second for each callback that happened to run.
  useEffect(() => {
    const id = setInterval(() => {
      const anchor = anchorRef.current;
      if (anchor) setDisplayNow(anchor.serverNow + Math.max(0, performance.now() - anchor.receivedAt));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Cross-tab sync: broadcast after our own mutations, refetch on others'.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(FOCUS_CHANNEL);
    channel.onmessage = () => {
      void refetch();
    };
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.onmessage = null;
      channel.close();
    };
  }, [refetch]);

  // Poll safety net: 15s while visible, immediate on returning to the tab.
  useEffect(() => {
    const refetchIfVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", refetchIfVisible);
    const id = setInterval(refetchIfVisible, POLL_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", refetchIfVisible);
      clearInterval(id);
    };
  }, [refetch]);

  const dispatch = useCallback(async (action: FocusAction, kind?: SessionKind) => {
    if (!mountedRef.current || busyRef.current || !userId || identityRef.current !== userId) return;
    const epoch = mountEpochRef.current;
    const generation = ++mutationGenerationRef.current;
    requestSequenceRef.current += 1;
    const current = () => mountedRef.current && mountEpochRef.current === epoch && identityRef.current === userId &&
      mutationGenerationRef.current === generation;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next =
        action === "start"
          ? await startFocusSession({ kind: kind ?? "focus" })
          : action === "pause"
            ? await pauseFocusSession()
            : action === "resume"
              ? await resumeFocusSession()
              : await stopFocusSession();
      if (!current()) return;
      applyState(next);
      if (action === "start") setCompletion(null);
      channelRef.current?.postMessage({ type: "sync" });
    } catch (err) {
      if (!current()) return;
      // 409 self-heal: the server's conflict body carries the authoritative
      // state — adopt it instead of surfacing an error to the user.
      const details = err instanceof ApiError && err.status === 409 ? err.details : null;
      const healed = details !== null && typeof details === "object" && "state" in details
        ? (details as { state: unknown }).state
        : null;
      if (isFocusStateLike(healed)) {
        applyState(healed);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
        setLoading(false);
      }
    }
  }, [applyState, userId]);

  const active = state?.active ?? null;
  const remainingSeconds = useMemo(() => {
    if (!active) return 0;
    if (active.status === "running" && active.expectedEndAt !== null) {
      const remaining = Math.floor((Date.parse(active.expectedEndAt) - displayNow) / 1000);
      return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    }
    // Paused sessions freeze at the server-reported snapshot.
    return Number.isFinite(active.remainingSeconds) ? Math.max(0, active.remainingSeconds) : 0;
  }, [active, displayNow]);

  return { state, loading, error, busy, displayNow, remainingSeconds, dispatch, reload, completion, dismissCompletion: () => setCompletion(null), alerts };
}
