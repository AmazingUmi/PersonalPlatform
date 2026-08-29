import type { FastifyInstance } from "fastify";
import type { Logger } from "../logging/index.js";
import type { DatabaseContext } from "../database/index.js";
import type { Storage } from "../storage/index.js";
import type { AppEventBus, Unsubscribe } from "../events/index.js";
import type { AppScheduler, JobHandle } from "../scheduler/index.js";
import type { TimeService } from "../time/index.js";

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

/**
 * "installed" is kept only for API/type compatibility. Since apps are compiled
 * into the backend and the frontend ships every route, an app is always
 * runnable once present — Core never produces "installed" anymore; business
 * logic must not depend on it (FP-9.4).
 */
export type AppStatus = "installed" | "enabled" | "disabled" | "error";

export interface AppHealth {
  status: "ok" | "degraded" | "error";
  checks: Record<string, { status: "ok" | "error"; message?: string }>;
}

/**
 * The controlled surface an App receives. It exposes shared infrastructure but
 * never another App's repository or schema.
 *
 * Services a manifest does not grant are still present on the context (API
 * ergonomics stay uniform) but backed by facades that throw a CapabilityError
 * on use (FP-9.5). Events and jobs registered here are owner-tagged with the
 * appId so Core can reclaim them even after a failed activation (FP-9.1).
 */
export interface AppContext {
  appId: string;
  config: Record<string, unknown>;
  log: Logger;
  /** Fastify instance already scoped to `/api/apps/<app_id>`. */
  api: FastifyInstance;
  database: DatabaseContext;
  storage: Storage;
  events: AppEventBus;
  scheduler: AppScheduler;
  /** Platform time semantics; follows the platform timezone (FP-10). */
  time: TimeService;
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
