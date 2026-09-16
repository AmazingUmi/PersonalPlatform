/**
 * Auth service (AUTH-1): the ONLY code outside migrations that touches
 * core.users / core.sessions. Apps receive identity through ctx.auth
 * (backend/src/core/auth/guard.ts), never through this module.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseContext } from "../database/index.js";
import type { Logger } from "../logging/index.js";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./passwords.js";
import { generateSessionToken, hashSessionToken, SESSION_SEEN_THROTTLE_MS, sessionExpiry } from "./sessions.js";

export type UserRole = "admin" | "user";

export interface AuthUserView {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  status: string;
}

interface UserListRow {
  id: string;
  username: string;
  display_name: string | null;
  role: UserRole;
  status: string;
  created_at: Date;
  last_login_at: Date | null;
}

export interface UserAccountView {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Usernames are lowercase slugs — stable for lookup and display. */
export const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;

function toUserView(row: Pick<UserRow, "id" | "username" | "display_name" | "role">): AuthUserView {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

function toUserAccountView(row: UserListRow): UserAccountView {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at === null ? null : row.last_login_at.toISOString(),
  };
}

/** True when the stored hash is not an Argon2 hash — the pending bootstrap placeholder. */
export function isPendingBootstrapHash(passwordHash: string): boolean {
  return !passwordHash.startsWith("$argon2");
}

// ---------------------------------------------------------------------------
// login / logout / resolve
// ---------------------------------------------------------------------------

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AuthUserView;
}

/**
 * Verify credentials and mint a fresh session (a new token per login —
 * session fixation has no foothold). Returns null for ANY bad combination:
 * unknown username and wrong password are indistinguishable, and the
 * unknown-username path still runs one Argon2 verification against a dummy
 * hash so timing does not leak account existence.
 */
/**
 * Fixed dummy hash for the unknown-username path: one Argon2 verification
 * against it costs the same as a real one, so login timing cannot reveal
 * whether an account exists. (Argon2id, same parameters as real hashes; the
 * preimage is documented here and worthless.)
 */
const TIMING_DUMMY_HASH_PROMISE = hashPassword("pp-timing-equalizer");

export async function login(
  db: DatabaseContext,
  credentials: { username: string; password: string },
  now: Date,
): Promise<LoginResult | null> {
  const { rows } = await db.query<UserRow>(
    "SELECT id, username, password_hash, display_name, role, status FROM core.users WHERE username = $1",
    [credentials.username],
  );
  const user = rows[0];
  if (!user) {
    // Burn exactly one Argon2 verification, like the real path.
    await verifyPassword(await TIMING_DUMMY_HASH_PROMISE, credentials.password);
    return null;
  }
  if (!(await verifyPassword(user.password_hash, credentials.password))) return null;
  // Pending-bootstrap and disabled accounts answer exactly like a wrong password.
  if (user.status !== "active" || isPendingBootstrapHash(user.password_hash)) return null;

  const token = generateSessionToken();
  const expiresAt = sessionExpiry(now);
  await db.query(
    "INSERT INTO core.sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [randomUUID(), user.id, hashSessionToken(token), expiresAt],
  );
  await db.query("UPDATE core.users SET last_login_at = $2, updated_at = now() WHERE id = $1", [
    user.id,
    now,
  ]);
  return { token, expiresAt, user: toUserView(user) };
}

/** Delete the session row — the cookie's token is invalid from this moment. */
export async function logout(db: DatabaseContext, token: string): Promise<void> {
  await db.query("DELETE FROM core.sessions WHERE token_hash = $1", [hashSessionToken(token)]);
}

/**
 * Cookie token → active user, checking expiry and account status. Refreshes
 * last_seen_at at most once per throttle window. Returns null for anything
 * other than a live session of an active account.
 */
export async function resolveSession(
  db: DatabaseContext,
  token: string,
  now: Date,
): Promise<AuthUserView | null> {
  const { rows } = await db.query<{
    id: string;
    username: string;
    display_name: string | null;
    role: UserRole;
    status: string;
    expires_at: Date;
    last_seen_at: Date | null;
  }>(
    `SELECT u.id, u.username, u.display_name, u.role, u.status, s.expires_at, s.last_seen_at
     FROM core.sessions s
     JOIN core.users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashSessionToken(token)],
  );
  const row = rows[0];
  if (!row || row.expires_at.getTime() <= now.getTime()) return null;
  if (row.status !== "active") return null;

  const seen = row.last_seen_at?.getTime() ?? 0;
  if (now.getTime() - seen > SESSION_SEEN_THROTTLE_MS) {
    await db
      .query("UPDATE core.sessions SET last_seen_at = $2 WHERE token_hash = $1", [
        hashSessionToken(token),
        now,
      ])
      .catch(() => undefined); // best-effort telemetry, never blocks the request
  }
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

/** Maintenance: purge expired sessions. Returns how many rows were removed. */
export async function purgeExpiredSessions(db: DatabaseContext, now: Date): Promise<number> {
  const result = await db.query("DELETE FROM core.sessions WHERE expires_at <= $1", [now]);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// user management (admin surface)
// ---------------------------------------------------------------------------

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username "${username}" is already taken`);
    this.name = "UsernameTakenError";
  }
}

