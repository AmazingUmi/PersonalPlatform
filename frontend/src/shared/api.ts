export interface AppCapabilities {
  database: boolean;
  storage: boolean;
  scheduler: boolean;
  events: boolean;
}

export interface AppWidgetInfo {
  id: string;
  name: string;
}

export type AppStatus = "installed" | "enabled" | "disabled" | "error";

export interface AppInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  status: AppStatus;
  enabled: boolean;
  defaultEnabled: boolean;
  errorMessage?: string;
  route: string;
  capabilities: AppCapabilities;
  widgets: AppWidgetInfo[];
  hasBackend: boolean;
  hasFrontend: boolean;
}

/** Generic JSON API helper with unified error extraction. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON body */
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: { message?: string } }).error?.message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchApps(): Promise<AppInfo[]> {
  const body = await api<{ items: AppInfo[] }>("/api/core/apps");
  return body.items;
}

export async function setAppEnabled(id: string, enabled: boolean): Promise<AppInfo> {
  return api<AppInfo>(`/api/core/apps/${id}/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/** Platform settings (core.settings): dashboard layout etc. */
export async function getSetting<T>(key: string): Promise<T | null> {
  try {
    return await api<{ key: string; value: T }>(`/api/core/settings/${key}`).then((s) => s.value);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Setting not found")) return null;
    throw error;
  }
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await api(`/api/core/settings/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
}
