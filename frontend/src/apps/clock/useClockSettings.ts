import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api";
import { useSyncModelRefresh } from "../../shared/sync-guard-client";
import { useAsync } from "../../shared/useAsync";

/**
 * Clock display settings — one server-owned source of truth
 * (`GET/PUT /api/apps/clock/settings`, focus settings pattern). The dashboard
 * card and the app page are never mounted at the same time, so both reading
 * on mount is enough to keep them in sync.
 */
export interface ClockSettings {
  displayMode: "digital" | "analog";
  showSeconds: boolean;
  showDate: boolean;
  hourFormat: 12 | 24;
}

export const DEFAULT_CLOCK_SETTINGS: ClockSettings = {
  displayMode: "digital",
  showSeconds: true,
  showDate: true,
  hourFormat: 24,
};

export function useClockSettings(): {
  settings: ClockSettings;
  loading: boolean;
  error: string | null;
  saving: boolean;
  reload: () => void;
  save: (next: ClockSettings) => Promise<boolean>;
  syncPending: boolean;
  acceptServerSync: () => void;
} {
  const [override, setOverride] = useState<ClockSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const remote = useAsync(() => api<ClockSettings & { baseHash?: string }>("/api/apps/clock/settings"), [], { retainOnReload: true });
  const hashRef = useRef<string | undefined>(undefined);
  const adopt = useRef(false);
  const overrideRef = useRef<ClockSettings | null>(null);
  overrideRef.current = override;
  if (override === null && remote.data?.baseHash) hashRef.current = remote.data.baseHash;
  const sync = useSyncModelRefresh(override !== null, () => { void remote.reload(); });
  useEffect(() => {
    if (!remote.data || overrideRef.current === null || !adopt.current) return;
    adopt.current = false;
    hashRef.current = remote.data.baseHash;
    setOverride(null);
  }, [remote.data]);
  const settings = override ?? remote.data ?? DEFAULT_CLOCK_SETTINGS;

  const save = useCallback(
    async (next: ClockSettings): Promise<boolean> => {
      setSaving(true);
      try {
        const saved = await api<ClockSettings & { baseHash?: string }>("/api/apps/clock/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...next, ...(hashRef.current ? { baseHash: hashRef.current } : {}) }),
        });
        hashRef.current = saved.baseHash;
        setOverride(saved);
        return true;
      } catch {
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return {
    settings,
    loading: remote.loading && override === null,
    error: remote.error,
    saving,
    reload: remote.reload,
    syncPending: sync.pending,
    acceptServerSync: () => {
      adopt.current = true;
      void remote.reload().then((ok) => {
        if (!ok) adopt.current = false;
      });
    },
    save,
  };
}
