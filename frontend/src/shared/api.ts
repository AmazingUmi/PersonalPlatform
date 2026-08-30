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

/**
 * Structured API error for responses carrying the platform error envelope
 * `{ error: { code, message, details } }`. Extends Error, so existing
 * `catch (e) instanceof Error` / `e.message` consumers keep working; they
 * can additionally narrow on ApiError to read status/code/details.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, status: number, code: string | null, details: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
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
    const errorBody =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error: unknown }).error
        : null;
    // Message extraction is unchanged: envelope message if present, else HTTP <status>.
    const message =
      errorBody !== null && typeof errorBody === "object"
        ? String((errorBody as { message?: string }).message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    if (errorBody !== null && typeof errorBody === "object") {
      const { code, details } = errorBody as { code?: unknown; details?: unknown };
      throw new ApiError(message, response.status, typeof code === "string" ? code : null, details);
    }
    // Network failures / non-JSON / non-envelope bodies still throw plain Error.
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
