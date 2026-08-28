import type { FastifyInstance } from "fastify";
import type { Logger } from "../logging/index.js";
import type { DatabaseContext } from "../database/index.js";
import type { Storage } from "../storage/index.js";
import type { EventBus, Unsubscribe } from "../events/index.js";
import type { JobHandle, Scheduler } from "../scheduler/index.js";

export interface ManifestWidget {
  id: string;
  name: string;
}

export interface ManifestCapabilities {
  database: boolean;
  storage: boolean;
  scheduler: boolean;
  events: boolean;
}

export interface AppManifest {
  manifest_version: number;
  id: string;
  name: string;
  version: string;
  description: string;
  default_enabled: boolean;
  frontend: { route: string };
  widgets: ManifestWidget[];
  capabilities: ManifestCapabilities;
}

export type AppStatus = "installed" | "enabled" | "disabled" | "error";

export interface AppHealth {
  status: "ok" | "degraded" | "error";
  checks: Record<string, { status: "ok" | "error"; message?: string }>;
}

/**
 * The controlled surface an App receives. It exposes shared infrastructure but
 * never another App's repository or schema.
 */
export interface AppContext {
  appId: string;
  config: Record<string, unknown>;
  log: Logger;
  /** Fastify instance already scoped to `/api/apps/<app_id>`. */
  api: FastifyInstance;
  database: DatabaseContext;
  storage: Storage;
  events: EventBus;
  scheduler: Scheduler;
}

export interface BackendAppModule {
  id: string;
  registerApi(ctx: AppContext): Promise<void>;
  registerEvents?(ctx: AppContext): Promise<Unsubscribe[]>;
  registerJobs?(ctx: AppContext): Promise<JobHandle[]>;
  healthcheck?(ctx: AppContext): Promise<AppHealth>;
}

/** Public representation of an App returned by Core APIs. */
export interface AppRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  status: AppStatus;
  enabled: boolean;
  defaultEnabled: boolean;
  errorMessage?: string;
  route: string;
  capabilities: ManifestCapabilities;
  widgets: ManifestWidget[];
  hasBackend: boolean;
  hasFrontend: boolean;
}
