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

export const APP_SCHEMAS = ["assets", "tasks", "mini_game"];

/** Drop every non-system schema and re-apply core migrations for a clean slate. */
export async function resetDatabase(): Promise<Database> {
  const db = new Database(TEST_DATABASE_URL);
  const ctx = db.context();
  const { rows } = await ctx.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'public')`,
  );
  for (const row of rows) {
    await ctx.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
  }
  // backend/test/helpers -> repository root is three levels up.
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "core", schema: "core", dir: join(repoRoot, "migrations", "core") }],
  });
  return db;
}
