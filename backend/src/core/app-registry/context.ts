import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadAppConfig } from "../config/index.js";
import type { Database, DatabaseContext } from "../database/index.js";
import type { EventBus } from "../events/index.js";
import type { Logger } from "../logging/index.js";
import type { Scheduler } from "../scheduler/index.js";
import { createLocalStorage } from "../storage/local.js";
import type { AppContext } from "./types.js";

function unavailableDatabase(): DatabaseContext {
  const fail = async (): Promise<never> => {
    throw new Error("database is not available in this runtime");
  };
  return {
    query: fail,
    withTransaction: async () => {
      throw new Error("database is not available in this runtime");
    },
  };
}

export interface CreateAppContextOptions {
  appId: string;
  api: FastifyInstance;
  log: Logger;
  database: Database | null;
  storageRoot: string;
  events: EventBus;
  scheduler: Scheduler;
}

/** Build the controlled surface handed to an App at startup. */
export function createAppContext(options: CreateAppContextOptions): AppContext {
  return {
    appId: options.appId,
    config: loadAppConfig(options.appId),
    log: options.log.child({ app: options.appId }),
    api: options.api,
    database: options.database ? options.database.context() : unavailableDatabase(),
    storage: createLocalStorage(join(options.storageRoot, "apps", options.appId)),
    events: options.events,
    scheduler: options.scheduler,
  };
}
