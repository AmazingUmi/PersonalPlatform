import { useCallback, useRef, useState } from "react";

export interface MutationState {
  /** Runs the mutation; resolves false when busy or failed, true on success. */
  mutate: () => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * Minimal shared mutation helper (guide FP-7.2): busy state, error extraction,
 * and double-submit protection without pulling in a state-management library.
 */
export function useMutation(fn: () => Promise<unknown>): MutationState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const mutate = useCallback(async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [fn]);

  const clearError = useCallback(() => setError(null), []);
  return { mutate, busy, error, clearError };
}
