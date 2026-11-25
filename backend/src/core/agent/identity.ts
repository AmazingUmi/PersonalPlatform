import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { AppError } from "../api/errors.js";
import { authenticatedRequest } from "../auth/guard.js";
import { lockActiveUser, lockSessionExpiry, USERNAME_PATTERN } from "../auth/service.js";
import { validTimestamp } from "../data-management/snapshot-schema.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { TimeService } from "../time/index.js";
import { readAgentAudit, type AgentAuditPage } from "./audit.js";
import type { AgentAuthority, AgentCredential, AgentScope } from "./types.js";
export type { AgentAuthority, AgentCredential } from "./types.js";

const SCOPES: readonly AgentScope[] = ["read", "write", "delete"];
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIRING_WINDOW_MS = 15 * 60_000;

const AGENT_FIELDS = `id, name, description, created_by_user_id, token_prefix, status, requires_explicit_actor,
  created_at, updated_at, last_used_at`;
const GRANT_FIELDS = `id, agent_id, user_id, scopes, allowed_apps, expires_at, status, granted_at, updated_at, revoked_at`;

export interface AgentView {
  id: string;
  name: string;
  description: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  requiresExplicitActor: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface AgentGrantView {
  id: string;
  agentId: string;
  agentName: string;
  agentStatus: AgentView["status"];
  ownerName: string;
  scopes: AgentScope[];
  allowedApps: string[];
  expiresAt: string | null;
  status: "active" | "revoked";
  grantedAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  created_by_user_id: string;
  token_prefix: string;
  status: AgentView["status"];
  requires_explicit_actor: boolean;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

interface GrantRow {
  id: string;
  agent_id: string;
  user_id: string;
  scopes: AgentScope[];
  allowed_apps: string[];
  expires_at: Date | null;
  status: AgentGrantView["status"];
  granted_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

interface PairingRow {
  id: string;
  requested_scopes: AgentScope[];
  requested_apps: string[];
  expires_at: Date;
  created_at: Date;
}

export interface AgentPermissionInput {
  scopes: readonly AgentScope[];
  allowedApps: readonly string[];
}

export interface AgentGrantInput extends AgentPermissionInput {
  expiresAt?: string | null;
}

interface AgentIdentityOptions {
  database: Database;
  time: TimeService;
  installedApps(): string[];
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unauthorized(): AppError {
  return new AppError(401, "unauthorized", "Authentication is required.");
}

function notFound(): AppError {
  return new AppError(404, "not_found", "Agent or grant was not found.");
}

function pairingUnavailable(): AppError {
  return new AppError(409, "pairing_unavailable", "This pairing code is unavailable. Request a new code.");
}

function agentView(row: AgentRow): AgentView {
  return {
    id: row.id, name: row.name, description: row.description, tokenPrefix: row.token_prefix,
    status: row.status, requiresExplicitActor: row.requires_explicit_actor, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

function grantView(row: GrantRow, agentName: string, agentStatus: AgentView["status"], ownerName: string): AgentGrantView {
  return {
    id: row.id, agentId: row.agent_id, agentName, agentStatus, ownerName,
    scopes: row.scopes, allowedApps: row.allowed_apps, expiresAt: row.expires_at?.toISOString() ?? null,
    status: row.status, grantedAt: row.granted_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function cookie(request: FastifyRequest) {
  const evidence = authenticatedRequest(request);
  if (!evidence) throw unauthorized();
  return evidence;
}

function finiteExpiry(value: string | null | undefined, now: Date): Date | null {
  if (value == null) return null;
  if (typeof value !== "string" || !validTimestamp(value)) {
    throw new AppError(400, "validation_error", "Enter a valid grant expiration time.");
  }
  const expires = new Date(value);
  if (expires <= now) throw new AppError(400, "validation_error", "Grant expiration must be in the future.");
  return expires;
}

function permissionValues(input: AgentPermissionInput, installedApps?: string[]) {
  if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some((scope) => !SCOPES.includes(scope))) {
    throw new AppError(400, "validation_error", "Choose one or more supported Agent scopes.");
  }
  if (!Array.isArray(input.allowedApps) || input.allowedApps.some(
    (app) => typeof app !== "string" || !/^[a-z][a-z0-9_]*$/.test(app) || (installedApps && !installedApps.includes(app)),
  )) {
    throw new AppError(400, "validation_error", "Choose supported Apps for this grant.");
  }
  return { scopes: SCOPES.filter((scope) => input.scopes.includes(scope)), allowedApps: [...new Set(input.allowedApps)].sort() };
}

function assertSubset(requested: AgentPermissionInput, current: AgentPermissionInput): void {
  if (requested.scopes.some((scope) => !current.scopes.includes(scope))
    || requested.allowedApps.some((app) => !current.allowedApps.includes(app))) {
    throw new AppError(409, "grant_expansion", "The requested permissions exceed the approved scope or Apps.");
  }
}

function assertActive(agent: AgentRow): void {
  if (agent.status !== "active") throw new AppError(409, "agent_revoked", "This Agent has been revoked.");
}

export class AgentIdentityService {
  constructor(private readonly options: AgentIdentityOptions) {}

  async recognizeToken(token: string): Promise<AgentCredential> {
    if (!TOKEN_PATTERN.test(token)) throw unauthorized();
    const tokenHash = hashSecret(token);
    const { rows } = await this.options.database.query<{ id: string }>(
      "SELECT id FROM core.agents WHERE token_hash = $1 AND status = 'active'", [tokenHash],
    );
    if (!rows[0]) throw unauthorized();
    return Object.freeze({ agentId: rows[0].id, tokenHash });
  }

  async authorize(tx: DatabaseContext, credential: AgentCredential, selector?: string): Promise<AgentAuthority> {
    const { rows } = await tx.query<AgentRow>(
      `SELECT ${AGENT_FIELDS} FROM core.agents WHERE id = $1 AND token_hash = $2 AND status = 'active' FOR SHARE`,
      [credential.agentId, credential.tokenHash],
    );
    const agent = rows[0];
    if (!agent) throw unauthorized();
    if (selector !== undefined && !USERNAME_PATTERN.test(selector)) {
      throw new AppError(400, "validation_error", "The acting username is malformed.");
    }

    const candidates = await tx.query<{ id: string; username: string }>(
      `SELECT u.id, u.username FROM core.agent_user_grants g JOIN core.users u ON u.id = g.user_id
       WHERE g.agent_id = $1 AND g.status = 'active' AND u.status = 'active'
         AND (g.expires_at IS NULL OR g.expires_at > $2)
       ORDER BY u.username`,
      [agent.id, this.options.time.now()],
    );
    if (!candidates.rows.length) throw new AppError(403, "no_active_grant", "This Agent has no active user grants.");
    if (selector === undefined && agent.requires_explicit_actor) {
      throw new AppError(400, "acting_user_required", "Choose an acting user for this Agent.", {
        actingUsers: candidates.rows.map((user) => user.username),
      });
    }
    const candidate = candidates.rows.find((user) => selector === undefined
      ? user.id === agent.created_by_user_id
      : user.username === selector);
    if (!candidate) throw new AppError(403, "forbidden", "This Agent cannot act for that user.");

    const user = await lockActiveUser(tx, candidate.id);
    if (!user || (selector !== undefined && selector !== user.username)) {
      throw new AppError(403, "forbidden", "This Agent cannot act for that user.");
    }
    const grant = await this.lockGrant(tx, agent.id, user.id, "SHARE");
    if (!grant || grant.status !== "active" || (grant.expires_at && grant.expires_at <= this.options.time.now())) {
      throw new AppError(403, "forbidden", "This Agent cannot act for that user.");
    }
    return Object.freeze({
      agentId: agent.id, agentName: agent.name, grantId: grant.id, userId: user.id, username: user.username,
      scopes: Object.freeze(grant.scopes), allowedApps: Object.freeze(grant.allowed_apps),
    });
  }

  async recordUse(credential: AgentCredential): Promise<void> {
    const now = this.options.time.now();
    await this.options.database.query(
      `UPDATE core.agents SET last_used_at = $3
       WHERE id = $1 AND token_hash = $2 AND status = 'active'
         AND (last_used_at IS NULL OR last_used_at < $3::timestamptz - interval '1 minute')`,
      [credential.agentId, credential.tokenHash, now],
    );
  }

  async list(request: FastifyRequest): Promise<{ owned: AgentView[]; grants: AgentGrantView[] }> {
    return this.options.database.withTransaction(async (tx) => {
      const user = await this.requireBrowser(tx, cookie(request));
      const owned = await tx.query<AgentRow>(
        `SELECT ${AGENT_FIELDS} FROM core.agents WHERE created_by_user_id = $1 ORDER BY created_at DESC, id`, [user.id],
      );
      const grants = await tx.query<GrantRow & { agent_name: string; agent_status: AgentView["status"]; owner_name: string }>(
        `SELECT g.*, a.name AS agent_name, a.status AS agent_status,
           coalesce(nullif(owner.display_name, ''), owner.username) AS owner_name
         FROM core.agent_user_grants g JOIN core.agents a ON a.id = g.agent_id
         JOIN core.users owner ON owner.id = a.created_by_user_id
         WHERE g.user_id = $1 ORDER BY g.granted_at DESC, g.id`,
        [user.id],
      );
      return {
        owned: owned.rows.map(agentView),
        grants: grants.rows.map((row) => grantView(row, row.agent_name, row.agent_status, row.owner_name)),
      };
    });
  }

  async create(request: FastifyRequest, input: AgentGrantInput & { name: string; description?: string }) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description = input.description === undefined ? "" : input.description;
    if (!name || Array.from(name).length > 64 || name.includes("\0")
      || typeof description !== "string" || description.length > 5000 || description.includes("\0")) {
      throw new AppError(400, "validation_error", "Enter a valid Agent name and description.");
    }
    return this.options.database.withTransaction(async (tx) => {
      const user = await this.requireBrowser(tx, cookie(request));
      const now = this.options.time.now();
      const perms = permissionValues(input, this.options.installedApps());
      const expires = finiteExpiry(input.expiresAt, now);
      const token = randomBytes(32).toString("base64url");
      const { rows } = await tx.query<AgentRow>(
        `INSERT INTO core.agents (id, name, description, created_by_user_id, token_hash, token_prefix, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${AGENT_FIELDS}`,
        [randomUUID(), name, description, user.id, hashSecret(token), token.slice(0, 8), now],
      );
      const agent = rows[0]!;
      const grant = await this.writeGrant(tx, agent.id, user.id, perms, expires, now);
      return { agent: agentView(agent), grant: grantView(grant, agent.name, agent.status, user.displayName || user.username), token };
    });
  }

  async rotateToken(request: FastifyRequest, agentId: string): Promise<{ agent: AgentView; token: string }> {
    return this.options.database.withTransaction(async (tx) => {
      const agent = await this.lockOwnedAgent(tx, request, agentId, "UPDATE");
      assertActive(agent);
      const token = randomBytes(32).toString("base64url");
      const { rows } = await tx.query<AgentRow>(
        `UPDATE core.agents SET token_hash = $2, token_prefix = $3, updated_at = $4
         WHERE id = $1 RETURNING ${AGENT_FIELDS}`,
        [agent.id, hashSecret(token), token.slice(0, 8), this.options.time.now()],
      );
      return { agent: agentView(rows[0]!), token };
    });
  }

  async revokeAgent(request: FastifyRequest, agentId: string): Promise<void> {
    await this.options.database.withTransaction(async (tx) => {
      const agent = await this.lockOwnedAgent(tx, request, agentId, "UPDATE");
      if (agent.status === "revoked") return;
      await tx.query("UPDATE core.agents SET status = 'revoked', updated_at = $2 WHERE id = $1", [agent.id, this.options.time.now()]);
      await tx.query("DELETE FROM core.agent_pairing_requests WHERE agent_id = $1 AND consumed_at IS NULL", [agent.id]);
    });
  }

  async createPairing(request: FastifyRequest, agentId: string, input: AgentPermissionInput) {
    return this.options.database.withTransaction(async (tx) => {
      const agent = await this.lockOwnedAgent(tx, request, agentId, "SHARE");
      assertActive(agent);
      const perms = permissionValues(input, this.options.installedApps());
      const now = this.options.time.now();
      const expires = new Date(now.getTime() + PAIRING_WINDOW_MS);
      const code = randomBytes(24).toString("base64url");
      await tx.query(
        `INSERT INTO core.agent_pairing_requests
           (id, agent_id, code_hash, requested_scopes, requested_apps, created_by_user_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), agent.id, hashSecret(code), perms.scopes, perms.allowedApps, agent.created_by_user_id, expires, now],
      );
      return { code, expiresAt: expires.toISOString() };
    });
  }

  async previewPairing(request: FastifyRequest, code: string) {
    return this.options.database.withTransaction(async (tx) => {
      const { agent, pairing } = await this.lockPairing(tx, request, code, "SHARE");
      return {
        agentId: agent.id, agentName: agent.name, ownerName: await this.ownerName(tx, agent),
        scopes: pairing.requested_scopes, allowedApps: pairing.requested_apps, expiresAt: pairing.expires_at.toISOString(),
      };
    });
  }

  async approvePairing(request: FastifyRequest, code: string, input: AgentGrantInput): Promise<{ grant: AgentGrantView }> {
    return this.options.database.withTransaction(async (tx) => {
      const { agent, pairing, userId } = await this.lockPairing(tx, request, code, "UPDATE");
      const previous = await this.lockGrant(tx, agent.id, userId, "UPDATE");
      const now = this.options.time.now();
      if (pairing.expires_at <= now) throw pairingUnavailable();
      const existingExpired = previous?.expires_at && previous.expires_at <= now ? previous.expires_at.getTime() : -Infinity;
      if (previous?.status === "active" && existingExpired === -Infinity) {
        throw new AppError(409, "grant_already_active", "The current grant is already active.");
      }
      const cutoff = Math.max(previous?.revoked_at?.getTime() ?? -Infinity, existingExpired);
      if (pairing.created_at.getTime() <= cutoff) throw pairingUnavailable();

      const perms = permissionValues(input, this.options.installedApps());
      assertSubset(perms, { scopes: pairing.requested_scopes, allowedApps: pairing.requested_apps });
      const expires = finiteExpiry(input.expiresAt, now);
      await tx.query("UPDATE core.agent_pairing_requests SET consumed_at = $2, consumed_by_user_id = $3 WHERE id = $1",
        [pairing.id, now, userId]);
      const grant = await this.writeGrant(tx, agent.id, userId, perms, expires, now);
      if (userId !== agent.created_by_user_id && !agent.requires_explicit_actor) {
        await tx.query("UPDATE core.agents SET requires_explicit_actor = true, updated_at = $2 WHERE id = $1", [agent.id, now]);
      }
      return { grant: grantView(grant, agent.name, agent.status, await this.ownerName(tx, agent)) };
    });
  }

  async narrowGrant(request: FastifyRequest, grantId: string, patch: Partial<AgentGrantInput>): Promise<{ grant: AgentGrantView }> {
    return this.options.database.withTransaction(async (tx) => {
      const { agent, grant } = await this.lockOwnedGrant(tx, request, grantId);
      const now = this.options.time.now();
      const current = { scopes: grant.scopes, allowedApps: grant.allowed_apps };
      const perms = permissionValues({ scopes: patch.scopes ?? current.scopes, allowedApps: patch.allowedApps ?? current.allowedApps });
      assertSubset(perms, current);
      const expires = patch.expiresAt === undefined ? grant.expires_at : finiteExpiry(patch.expiresAt, now);
      if (grant.expires_at && (!expires || expires > grant.expires_at)) {
        throw new AppError(409, "grant_expansion", "Grant expiry can only be shortened.");
      }
      const { rows } = await tx.query<GrantRow>(
        `UPDATE core.agent_user_grants SET scopes = $2, allowed_apps = $3, expires_at = $4, updated_at = $5
         WHERE id = $1 RETURNING ${GRANT_FIELDS}`,
        [grant.id, perms.scopes, perms.allowedApps, expires, now],
      );
      return { grant: grantView(rows[0]!, agent.name, agent.status, await this.ownerName(tx, agent)) };
    });
  }

  async revokeGrant(request: FastifyRequest, grantId: string): Promise<void> {
    await this.options.database.withTransaction(async (tx) => {
      const { grant } = await this.lockOwnedGrant(tx, request, grantId);
      if (grant.status === "revoked") return;
      const now = this.options.time.now();
      await tx.query("UPDATE core.agent_user_grants SET status = 'revoked', revoked_at = $2, updated_at = $2 WHERE id = $1", [grant.id, now]);
    });
  }

  async audit(request: FastifyRequest, options: { limit?: number; cursor?: string }): Promise<AgentAuditPage> {
    return this.options.database.withTransaction(async (tx) => {
      const user = await this.requireBrowser(tx, cookie(request));
      return readAgentAudit(tx, user.id, options);
    });
  }

  private async requireBrowser(tx: DatabaseContext, session: ReturnType<typeof cookie>) {
    const user = await lockActiveUser(tx, session.user.id);
    if (user) {
      const expires = await lockSessionExpiry(tx, user.id, session.sessionHash);
      if (expires && expires > this.options.time.now()) return user;
    }
    throw unauthorized();
  }

  private async lockAgent(tx: DatabaseContext, agentId: string, mode: "SHARE" | "UPDATE", ownerId?: string) {
    const { rows } = await tx.query<AgentRow>(
      `SELECT ${AGENT_FIELDS} FROM core.agents
       WHERE id = $1 AND ($2::uuid IS NULL OR created_by_user_id = $2) FOR ${mode}`,
      [agentId, ownerId ?? null],
    );
    return rows[0];
  }

  private async lockOwnedAgent(tx: DatabaseContext, request: FastifyRequest, agentId: string, mode: "SHARE" | "UPDATE") {
    const session = cookie(request);
    if (!UUID_PATTERN.test(agentId)) throw notFound();
    const agent = await this.lockAgent(tx, agentId, mode, session.user.id);
    if (!agent) throw notFound();
    await this.requireBrowser(tx, session);
    return agent;
  }

  private async lockGrant(tx: DatabaseContext, agentId: string, userId: string, mode: "SHARE" | "UPDATE") {
    const { rows } = await tx.query<GrantRow>(
      `SELECT ${GRANT_FIELDS} FROM core.agent_user_grants WHERE agent_id = $1 AND user_id = $2 FOR ${mode}`,
      [agentId, userId],
    );
    return rows[0];
  }

  private async lockOwnedGrant(tx: DatabaseContext, request: FastifyRequest, grantId: string) {
    const session = cookie(request);
    if (!UUID_PATTERN.test(grantId)) throw notFound();
    const { rows } = await tx.query<{ agent_id: string }>(
      "SELECT agent_id FROM core.agent_user_grants WHERE id = $1 AND user_id = $2", [grantId, session.user.id],
    );
    if (!rows[0]) throw notFound();
    const agent = await this.lockAgent(tx, rows[0].agent_id, "SHARE");
    if (!agent) throw notFound();
    const user = await this.requireBrowser(tx, session);
    const grant = await this.lockGrant(tx, agent.id, user.id, "UPDATE");
    if (!grant || grant.id !== grantId.toLowerCase()) throw notFound();
    return { agent, grant };
  }

  private async lockPairing(tx: DatabaseContext, request: FastifyRequest, code: string, mode: "SHARE" | "UPDATE") {
    const session = cookie(request);
    if (!CODE_PATTERN.test(code)) throw pairingUnavailable();
    const codeHash = hashSecret(code);
    const candidate = await tx.query<{ agent_id: string }>(
      "SELECT agent_id FROM core.agent_pairing_requests WHERE code_hash = $1", [codeHash],
    );
    if (!candidate.rows[0]) throw pairingUnavailable();
    const agent = await this.lockAgent(tx, candidate.rows[0].agent_id, mode);
    if (!agent || agent.status !== "active") throw pairingUnavailable();
    const user = await this.requireBrowser(tx, session);
    const { rows } = await tx.query<PairingRow>(
      `SELECT id, requested_scopes, requested_apps, expires_at, created_at FROM core.agent_pairing_requests
       WHERE code_hash = $1 AND agent_id = $2 AND created_by_user_id = $3 AND consumed_at IS NULL FOR ${mode}`,
      [codeHash, agent.id, agent.created_by_user_id],
    );
    const pairing = rows[0];
    if (!pairing || pairing.expires_at <= this.options.time.now()) throw pairingUnavailable();
    return { agent, pairing, userId: user.id };
  }

  private async ownerName(tx: DatabaseContext, agent: AgentRow): Promise<string> {
    const { rows } = await tx.query<{ name: string }>(
      "SELECT coalesce(nullif(display_name, ''), username) AS name FROM core.users WHERE id = $1", [agent.created_by_user_id],
    );
    return rows[0]!.name;
  }

  private async writeGrant(
    tx: DatabaseContext, agentId: string, userId: string, perms: AgentPermissionInput, expires: Date | null, now: Date,
  ): Promise<GrantRow> {
    const { rows } = await tx.query<GrantRow>(
      `INSERT INTO core.agent_user_grants
         (id, agent_id, user_id, scopes, allowed_apps, expires_at, granted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (agent_id, user_id) DO UPDATE SET scopes = EXCLUDED.scopes, allowed_apps = EXCLUDED.allowed_apps,
         expires_at = EXCLUDED.expires_at, status = 'active', granted_at = EXCLUDED.granted_at,
         updated_at = EXCLUDED.updated_at, revoked_at = NULL
       RETURNING ${GRANT_FIELDS}`,
      [randomUUID(), agentId, userId, perms.scopes, perms.allowedApps, expires, now],
    );
    return rows[0]!;
  }
}
