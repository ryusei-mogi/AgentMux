import { DatabaseSync } from 'node:sqlite';
import type { DbAdapter, DbStatement, DbValue } from './db.js';

export function createNodeSqliteAdapter(path: string): DbAdapter {
  return new NodeSqliteAdapter(path);
}

export function createNodeSqliteUsageStoreAdapter(path: string): DbAdapter {
  return createNodeSqliteAdapter(path);
}

class NodeSqliteAdapter implements DbAdapter {
  private db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  prepare(sql: string): DbStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `agentmux_tx_${this.transactionDepth}`;
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.transactionDepth = 1;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}

class NodeSqliteStatement implements DbStatement {
  constructor(private readonly statement: ReturnType<DatabaseSync['prepare']>) {}

  run(...params: DbValue[]): unknown {
    return this.statement.run(...params);
  }

  get(...params: DbValue[]): Record<string, unknown> | undefined {
    return this.statement.get(...params) as Record<string, unknown> | undefined;
  }

  all(...params: DbValue[]): Array<Record<string, unknown>> {
    return this.statement.all(...params) as Array<Record<string, unknown>>;
  }
}
