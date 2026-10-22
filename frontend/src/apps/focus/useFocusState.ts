import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../shared/api";
import {
  fetchFocusState,
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
} {
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

  const applyState = useCallback((next: FocusState) => {
    const serverNow = Date.parse(next?.now);
    if (!Number.isFinite(serverNow)) throw new Error("Invalid focus server time");
    anchorRef.current = { serverNow, receivedAt: performance.now() };
    stateRef.current = next;
    setState(next);
    setDisplayNow(serverNow);
  }, []);

  const loadState = useCallback(async (mode: "foreground" | "background") => {
    if (!mountedRef.current || busyRef.current) return;
    const epoch = mountEpochRef.current;
    const generation = mutationGenerationRef.current;
    const sequence = ++requestSequenceRef.current;
    const current = () => mountedRef.current && mountEpochRef.current === epoch &&
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
  }, [applyState]);

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
    void loadState("foreground");
    return () => {
      mountedRef.current = false;
      mountEpochRef.current += 1;
      requestSequenceRef.current += 1;
      busyRef.current = false;
    };
  }, [loadState]);

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
    if (!mountedRef.current || busyRef.current) return;
    const epoch = mountEpochRef.current;
    const generation = ++mutationGenerationRef.current;
    requestSequenceRef.current += 1;
    const current = () => mountedRef.current && mountEpochRef.current === epoch &&
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
  }, [applyState]);

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

  return { state, loading, error, busy, displayNow, remainingSeconds, dispatch, reload };
}
