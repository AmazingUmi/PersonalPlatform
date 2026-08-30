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
const CHANNEL_NAME = "focus";
/** Background poll safety net while the tab is visible. */
const POLL_INTERVAL_MS = 15_000;

/** Structural guard for the 409 self-heal payload (details.state). */
function isFocusStateLike(value: unknown): value is FocusState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FocusState>;
  return (
    typeof candidate.now === "string" &&
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
 * Focus app data hook (APP-1 F06): server state + local 1s display tick.
 *
 * The server owns all timing: `remainingSeconds` is always DERIVED from the
 * active session's `expectedEndAt` (running) or `remainingSeconds` (paused)
 * against `displayNow`; the client never accumulates elapsed time. Mutations
 * swap in the server-returned FocusState; a 409 conflict self-heals from
 * `error.details.state`. Tabs and the dashboard widget stay coherent through
 * a "focus" BroadcastChannel plus a visibility-gated 15s poll.
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
  const [displayNow, setDisplayNow] = useState(() => Date.now());

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const applyState = useCallback((next: FocusState) => {
    setState(next);
    // Keep the countdown anchored to the moment the new state arrived.
    setDisplayNow(Date.now());
  }, []);

  const refetch = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const next = await fetchFocusState();
      if (mountedRef.current) applyState(next);
    } catch {
      /* Silent background refresh: keep the last known state. */
    }
  }, [applyState]);

  const reload = useCallback(() => {
    if (busyRef.current) return;
    void (async () => {
      try {
        const next = await fetchFocusState();
        if (!mountedRef.current) return;
        applyState(next);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [applyState]);

  // Initial load: exactly one GET /state per mount.
  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const next = await fetchFocusState();
        if (!mountedRef.current) return;
        applyState(next);
        setLoading(false);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [applyState]);

  // Local display tick: only moves displayNow; all countdown math derives
  // from it, so drift can never accumulate client-side.
  useEffect(() => {
    const id = setInterval(() => setDisplayNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Cross-tab sync: broadcast after our own mutations, refetch on others'.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
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
    if (busyRef.current) return;
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
      if (!mountedRef.current) return;
      applyState(next);
      channelRef.current?.postMessage({ type: "sync" });
    } catch (err) {
      if (!mountedRef.current) return;
      // 409 self-heal: the server's conflict body carries the authoritative
      // state — adopt it instead of surfacing an error to the user.
      const details = err instanceof ApiError ? err.details : null;
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
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [applyState]);

  const active = state?.active ?? null;
  const remainingSeconds = useMemo(() => {
    if (!active) return 0;
    if (active.status === "running" && active.expectedEndAt !== null) {
      return Math.max(0, Math.floor((Date.parse(active.expectedEndAt) - displayNow) / 1000));
    }
    // Paused sessions freeze at the server-reported snapshot.
    return active.remainingSeconds;
  }, [active, displayNow]);

  return { state, loading, error, busy, displayNow, remainingSeconds, dispatch, reload };
}
