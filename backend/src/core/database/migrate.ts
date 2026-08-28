import { runner } from "node-pg-migrate";
import type { Logger } from "../logging/index.js";

export interface MigrationTarget {
  /** Scope label used in logs and errors (e.g. "core" or an app id). */
  scope: string;
  /** PostgreSQL schema the migrations run against. */
  schema: string;
  /** Absolute directory containing migration files. */
  dir: string;
}

export class MigrationError extends Error {
  constructor(
    public readonly scope: string,
    public readonly cause: unknown,
  ) {
    super(
      `migration failed for scope '${scope}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "MigrationError";
  }
}

function toPgMigrateLogger(log?: Logger) {
  return {
    debug: (msg: string) => log?.debug({ migration: msg }),
    info: (msg: string) => log?.info({ migration: msg }),
    warn: (msg: string) => log?.warn({ migration: msg }),
    error: (msg: string) => log?.error({ migration: msg }),
  };
}

/**
 * Run migrations for every target in order. Each target uses its own schema and
 * migration-record table, keeping Core and App migrations fully isolated.
 * node-pg-migrate takes a PostgreSQL advisory lock per run; a failure aborts
 * with the failing scope.
 */
export async function runMigrations(options: {
  databaseUrl: string;
  targets: MigrationTarget[];
  log?: Logger;
}): Promise<void> {
  for (const target of options.targets) {
    options.log?.info({ scope: target.scope, dir: target.dir }, "running migrations");
    try {
      await runner({
        databaseUrl: options.databaseUrl,
        dir: target.dir,
        direction: "up",
        schema: target.schema,
        migrationsTable: "migrations",
        createSchema: true,
        createMigrationsSchema: true,
        singleTransaction: true,
        checkOrder: true,
        logger: toPgMigrateLogger(options.log),
      });
    } catch (error) {
      throw new MigrationError(target.scope, error);
    }
  }
}

/** Applied migration names for one scope, from its own migrations table. */
export async function appliedMigrations(
  databaseUrl: string,
  schema: string,
): Promise<string[]> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      `SELECT name FROM ${schema}.migrations ORDER BY name`,
    );
    return result.rows.map((row) => row.name);
  } finally {
    await client.end();
  }
}