export class InvalidUsernameError extends Error {
  constructor(username: string) {
    super(`username must match ${USERNAME_PATTERN.source} (got "${username}")`);
    this.name = "InvalidUsernameError";
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    this.name = "WeakPasswordError";
  }
}

/** Regular accounts are role 'user'; only bootstrap ever creates admins. */
export async function createUser(
  db: DatabaseContext,
  input: { username: string; password: string; displayName?: string | null },
): Promise<AuthUserView> {
  const username = input.username.trim();
  if (!USERNAME_PATTERN.test(username)) throw new InvalidUsernameError(username);
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO core.users (id, username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, 'user')
       RETURNING id, username, password_hash, display_name, role, status`,
      [randomUUID(), username, passwordHash, input.displayName?.trim() || null],
    );
    return toUserView(rows[0]!);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new UsernameTakenError(username);
    throw error;
  }
}

export async function listUsers(db: DatabaseContext): Promise<UserAccountView[]> {
  const { rows } = await db.query<UserListRow>(
    `SELECT id, username, display_name, role, status, created_at, last_login_at
     FROM core.users ORDER BY created_at, id`,
  );
  return rows.map(toUserAccountView);
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  username?: string;
  password?: string;
  log?: Logger;
}

export type BootstrapOutcome =
  | { action: "activated"; username: string }
  | { action: "created"; username: string }
  | { action: "noop"; username: string; reason: "already-active" | "no-password" | "no-pending-and-exists" };

/**
 * Activate (or create) the first admin account. Idempotent and NON-DESTRUCTIVE:
 *
 * - the seeded placeholder row is repurposed (renamed in place when the
 *   requested username differs) so its id — and therefore the legacy data
 *   already backfilled to it — stays stable;
 * - an account that already has a real Argon2 hash is NEVER rewritten, no
 *   matter what password the environment carries (a restart must not reset
 *   the operator's password);
 * - with no pending placeholder and a missing username, a new admin is
 *   created (the platform was already bootstrapped under another name).
 *
 * The password is only ever written as a hash and never logged.
 */
export async function ensureBootstrapAdmin(
  db: DatabaseContext,
  options: BootstrapOptions,
): Promise<BootstrapOutcome> {
  const username = (options.username ?? "admin").trim();
  const { rows: existingRows } = await db.query<UserRow>(
    "SELECT id, username, password_hash, display_name, role, status FROM core.users WHERE username = $1",
    [username],
  );
  const existing = existingRows[0];

  if (existing && !isPendingBootstrapHash(existing.password_hash)) {
    // Already activated (possibly under a different name in the past): reset is forbidden.
    return { action: "noop", username, reason: "already-active" };
  }
  if (!options.password || options.password.length < MIN_PASSWORD_LENGTH) {
    options.log?.info(
      { username },
      `bootstrap account "${username}" pending: provide BOOTSTRAP_ADMIN_PASSWORD (>= ${MIN_PASSWORD_LENGTH} chars) or run npm run bootstrap:admin`,
    );
    return { action: "noop", username, reason: "no-password" };
  }
  const passwordHash = await hashPassword(options.password);

  if (existing) {
    // The placeholder row itself: activate in place.
    await db.query(
      `UPDATE core.users SET password_hash = $2, last_login_at = NULL, updated_at = now() WHERE id = $1`,
      [existing.id, passwordHash],
    );
    return { action: "activated", username };
  }

  const { rows: pendingRows } = await db.query<UserRow>(
    `SELECT id, username, password_hash, display_name, role, status FROM core.users
     WHERE password_hash NOT LIKE '$argon2%'
     ORDER BY created_at, id
     LIMIT 1`,
  );
  const pending = pendingRows[0];
  if (pending) {
    // Repurpose the placeholder (stable id → backfilled legacy data follows it).
    await db.query(
      `UPDATE core.users SET username = $2, password_hash = $3, display_name = $4, updated_at = now() WHERE id = $1`,
      [pending.id, username, passwordHash, pending.display_name],
    );
    return { action: "activated", username };
  }

  await db.query(
    `INSERT INTO core.users (id, username, password_hash, display_name, role)
     VALUES ($1, $2, $3, 'Administrator', 'admin')`,
    [randomUUID(), username, passwordHash],
  );
  return { action: "created", username };
}
