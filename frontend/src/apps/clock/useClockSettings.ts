import { useCallback, useState } from "react";
import { api } from "../../shared/api";
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
} {
  const [override, setOverride] = useState<ClockSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const remote = useAsync(() => api<ClockSettings>("/api/apps/clock/settings"));
  const settings = override ?? remote.data ?? DEFAULT_CLOCK_SETTINGS;

  const save = useCallback(
    async (next: ClockSettings): Promise<boolean> => {
      setSaving(true);
      try {
        const saved = await api<ClockSettings>("/api/apps/clock/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
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
    save,
  };
}
