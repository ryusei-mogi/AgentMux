import { createRequire } from 'node:module';
import { ensureParentDir } from './paths.js';
import type { UpstreamRuntimeState, UpstreamStats, UsageRecordInput } from './types.js';
import type BetterSqlite3 from 'better-sqlite3';

export type DbValue = string | number | bigint | Uint8Array | null;

export interface DbStatement {
  run(...params: DbValue[]): unknown;
  get(...params: DbValue[]): Record<string, unknown> | undefined;
  all(...params: DbValue[]): Array<Record<string, unknown>>;
}

export interface DbAdapter {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type DbAdapterFactory = (path: string) => DbAdapter;

export interface UsageStoreOptions {
  createAdapter?: DbAdapterFactory | undefined;
}

export class UsageStore {
  private db: DbAdapter;

  constructor(path: string, options: UsageStoreOptions = {}) {
    ensureParentDir(path);
    this.db = (options.createAdapter ?? createBetterSqlite3Adapter)(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        model TEXT NOT NULL,
        upstream_id TEXT NOT NULL,
        upstream_model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL,
        estimated_cost REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        error_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_upstream ON usage_events(upstream_id, created_at);

      CREATE TABLE IF NOT EXISTS upstream_state (
        upstream_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_successes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS router_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  recordUsage(input: UsageRecordInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (
          created_at, request_id, model, upstream_id, upstream_model, input_tokens, output_tokens,
          cached_tokens, estimated_cost, latency_ms, status, http_status, error_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        input.request_id,
        input.model,
        input.upstream_id,
        input.upstream_model,
        input.input_tokens,
        input.output_tokens,
        input.cached_tokens,
        input.estimated_cost,
        input.latency_ms,
        input.status,
        input.http_status ?? null,
        input.error_type ?? null
      );
  }

  getState(upstreamId: string): UpstreamRuntimeState {
    const row = this.db
      .prepare('SELECT * FROM upstream_state WHERE upstream_id = ?')
      .get(upstreamId) as StateRow | undefined;
    if (!row) return defaultState(upstreamId);
    return rowToState(row);
  }

  upsertState(state: UpstreamRuntimeState): void {
    this.db
      .prepare(
        `INSERT INTO upstream_state (
          upstream_id, state, disabled, cooldown_until, last_error, consecutive_failures,
          consecutive_successes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(upstream_id) DO UPDATE SET
          state = excluded.state,
          disabled = excluded.disabled,
          cooldown_until = excluded.cooldown_until,
          last_error = excluded.last_error,
          consecutive_failures = excluded.consecutive_failures,
          consecutive_successes = excluded.consecutive_successes,
          updated_at = excluded.updated_at`
      )
      .run(
        state.id,
        state.state,
        state.disabled ? 1 : 0,
        state.cooldown_until ?? null,
        state.last_error ?? null,
        state.consecutive_failures,
        state.consecutive_successes,
        state.updated_at
      );
  }

  setDisabled(upstreamId: string, disabled: boolean): void {
    const current = this.getState(upstreamId);
    this.upsertState({
      ...current,
      state: disabled ? 'disabled' : 'healthy',
      disabled,
      cooldown_until: undefined,
      updated_at: Date.now()
    });
  }

  recordSuccess(upstreamId: string): void {
    const current = this.getState(upstreamId);
    if (current.disabled) return;
    this.upsertState({
      ...current,
      state: 'healthy',
      cooldown_until: undefined,
      last_error: undefined,
      consecutive_failures: 0,
      consecutive_successes: current.consecutive_successes + 1,
      updated_at: Date.now()
    });
  }

  recordFailure(upstreamId: string, reason: string, cooldownMs: number): void {
    const current = this.getState(upstreamId);
    if (current.disabled) return;
    const multiplier = Math.min(4, current.consecutive_failures + 1);
    this.upsertState({
      ...current,
      state: 'cooldown',
      cooldown_until: Date.now() + cooldownMs * multiplier,
      last_error: reason,
      consecutive_failures: current.consecutive_failures + 1,
      consecutive_successes: 0,
      updated_at: Date.now()
    });
  }

  recoverExpiredCooldown(upstreamId: string): UpstreamRuntimeState {
    const current = this.getState(upstreamId);
    if (
      current.state === 'cooldown' &&
      current.cooldown_until &&
      current.cooldown_until <= Date.now()
    ) {
      const next = {
        ...current,
        state: 'probation' as const,
        cooldown_until: undefined,
        updated_at: Date.now()
      };
      this.upsertState(next);
      return next;
    }
    return current;
  }

  getStats(upstreamId: string, since = 0): UpstreamStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as requests,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as successes,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as errors,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cached_tokens), 0) as cached_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost,
          COALESCE(AVG(latency_ms), 0) as average_latency_ms
        FROM usage_events WHERE upstream_id = ? AND created_at >= ?`
      )
      .get(upstreamId, since) as unknown as StatsRow;
    return { upstream_id: upstreamId, ...row };
  }

  getUsageSince(since: number): UpstreamStats[] {
    return this.db
      .prepare(
        `SELECT
          upstream_id,
          COUNT(*) as requests,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as successes,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as errors,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cached_tokens), 0) as cached_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost,
          COALESCE(AVG(latency_ms), 0) as average_latency_ms
        FROM usage_events WHERE created_at >= ? GROUP BY upstream_id ORDER BY estimated_cost DESC`
      )
      .all(since) as unknown as UpstreamStats[];
  }

  getRecentErrors(limit = 10): Array<{
    created_at: number;
    upstream_id: string;
    model: string;
    http_status: number | null;
    error_type: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT created_at, upstream_id, model, http_status, error_type
         FROM usage_events WHERE status = 'error' ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      created_at: number;
      upstream_id: string;
      model: string;
      http_status: number | null;
      error_type: string | null;
    }>;
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM router_kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO router_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }
}

export function createBetterSqlite3Adapter(path: string): DbAdapter {
  return new BetterSqlite3Adapter(path);
}

class BetterSqlite3Adapter implements DbAdapter {
  private db: BetterSqlite3.Database;

  constructor(path: string) {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    this.db = new Database(path);
  }

  prepare(sql: string): DbStatement {
    return this.db.prepare(sql) as DbStatement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

interface StateRow {
  upstream_id: string;
  state: UpstreamRuntimeState['state'];
  disabled: number;
  cooldown_until: number | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  updated_at: number;
}

interface StatsRow {
  requests: number;
  successes: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  average_latency_ms: number;
}

function defaultState(upstreamId: string): UpstreamRuntimeState {
  return {
    id: upstreamId,
    state: 'healthy',
    disabled: false,
    consecutive_failures: 0,
    consecutive_successes: 0,
    updated_at: Date.now()
  };
}

function rowToState(row: StateRow): UpstreamRuntimeState {
  return {
    id: row.upstream_id,
    state: row.state,
    disabled: row.disabled === 1,
    cooldown_until: row.cooldown_until ?? undefined,
    last_error: row.last_error ?? undefined,
    consecutive_failures: row.consecutive_failures,
    consecutive_successes: row.consecutive_successes,
    updated_at: row.updated_at
  };
}
