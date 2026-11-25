import type { DatabaseContext } from "../database/index.js";
import type { AppEventBus } from "../events/index.js";
import type { Logger } from "../logging/index.js";
import type { AppStorage } from "../storage/index.js";
import type { TimeService } from "../time/index.js";
import type { TrashDraft, TrashMutationContext, TrashPrepareContext } from "../trash/types.js";

export type AgentScope = "read" | "write" | "delete";
export type AgentAction = AgentScope;

export interface AgentCredential {
  readonly agentId: string;
  readonly tokenHash: string;
}

export interface AgentAuthority {
  readonly agentId: string;
  readonly agentName: string;
  readonly grantId: string;
  readonly userId: string;
  readonly username: string;
  readonly scopes: readonly AgentScope[];
  readonly allowedApps: readonly string[];
}

export interface AgentToolDescription {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export interface AgentResourceDescription {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface AgentManifest {
  agent: { id: string; name: string };
  actingUser: { id: string; username: string };
  scopes: readonly AgentScope[];
  apps: Array<{ id: string; name: string; description: string; toolCount: number }>;
  tools: AgentToolDescription[];
  resources: AgentResourceDescription[];
}

export type AgentResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: { code: string; message: string; details?: unknown } };

export interface AgentResourceValue {
  uri: string;
  mimeType: string;
  text: string;
}

export interface AppAgentInvocation extends TrashPrepareContext {
  readonly time: TimeService;
  readonly log: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly storage: AppStorage;
  readonly events: Pick<AppEventBus, "publish">;
  /** Supplied only to a Core-authorized delete on the mutation transaction. */
  readonly trash?: TrashMutationContext;
}

export type AgentArguments = Record<string, unknown>;

export interface AppAgentTool extends AgentToolDescription {
  action: AgentAction;
  scopes: readonly AgentScope[];
  /** The catalog adds the required UUID idempotency key to a create schema. */
  create?: boolean;
  prepareDelete?(ctx: AppAgentInvocation, args: AgentArguments): Promise<TrashDraft>;
  execute(ctx: AppAgentInvocation, args: AgentArguments): Promise<{ data: unknown; resourceId?: string }>;
}

export interface AppAgentResource extends AgentResourceDescription {
  read(ctx: AppAgentInvocation): Promise<unknown>;
}

export interface AppAgentContext {
  tool(definition: AppAgentTool): void;
  resource(definition: AppAgentResource): void;
  overview(provider: (ctx: AppAgentInvocation) => Promise<unknown>): void;
}
