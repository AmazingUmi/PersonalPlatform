import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../api/errors.js";
import { loadAppConfig } from "../config/index.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { AppEventBus, EventBus } from "../events/index.js";
import type { Logger } from "../logging/index.js";
import type { AppScheduler, Scheduler } from "../scheduler/index.js";
import type { TimeService } from "../time/index.js";
import { createAppStorage } from "../storage/local.js";
import type { AppStorage } from "../storage/index.js";
import type { AppContext, AuthService, ManifestCapabilities } from "./types.js";

/** Raised when an App uses a service its manifest did not declare (FP-9.5). */
export class CapabilityError extends Error {
  constructor(appId: string, capability: keyof ManifestCapabilities) {
    super(`capability '${capability}' is not granted to app '${appId}' (declare it in the app manifest)`);
    this.name = "CapabilityError";
  }
}

export interface CreateAppContextOptions {
  appId: string;
  api: FastifyInstance;
  log: Logger;
  database: Database | null;
  storageRoot: string;
  events: EventBus;
  scheduler: Scheduler;
  time: TimeService;
  /** Manifest-declared capabilities gate which services actually work. */
  capabilities: ManifestCapabilities;
}

/** Build the controlled surface handed to an App at startup. */
export function createAppContext(options: CreateAppContextOptions): AppContext {
  const { appId, capabilities } = options;

  const unavailableDatabase = (): DatabaseContext => ({
    query: async () => {
      throw new CapabilityError(appId, "database");
    },
    withTransaction: async () => {
      throw new CapabilityError(appId, "database");
    },
  });

  const unavailableStorage = (): AppStorage => ({
    save: async () => {
      throw new CapabilityError(appId, "storage");
    },
    read: async () => {
      throw new CapabilityError(appId, "storage");
    },
    delete: async () => {
      throw new CapabilityError(appId, "storage");
    },
    list: async () => {
      throw new CapabilityError(appId, "storage");
    },
    exists: async () => {
      throw new CapabilityError(appId, "storage");
    },
    forUser: () => {
      throw new CapabilityError(appId, "storage");
    },
  });

  const unavailableEvents = (): AppEventBus => ({
    publish: () => {
      throw new CapabilityError(appId, "events");
    },
    subscribe: () => {
      throw new CapabilityError(appId, "events");
    },
  });

  const unavailableScheduler = (): AppScheduler => ({
    register: () => {
      throw new CapabilityError(appId, "scheduler");
    },
  });

  // Identity accessor over the guard's per-request decoration (AUTH-2). Apps
  // never see cookies or the session store through this surface.
  const auth: AuthService = {
    user: async (request: FastifyRequest) => request.user ?? null,
    requireUser: async (request: FastifyRequest) => {
      if (!request.user) throw new AppError(401, "unauthorized", "authentication required");
      return request.user;
    },
    requireRole: async (request: FastifyRequest, role: "admin") => {
      if (!request.user) throw new AppError(401, "unauthorized", "authentication required");
      if (request.user.role !== role) throw new AppError(403, "forbidden", `${role} role required`);
      return request.user;
    },
  };

  return {
    appId,
    config: loadAppConfig(appId),
    log: options.log.child({ app: appId }),
    api: options.api,
    database:
      capabilities.database && options.database
        ? options.database.context()
        : unavailableDatabase(),
    storage: capabilities.storage
      ? createAppStorage(options.storageRoot, appId)
      : unavailableStorage(),
    events: capabilities.events ? options.events.forApp(appId) : unavailableEvents(),
    scheduler: capabilities.scheduler ? options.scheduler.forApp(appId) : unavailableScheduler(),
    time: options.time,
    auth,
  };
}
