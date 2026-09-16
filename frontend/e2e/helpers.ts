/**
 * Authenticated API helper for specs that drive the backend directly (AUTH-5).
 *
 * Logs in once as the backend's bootstrap admin (fixed credentials from
 * playwright.config.ts, BOOTSTRAP_ADMIN_*) and replays the HttpOnly
 * pp_session cookie as a plain Cookie header on every call. When a reused
 * backend invalidated the cached session (restart/expiry), the next 401
 * triggers exactly one re-login.
 *
 * NOTE: bootstrap is idempotent and never resets an already-activated
 * password, so the e2e database must be fresh or already bootstrapped with
 * these exact credentials. CI creates a fresh E2E database each run; a local
 * reused database bootstrapped with a different admin password cannot be
 * recovered from here — the login error is surfaced verbatim instead.
 */

const CORE = "http://127.0.0.1:8902";

export const E2E_ADMIN_USERNAME = "e2e-admin";
export const E2E_ADMIN_PASSWORD = "e2e-admin-password-1";

/** Module-level cookie jar: one admin session shared by all helper calls. */
let cookie: string | null = null;

async function login(): Promise<string> {
  const response = await fetch(`${CORE}/api/core/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(
      `adminFetch login failed: HTTP ${response.status} ${await response.text()} — the e2e ` +
        `database must be fresh or bootstrapped with BOOTSTRAP_ADMIN_USERNAME=${E2E_ADMIN_USERNAME} ` +
        "(see playwright.config.ts); a reused database with a different admin password is not reset here",
    );
  }
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("pp_session="));
  if (!setCookie) throw new Error("adminFetch login: response carried no pp_session cookie");
  return setCookie.split(";")[0]!;
}

/** Fetch with the admin session cookie attached; re-login once on a dead session. */
export async function adminFetch(method: string, path: string, body?: unknown): Promise<Response> {
  if (!cookie) cookie = await login();
  const send = (): Promise<Response> =>
    fetch(`${CORE}${path}`, {
      method,
      // No content-type without a body: an empty JSON body 400s on DELETE.
      headers: body === undefined ? { cookie } : { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let response = await send();
  if (response.status === 401) {
    cookie = await login(); // backend restart or session expiry — retry once
    response = await send();
  }
  return response;
}
