import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../api/errors.js";
import type { AppRecord } from "../app-registry/types.js";
import { CapabilityError } from "../app-registry/context.js";
import { canonicalJson } from "../data-management/incremental.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { Logger } from "../logging/index.js";
import { withAttachmentGuard } from "../storage/attachment-guard.js";
import type { TimeService } from "../time/index.js";
import type { TrashBlobScope, TrashBlobStore } from "../trash/blobs.js";
import type { TrashService } from "../trash/service.js";
import type { TrashMutationContext } from "../trash/types.js";
import { insertAgentAudit, type AgentAuditInput } from "./audit.js";
import type { AgentCatalog, ListedAgentTool, PublishedAgentApp } from "./catalog.js";
import { agentDatastoreError } from "./errors.js";
import type { AgentIdentityService } from "./identity.js";
import type {
  AgentArguments, AgentAuthority, AgentCredential, AgentManifest, AgentResourceValue,
  AgentResult, AppAgentInvocation, AgentToolDescription,
} from "./types.js";

const APP_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false } as const;
const PLATFORM_TOOLS: AgentToolDescription[] = [
  { name: "platform_status", description: "Get platform time and the authenticated Agent and acting user.", inputSchema: APP_ARGUMENTS },
  { name: "platform_list_apps", description: "List enabled Apps and their available Agent tools.", inputSchema: APP_ARGUMENTS },
  { name: "platform_overview", description: "Get a concise overview of permitted Apps.", inputSchema: APP_ARGUMENTS },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true } }));
const PLATFORM_RESOURCES = [
  { uri: "pp://platform/apps", name: "Installed Apps", mimeType: "application/json", toolName: "platform_list_apps" },
  { uri: "pp://platform/overview", name: "Platform overview", mimeType: "application/json", toolName: "platform_overview" },
];

interface AgentGatewayOptions {
  database: Database;
  time: TimeService;
  log: Logger;
  identity: Pick<AgentIdentityService, "recognizeToken" | "authorize" | "recordUse">;
  catalog: AgentCatalog;
  apps(): AppRecord[];
  hasAgentHook(appId: string): boolean;
  platform: { name: string; environment: string };
  trash: TrashService;
  blobs: TrashBlobStore;
}

interface ReceiptKey {
  grantId: string;
  toolName: string;
  key: string;
  fingerprint: string;
}

interface PreparedDelete {
  scope: TrashBlobScope;
  generation: symbol;
  intentId?: string;
  entityId: string;
  entityType: string;
}

interface AuditSubject {
  authority: AgentAuthority;
  appId: string;
  toolName: string;
  actionKind: AgentAuditInput["actionKind"];
}

function forbidden(): AppError {
  return new AppError(403, "forbidden", "This grant does not permit that operation.");
}

function unavailable(): AppError {
  return new AppError(404, "tool_not_found", "The Agent tool is unavailable.");
}

function outcomeUnknown(): AppError {
  return new AppError(503, "outcome_unknown", "The commit could not be confirmed. Review the current state before retrying.");
}

function receiptFor(authorization: AgentAuthority, tool: ListedAgentTool, args: AgentArguments): ReceiptKey {
  const { idempotencyKey, ...operationArguments } = args;
  return {
    grantId: authorization.grantId,
    toolName: tool.public.name,
    key: String(idempotencyKey).toLowerCase(),
    fingerprint: createHash("sha256").update(canonicalJson(operationArguments)).digest("hex"),
  };
}

async function readReceipt(tx: DatabaseContext, receipt: ReceiptKey): Promise<string | undefined> {
  const identity = JSON.stringify(["agent-create", receipt.grantId, receipt.toolName, receipt.key]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identity]);
  const { rows } = await tx.query<{ entity_id: string; fingerprint: string }>(
    "SELECT entity_id, fingerprint FROM core.agent_create_receipts WHERE grant_id = $1 AND tool_name = $2 AND idempotency_key = $3",
    [receipt.grantId, receipt.toolName, receipt.key],
  );
  const saved = rows[0];
  if (!saved) return undefined;
  if (saved.fingerprint !== receipt.fingerprint) {
    throw new AppError(409, "idempotency_conflict", "This idempotency key was already used with different arguments.");
  }
  return saved.entity_id;
}

