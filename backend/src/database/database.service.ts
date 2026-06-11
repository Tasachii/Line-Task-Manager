import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';

// Parse DATE (OID 1082) as a plain 'YYYY-MM-DD' string to avoid timezone shifts during serialization.
types.setTypeParser(types.builtins.DATE, (v) => v);

// A query function scoped to a single connection (used inside a transaction).
export type Query = <T extends QueryResultRow = any>(sql: string, params?: any[]) => Promise<T[]>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  // Thin query helper (auto-checkout from the pool, one statement).
  async query<T extends QueryResultRow = any>(sql: string, params: any[] = []) {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  // Runs `fn` inside a single transaction on one dedicated connection.
  // Commits on success, rolls back on any error. Use for multi-statement writes
  // that must be atomic (e.g. position renumbering) and with pg_advisory_xact_lock
  // to serialize concurrent writers on the same Kanban column.
  async withTransaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const q: Query = async (sql, params = []) => (await client.query(sql, params)).rows as any;
    try {
      await client.query('BEGIN');
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
