import { join, resolve } from "node:path";
import { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";

/**
 * Integration tests run against a dedicated local database. Provide
 * TEST_DATABASE_URL to point elsewhere (CI sets a PostgreSQL service).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://personal_platform:change-me-for-local-development@127.0.0.1:5439/personal_platform_test";

export const APP_SCHEMAS = ["assets", "focus", "mini_game", "notes", "tasks"];

/** Every schema PersonalPlatform itself owns in the test database. */
export const PLATFORM_SCHEMAS = ["core", ...APP_SCHEMAS];

/**
 * Temporary schemas created by the current test file (e.g. fixture app ids
 * that ship migrations). Register them at module scope so this file's
 * resetDatabase() also drops leftovers from a previous run of itself.
 */
const testSchemas = new Set<string>();

export function registerTestSchemas(...names: string[]): void {
  for (const name of names) testSchemas.add(name);
}

/**
 * Hard safety guard: system schemas are never droppable, no matter how the
 * allowlist was populated. A superuser connection (like CI's POSTGRES_USER)
 * sees pg_toast & friends in information_schema.schemata, and PostgreSQL
 * refuses to drop them — reset must never even attempt it.
 */
function isDroppableSchema(name: string): boolean {
  return !name.startsWith("pg_") && name !== "information_schema" && name !== "public";
}

/** The deterministic set of schemas resetDatabase() may drop. */
export function droppableSchemas(): string[] {
  return [...new Set([...PLATFORM_SCHEMAS, ...testSchemas])].filter(isDroppableSchema).sort();
}

/**
 * Reset to a clean slate: drop only explicitly allowlisted schemas (never a
 * system schema, never unrelated schemas that happen to exist in the
 * database), then re-apply core migrations.
 */
export async function resetDatabase(): Promise<Database> {
  const db = new Database(TEST_DATABASE_URL);
  try {
    const ctx = db.context();
    for (const schema of droppableSchemas()) {
      await ctx.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    // backend/test/helpers -> repository root is three levels up.
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      targets: [{ scope: "core", schema: "core", dir: join(repoRoot, "migrations", "core") }],
    });
    return db;
  } catch (error) {
    // A failed reset must not leak the pool: the open keep-alive sockets
    // would hang the test process and mask the real failure.
    await db.close().catch(() => undefined);
    throw error;
  }
}
