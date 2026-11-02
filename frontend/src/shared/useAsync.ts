import { useI18n } from "./i18n";
import { localizeError } from "./localizeError";
import { useEffect, useRef, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface UseAsyncOptions {
  /**
   * Same-resource reload keeps the loaded value and does not flip loading.
   * A dependency change still drops the previous record and ignores late results.
   */
  retainOnReload?: boolean;
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

/**
 * Minimal async data hook used by widgets and pages.
 * Default: every run clears the previous record and reports loading.
 * `retainOnReload` keeps that record only while the dependency list is unchanged.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[] = [],
  options?: UseAsyncOptions,
): AsyncState<T> & { reload: () => Promise<boolean> } {
  const { language } = useI18n();
  const retain = options?.retainOnReload === true;
  const [state, setState] = useState<Omit<AsyncState<T>, "error"> & { error: unknown }>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  const identity = useRef<readonly unknown[] | null>(null);
  const effectIdentity = useRef<readonly unknown[] | null>(null);
  const hasData = useRef(false);
  const waiters = useRef<Array<(ok: boolean) => void>>([]);
  fnRef.current = fn;

  const identityChanged = identity.current !== null && !sameDeps(identity.current, deps);
  if (identity.current === null) identity.current = deps;
  else if (identityChanged) {
    identity.current = deps;
    hasData.current = false;
    if (state.data !== null || state.error !== null || !state.loading) {
      setState({ data: null, loading: true, error: null });
    }
  }

  useEffect(() => {
    return () => {
      const leftover = waiters.current;
      waiters.current = [];
      for (const resolve of leftover) resolve(false);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const mine = waiters.current;
    waiters.current = [];
    const settle = (ok: boolean) => {
      for (const resolve of mine) resolve(ok);
    };
    const depsChanged = effectIdentity.current !== null && !sameDeps(effectIdentity.current, deps);
    effectIdentity.current = deps;
    const keep = retain && !depsChanged && hasData.current;
    if (!keep) {
      hasData.current = false;
      setState({ data: null, loading: true, error: null });
    } else {
      setState((prev) => ({ ...prev, error: null }));
    }
    fnRef.current()
      .then((data) => {
        if (!active) return;
        hasData.current = true;
        setState({ data, loading: false, error: null });
        settle(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (keep) setState((prev) => ({ data: prev.data, loading: false, error }));
        else {
          hasData.current = false;
          setState({ data: null, loading: false, error });
        }
        settle(false);
      });
    return () => {
      active = false;
      settle(false);
    };
    // Resource deps and the explicit reload tick. Language is applied at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, retain]);

  return {
    ...state,
    error: state.error === null ? null : localizeError(state.error, language),
    reload: () => {
      setTick((value) => value + 1);
      return new Promise<boolean>((resolve) => {
        waiters.current.push(resolve);
      });
    },
  };
}
