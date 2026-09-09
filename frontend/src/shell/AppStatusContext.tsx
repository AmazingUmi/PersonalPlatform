import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import type { AppStatusChip, FrontendAppModule } from "../shared/appTypes";

/** Safety-net poll while the tab is visible: caps staleness for providers
 * without a push channel (and cross-checks the pushed ones). */
const REFRESH_INTERVAL_MS = 60_000;

export type AppStatusMap = Map<string, AppStatusChip[]>;

const EMPTY_STATUS: AppStatusMap = new Map();

const AppStatusContext = createContext<AppStatusMap>(EMPTY_STATUS);

/**
 * Load every enabled module's status provider into one shell-wide map.
 * Refresh triggers: mount, route change, window focus, provider `subscribe`
 * pushes, and a 60s visible-interval safety net. A provider that fails (or
 * its app is disabled — core answers 404) simply yields no chips: status is
 * decorative chrome, never an error surface. Modules must already be
 * intersected with the enabled app list (enabledAppModules).
 */
export function AppStatusProvider({ modules, children }: { modules: FrontendAppModule[]; children: ReactNode }) {
  const [statuses, setStatuses] = useState<AppStatusMap>(EMPTY_STATUS);
  const providersRef = useRef(modules);
  providersRef.current = modules;

  const refresh = useCallback(() => {
    const providers = providersRef.current.filter((mod) => mod.status !== undefined);
    if (providers.length === 0) {
      setStatuses((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    void Promise.all(
      providers.map(async (mod) => {
        try {
          return [mod.id, await mod.status!.load()] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      const next: AppStatusMap = new Map();
      for (const entry of entries) {
        if (entry && entry[1].length > 0) next.set(entry[0], entry[1]);
      }
      setStatuses((prev) => sameChips(prev, next) ? prev : next);
    });
  }, []);

  const { pathname } = useLocation();

  useEffect(() => {
    refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(id);
    };
  }, [refresh]);

  // Provider pushes (e.g. the focus BroadcastChannel): subscribe for the
  // current provider set; rewire only when the enabled set changes.
  const providerKey = modules.map((mod) => mod.id).join(",");
  useEffect(() => {
    const unsubs = modules
      .map((mod) => mod.status?.subscribe?.(() => refresh()))
      .filter((unsub): unsub is () => void => typeof unsub === "function");
    return () => unsubs.forEach((unsub) => unsub());
    // providerKey covers the enabled-set identity; refresh is stable.
  }, [providerKey, refresh]);

  const value = useMemo(() => statuses, [statuses]);
  return <AppStatusContext.Provider value={value}>{children}</AppStatusContext.Provider>;
}

/** Chips for one app (empty array when unknown/failed/not provided). */
export function useAppStatuses(): AppStatusMap {
  return useContext(AppStatusContext) ?? EMPTY_STATUS;
}

/** Structural equality so unchanged refreshes don't re-render the chrome. */
function sameChips(a: AppStatusMap, b: AppStatusMap): boolean {
  if (a.size !== b.size) return false;
  for (const [appId, chips] of a) {
    const other = b.get(appId);
    if (!other || chips.length !== other.length) return false;
    for (let i = 0; i < chips.length; i += 1) {
      const x = chips[i]!;
      const y = other[i]!;
      if (x.id !== y.id || x.label !== y.label || x.tone !== y.tone || x.title !== y.title) return false;
    }
  }
  return true;
}
