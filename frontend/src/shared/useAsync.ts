import { useI18n } from "./i18n";
import { localizeError } from "./localizeError";
import { useEffect, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Minimal async data hook used by widgets and pages. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> & {
  reload: () => void;
} {
  const { language } = useI18n();
  const [state, setState] = useState<Omit<AsyncState<T>, "error"> & { error: unknown }>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fn()
      .then((data) => {
        if (active) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (active) setState({ data: null, loading: false, error });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, error: state.error === null ? null : localizeError(state.error, language), reload: () => setTick((value) => value + 1) };
}
