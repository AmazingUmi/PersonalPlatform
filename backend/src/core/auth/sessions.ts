/**
 * Session token mechanics (AUTH-1). The cookie carries a 256-bit random
 * base64url token; the database stores only its SHA-256 hash, so a leaked
 * database cannot be replayed as valid sessions. A deleted session row is
 * invalid immediately — there is no secondary cache.
 */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "pp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** last_seen_at is refreshed at most this often (avoids a write per request). */
export const SESSION_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}