async function saveReceipt(tx: DatabaseContext, receipt: ReceiptKey, entityId: string, now: Date): Promise<void> {
  await tx.query(
    `INSERT INTO core.agent_create_receipts (grant_id, tool_name, idempotency_key, fingerprint, entity_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [receipt.grantId, receipt.toolName, receipt.key, receipt.fingerprint, entityId, now],
  );
}

export class AgentGateway {
  constructor(private readonly options: AgentGatewayOptions) {}

  authenticate(token: string): Promise<AgentCredential> {
    return this.options.identity.recognizeToken(token);
  }

  async manifest(credential: AgentCredential, selector?: string): Promise<AgentManifest> {
    const manifest = await this.transaction(false, async tx => {
      const authority = await this.options.identity.authorize(tx, credential, selector);
      const available = this.visibleApps(authority);
      const tools = available.flatMap(app => this.toolsOf(app.id, authority).map(tool => tool.public));
      const canRead = authority.scopes.includes("read");
      const resources = canRead ? [
        ...PLATFORM_RESOURCES.map(({ toolName: _toolName, ...resource }) => resource),
        ...available.flatMap(app => [...this.options.catalog.get(app.id)?.resources.values() ?? []].map(resource => resource.public)),
      ] : [];
      return {
        agent: { id: authority.agentId, name: authority.agentName },
        actingUser: { id: authority.userId, username: authority.username },
        scopes: authority.scopes, apps: available,
        tools: [...canRead ? PLATFORM_TOOLS : [], ...tools].sort((a, b) => a.name.localeCompare(b.name)),
        resources: resources.sort((a, b) => a.uri.localeCompare(b.uri)),
      };
    });
    this.noteUse(credential);
    return manifest;
  }

  async resource(credential: AgentCredential, selector: string | undefined, uri: string): Promise<AgentResourceValue> {
    const output = await this.transaction(uri === "pp://platform/overview" || uri.startsWith("pp://apps/assets/"), async tx => {
      const authority = await this.options.identity.authorize(tx, credential, selector);
      if (!authority.scopes.includes("read")) throw forbidden();
      const platform = PLATFORM_RESOURCES.find(resource => resource.uri === uri);
      if (platform) {
        const data = await this.platformTool(platform.toolName, authority, tx);
        return { uri, mimeType: platform.mimeType, text: JSON.stringify(data) };
      }
      const registered = this.options.catalog.all().find(app => app.resources.has(uri));
      const app = registered && this.available(registered.id);
      const resource = app?.resources.get(uri);
      if (!app || !resource) throw new AppError(404, "resource_not_found", "The Agent resource is unavailable.");
      if (!authority.allowedApps.includes(app.id)) throw forbidden();
      const data = await resource.definition.read(this.context(app, authority.userId, tx));
      const mimeType = resource.public.mimeType ?? "application/json";
      return { uri, mimeType, text: typeof data === "string" && mimeType !== "application/json" ? data : JSON.stringify(data) ?? "null" };
    });
    this.noteUse(credential);
    return output;
  }

  async invoke(
    credential: AgentCredential,
    selector: string | undefined,
    name: string,
    input: unknown,
    onAdmitted?: () => void,
  ): Promise<AgentResult> {
    let authorizedDomain = false;
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      onAdmitted?.();
    };
    let subject: AuditSubject | undefined;
    let receipt: ReceiptKey | undefined;
    let completion: { data: unknown; events: Array<() => void> } | undefined;
    const setSubject = (authority: AgentAuthority, app: PublishedAgentApp, tool: ListedAgentTool) => {
      const action = tool.definition.action;
      if (action !== "read") subject = { authority, appId: app.id, toolName: name, actionKind: action };
    };
    try {
      const observed = this.options.catalog.all().find(app => app.tools.has(name))?.tools.get(name);
      const prepared = observed?.definition.prepareDelete
        ? await this.prepareDelete(credential, selector, name, input, setSubject, () => {
          authorizedDomain = true;
        })
        : undefined;
      subject = undefined;
      authorizedDomain = false;
      const run = async (tx: DatabaseContext) => {
        const authority = await this.options.identity.authorize(tx, credential, selector);
        if (PLATFORM_TOOLS.some(tool => tool.name === name)) {
          if (!authority.scopes.includes("read")) throw forbidden();
          authorizedDomain = true;
          if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) {
            throw new AppError(422, "invalid_arguments", "This tool accepts an empty argument object.");
          }
          announce();
          return { data: await this.platformTool(name, authority, tx), events: [] };
        }
        const { app, tool } = this.findTool(name);
        setSubject(authority, app, tool);
        this.assertPermitted(authority, app.id, tool);
        if (prepared && (prepared.scope.userId !== authority.userId || prepared.generation !== app.generation)) {
          throw new AppError(409, "admission_changed", "The acting user or App changed during preparation. Review and retry.");
        }
        if (tool.definition.prepareDelete && !prepared) throw unavailable();
        authorizedDomain = true;
        const args = tool.arguments(input);
        const events: Array<() => void> = [];
        const scope = prepared?.scope ?? { userId: authority.userId, appId: app.id, trashId: randomUUID() };
        const intent = prepared?.intentId ? await this.options.blobs.lockIntent(tx, scope, prepared.intentId, "delete") : undefined;
        const execute = (trash?: TrashMutationContext) => tool.definition.execute(this.context(app, authority.userId, tx, events, trash), args);
        announce();
        receipt = tool.definition.create ? receiptFor(authority, tool, args) : undefined;
        const priorId = receipt ? await readReceipt(tx, receipt) : undefined;
        if (priorId) {
          await this.audit(tx, subject!, "replayed", priorId);
          receipt = undefined;
          return completion = { data: { id: priorId }, events };
        }

        const result = tool.definition.action === "delete"
          ? await this.options.trash.runMutation(tx, scope, { type: "agent", id: authority.agentId, label: authority.agentName },
            mutation => execute(prepared ? {
              ...mutation,
              moveToTrash: draft => {
                if (draft.entityId !== prepared.entityId || draft.entityType !== prepared.entityType) {
                  throw new AppError(409, "trash_source_changed", "The attachment sources changed. Reload and retry.");
                }
                return mutation.moveToTrash(draft);
              },
            } : mutation), intent)
          : tool.definition.action === "read"
            ? await tool.definition.execute(this.context(app, authority.userId, tx), args)
            : await execute();
        if (receipt) {
          if (!result.resourceId) throw new Error("Agent create did not return its new ID");
          await saveReceipt(tx, receipt, result.resourceId, this.options.time.now());
        }
        if (subject) {
          await this.audit(tx, subject, "ok", result.resourceId);
          return completion = { data: receipt ? { id: result.resourceId } : result.data, events };
        }
        return { data: result.data, events };
      };
      const output = prepared
        ? await this.options.trash.runAttachmentMutation(prepared.intentId, tx => this.bound(tx, run))
        : await this.transaction(name === "platform_overview" || name.startsWith("assets_"), run);
      this.publish(output.events, name);
      this.noteUse(credential);
      return { ok: true, data: output.data };
    } catch (error) {
      if (authorizedDomain) announce();
      const retryable = agentDatastoreError(error);
      if (retryable) completion = undefined;
      error = retryable ?? error;
      if (completion) {
        if (receipt) {
          const id = await this.transaction(false, tx => readReceipt(tx, receipt!)).catch(() => undefined);
          if (id && (completion.data as { id?: string }).id === id) {
            this.publish(completion.events, name);
            this.noteUse(credential);
            return { ok: true, data: completion.data };
          }
        }
        error = outcomeUnknown();
      } else if (subject) {
        const action = subject;
        const status = error instanceof AppError && error.code === "conflict" ? "conflict"
          : error instanceof AppError && error.statusCode === 403 ? "denied" : "error";
        await this.transaction(false, tx => this.audit(tx, action, status, undefined,
          error instanceof AppError ? error.code : "internal_error")).catch(() => {
          this.options.log.warn({ toolName: action.toolName }, "Agent failure audit could not be recorded");
        });
      }
      return this.failure(error);
    }
  }

  private async prepareDelete(
    credential: AgentCredential,
    selector: string | undefined,
    name: string,
    input: unknown,
    setSubject: (authority: AgentAuthority, app: PublishedAgentApp, tool: ListedAgentTool) => void,
    onAuthorized: () => void,
  ): Promise<PreparedDelete> {
    return this.transaction(true, async tx => {
      const authority = await this.options.identity.authorize(tx, credential, selector);
      const { app, tool } = this.findTool(name);
      setSubject(authority, app, tool);
      this.assertPermitted(authority, app.id, tool);
      const prepare = tool.definition.prepareDelete;
      if (!prepare) throw unavailable();
      onAuthorized();
      const draft = await prepare(this.context(app, authority.userId, tx), tool.arguments(input));
      const scope = { userId: authority.userId, appId: app.id, trashId: randomUUID() };
      const intentId = await this.options.blobs.prepareDelete(tx, scope, draft.attachments ?? []);
      return { scope, generation: app.generation, intentId, entityId: draft.entityId, entityType: draft.entityType };
    });
  }

  private transaction<T>(guardAttachments: boolean, work: (tx: DatabaseContext) => Promise<T>): Promise<T> {
    const run = (tx: DatabaseContext) => this.bound(tx, work);
    return guardAttachments ? withAttachmentGuard(this.options.database, "shared", run) : this.options.database.withTransaction(run);
  }

  private async bound<T>(tx: DatabaseContext, work: (tx: DatabaseContext) => Promise<T>): Promise<T> {
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL transaction_timeout = '20s'");
    return work(tx);
  }

  private available(appId: string): PublishedAgentApp | undefined {
    return this.options.apps().some(record => record.id === appId && record.status === "enabled")
      ? this.options.catalog.get(appId) : undefined;
  }

  private findTool(name: string): { app: PublishedAgentApp; tool: ListedAgentTool } {
    for (const catalog of this.options.catalog.all()) {
      const app = this.available(catalog.id);
      const tool = app?.tools.get(name);
      if (app && tool) return { app, tool };
    }
    throw unavailable();
  }

  private assertPermitted(authority: AgentAuthority, appId: string, tool: ListedAgentTool): void {
    if (!authority.allowedApps.includes(appId) || !tool.definition.scopes.every(scope => authority.scopes.includes(scope))) {
      throw forbidden();
    }
  }

  private toolsOf(appId: string, authority: AgentAuthority): ListedAgentTool[] {
    return [...this.available(appId)?.tools.values() ?? []].filter(tool =>
      tool.definition.scopes.every(scope => authority.scopes.includes(scope)));
  }

  private visibleApps(authority: AgentAuthority): AgentManifest["apps"] {
    return this.options.apps()
      .filter(app => app.status === "enabled" && authority.allowedApps.includes(app.id)
        && (!this.options.hasAgentHook(app.id) || this.options.catalog.get(app.id)))
      .map(app => ({ id: app.id, name: app.name, description: app.description, toolCount: this.toolsOf(app.id, authority).length }));
  }

  private async platformTool(name: string, authority: AgentAuthority, tx: DatabaseContext): Promise<unknown> {
    if (name === "platform_status") {
      return { ...this.options.platform, timezone: this.options.time.timezone(), serverTime: this.options.time.now().toISOString(),
        agent: { id: authority.agentId, name: authority.agentName }, actingUser: { id: authority.userId, username: authority.username } };
    }
    const apps = this.visibleApps(authority);
    if (name === "platform_list_apps") return { items: apps };
    const overview: Record<string, unknown> = {};
    for (const record of apps) {
      const app = this.available(record.id);
      if (app?.overview) overview[record.id] = await app.overview(this.context(app, authority.userId, tx));
    }
    return overview;
  }

  private context(app: PublishedAgentApp, userId: string, tx: DatabaseContext, events?: Array<() => void>, trash?: TrashMutationContext): AppAgentInvocation {
    const { context, capabilities } = app;
    return {
      userId, database: capabilities.database ? tx : context.database,
      time: context.time, log: context.log, config: context.config, storage: context.storage, trash,
      events: {
        publish: (type, payload) => {
          if (!events || !capabilities.events) throw new CapabilityError(app.id, "events");
          events.push(() => context.events.publish(type, payload, app.id));
        },
      },
    };
  }

  private audit(tx: DatabaseContext, subject: AuditSubject, status: AgentAuditInput["status"], resourceId?: string, errorCode?: string): Promise<void> {
    return insertAgentAudit(tx, subject.authority, {
      appId: subject.appId, toolName: subject.toolName, actionKind: subject.actionKind, status, resourceId, errorCode,
      createdAt: this.options.time.now(),
    });
  }

  private publish(events: Array<() => void>, toolName: string): void {
    for (const deliver of events) {
      try { deliver(); }
      catch { this.options.log.warn({ toolName }, "Agent post-commit event delivery failed"); }
    }
  }

  private noteUse(credential: AgentCredential): void {
    void this.options.identity.recordUse(credential).catch(() =>
      this.options.log.warn({ agentId: credential.agentId }, "Agent last-used time update failed"));
  }

  private failure(error: unknown): AgentResult {
    if (error instanceof AppError) return {
      ok: false, status: error.statusCode, error: { code: error.code, message: error.message, details: error.details },
    };
    this.options.log.error("Agent tool execution failed");
    return { ok: false, status: 500, error: { code: "internal_error", message: "The Agent operation failed." } };
  }
}
