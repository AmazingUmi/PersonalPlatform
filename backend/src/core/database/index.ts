import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Logger } from "../logging/index.js";

const { Pool, types } = pg;

// DATE columns must cross the API as plain YYYY-MM-DD strings; pg's default
// Date-object parsing shifts the calendar day depending on the server timezone.
types.setTypeParser(1082, (value: string) => value);

export interface DatabaseContext {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  withTransaction<T>(fn: (tx: DatabaseContext) => Promise<T>): Promise<T>;
}

export interface DatabasePoolOptions {
  /** Shared by all Apps and users; unrelated to PostgreSQL max_connections. */
  max?: number;
}

function validatePoolMax(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 100");
  }
  return value;
}

/** Startup-only parsing; constructors never implicitly read process.env. */
export function resolveDatabasePoolMax(env: Record<string, string | undefined>): number {
  const raw = env.DATABASE_POOL_MAX;
  if (raw === undefined) return 10;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 100");
  }
  return validatePoolMax(Number(raw));
}

/**
 * Single shared PostgreSQL pool owned by Core. Apps receive a `DatabaseContext`
 * and never construct their own connections.
 */
export class Database {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly log?: Logger,
    options: DatabasePoolOptions = {},
  ) {
    this.pool = new Pool({ connectionString, max: validatePoolMax(options.max ?? 10) });
  }

  async connect(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch (error) {
      this.log?.error({ error }, "database ping failed");
      return false;
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query(text, params);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  context(): DatabaseContext {
    return {
      query: (text, params) => this.pool.query(text, params),
      withTransaction: (fn) => this.withTransaction(fn),
    };
  }

  async withTransaction<T>(fn: (tx: DatabaseContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: DatabaseContext = {
      query: (text, params) => client.query(text, params),
      withTransaction: (inner) => inner(tx),
    };
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Advanced escape hatch; apps must use the provided DatabaseContext instead. */
  getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }
}
