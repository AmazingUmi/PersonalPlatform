import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Logger } from "../logging/index.js";

const { Pool } = pg;

export interface DatabaseContext {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  withTransaction<T>(fn: (tx: DatabaseContext) => Promise<T>): Promise<T>;
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
  ) {
    this.pool = new Pool({ connectionString, max: 10 });
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
