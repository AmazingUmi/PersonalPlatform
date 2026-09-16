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

/**
 * Broadcast a session loss so the auth provider can send the user back to
 * /login. Dispatched for any 401 outside /api/core/auth/* (the auth endpoints
 * themselves manage the session lifecycle).
 */
export const UNAUTHORIZED_EVENT = "pp:unauthorized";

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
        ? String((errorBody as { message?: unknown }).message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    if (
      response.status === 401 &&
      !path.startsWith("/api/core/auth/") &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    if (errorBody !== null && typeof errorBody === "object") {
      const { code, details } = errorBody as { code?: unknown; details?: unknown };
      throw new ApiError(message, response.status, typeof code === "string" ? code : null, details);
    }
    // Network failures / non-JSON / non-envelope bodies still throw plain Error.
    throw new Error(message);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Session (AUTH): HttpOnly cookie only — the token never touches JS.
// Same-origin fetch sends cookies by default; no credentials config needed.
// ---------------------------------------------------------------------------

export type UserRole = "admin" | "user";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
}

export interface UserAccount extends AuthUser {
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const body = await api<{ user: AuthUser }>("/api/core/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return body.user;
}

export async function logout(): Promise<void> {
  await api("/api/core/auth/logout", { method: "POST" });
}

/** Current session user; null when unauthenticated (401). */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    return await api<AuthUser>("/api/core/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function listUsers(): Promise<UserAccount[]> {
  const body = await api<{ items: UserAccount[] }>("/api/core/auth/users");
  return body.items;
}

export async function createUser(input: {
  username: string;
  password: string;
  displayName?: string | null;
}): Promise<AuthUser> {
  const body = await api<{ user: AuthUser }>("/api/core/auth/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return body.user;
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
