import { createServer, isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { ServerType } from '@hono/node-server';
import { dashboardData } from './dashboard.js';
import { UsageStore } from './db.js';
import { loadConfig } from './config.js';
import { closeHttpServer, healthPayload, startHttpServer } from './server.js';
import type { AppConfig, UpstreamBudgetConfig, UpstreamState, UpstreamType } from './types.js';
import type { DbAdapterFactory } from './db.js';

export type AgentMuxRuntimeState = 'stopped' | 'starting' | 'running' | 'degraded' | 'error';

export interface AgentMuxEnvOverrides {
  [name: string]: string | undefined;
}

export interface AgentMuxRuntimeSnapshot {
  state: AgentMuxRuntimeState;
  running: boolean;
  config_path?: string;
  base_url?: string;
  last_error?: string;
  port_conflict?: AgentMuxPortConflict;
  totals: AgentMuxRuntimeTotals;
  upstreams: AgentMuxRuntimeUpstream[];
  models: string[];
  recent_errors: Array<{
    created_at: string;
    upstream_id: string;
    model: string;
    http_status: number | null;
    error_type: string | null;
  }>;
}

export interface AgentMuxRuntimeTotals {
  requests: number;
  successes: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  average_latency_ms: number;
  upstreams: number;
  available_upstreams: number;
}

export interface AgentMuxRuntimeUpstream {
  id: string;
  type: UpstreamType;
  state: UpstreamState;
  requests: number;
  errors: number;
  estimated_cost: number;
  average_latency_ms: number;
  cooldown_until?: string;
  last_error?: string;
  budget?: {
    window: UpstreamBudgetConfig['window'];
    limit_usd: number;
    used_usd: number;
    remaining_usd: number;
    percent_used: number;
  };
}

export interface AgentMuxPortConflict {
  host: string;
  port: number;
  code: 'EADDRINUSE';
}

export interface MacAppValidationIssue {
  code:
    | 'server_host_not_loopback'
    | 'server_auth_missing'
    | 'server_auth_unauthenticated'
    | 'server_plaintext_api_key'
    | 'database_path_not_absolute'
    | 'upstream_plaintext_api_key'
    | 'upstream_api_key_env_missing'
    | 'config_load_failed'
    | 'secret_env_missing';
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export class AgentMuxRuntimeError extends Error {
  constructor(
    message: string,
    public code: 'already_running' | 'not_running' | 'port_conflict' | 'start_failed'
  ) {
    super(message);
    this.name = 'AgentMuxRuntimeError';
  }
}

export interface AgentMuxRuntimeOptions {
  createDbAdapter?: DbAdapterFactory | undefined;
}

export class AgentMuxRuntime {
  private server: ServerType | undefined;
  private store: UsageStore | undefined;
  private config: AppConfig | undefined;
  private configPath: string | undefined;
  private state: AgentMuxRuntimeState = 'stopped';
  private lastError: string | undefined;
  private portConflict: AgentMuxPortConflict | undefined;
  private restoreEnv: (() => void) | undefined;

  constructor(private readonly options: AgentMuxRuntimeOptions = {}) {}

  async start(
    configPath: string,
    envOverrides: AgentMuxEnvOverrides = {}
  ): Promise<AgentMuxRuntimeSnapshot> {
    if (this.server) {
      throw new AgentMuxRuntimeError('AgentMux runtime is already running', 'already_running');
    }

    this.state = 'starting';
    this.lastError = undefined;
    this.portConflict = undefined;
    this.configPath = configPath;
    this.restoreEnv = applyEnvOverrides(envOverrides);

    try {
      const config = loadConfig(configPath);
      const conflict = await findPortConflict(config.server.host, config.server.port);
      if (conflict) {
        this.state = 'error';
        this.portConflict = conflict;
        this.lastError = `Port ${conflict.port} is already in use on ${conflict.host}`;
        throw new AgentMuxRuntimeError(this.lastError, 'port_conflict');
      }

      const store = new UsageStore(config.database.path, {
        createAdapter: this.options.createDbAdapter
      });
      const server = startHttpServer(config, store);
      this.config = config;
      this.store = store;
      this.server = server;
      this.state = 'running';
      return this.snapshot();
    } catch (error) {
      this.cleanupAfterFailedStart();
      const message = error instanceof Error ? error.message : String(error);
      this.state = 'error';
      this.lastError = message;
      if (error instanceof AgentMuxRuntimeError) throw error;
      throw new AgentMuxRuntimeError(message, 'start_failed');
    }
  }

  async stop(): Promise<AgentMuxRuntimeSnapshot> {
    if (!this.server) {
      this.state = 'stopped';
      return this.snapshot();
    }

    const server = this.server;
    this.server = undefined;
    try {
      await closeHttpServer(server);
      this.store?.close();
      this.store = undefined;
      this.config = undefined;
      this.state = 'stopped';
      this.lastError = undefined;
      this.portConflict = undefined;
      this.restoreEnv?.();
      this.restoreEnv = undefined;
      return this.snapshot();
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.snapshot();
    }
  }

  async restart(
    configPath = this.configPath,
    envOverrides: AgentMuxEnvOverrides = {}
  ): Promise<AgentMuxRuntimeSnapshot> {
    if (!configPath) {
      throw new AgentMuxRuntimeError('Cannot restart without a config path', 'not_running');
    }
    await this.stop();
    return this.start(configPath, envOverrides);
  }

  snapshot(): AgentMuxRuntimeSnapshot {
    if (!this.config || !this.store) {
      return this.emptySnapshot();
    }

    const health = healthPayload(this.config, this.store);
    const data = dashboardData(this.config, this.store);
    const state: AgentMuxRuntimeState =
      this.server && health.status === 'degraded' ? 'degraded' : this.state;
    const byId = new Map(data.upstreams.map((upstream) => [upstream.id, upstream]));
    const snapshot: AgentMuxRuntimeSnapshot = {
      state,
      running: Boolean(this.server),
      base_url: baseUrl(this.config),
      totals: data.totals,
      upstreams: health.upstreams.map((upstream) => {
        const stats = byId.get(upstream.id);
        const item: AgentMuxRuntimeUpstream = {
          id: upstream.id,
          type: upstreamType(this.config as AppConfig, upstream.id),
          state: upstream.state as UpstreamState,
          requests: stats?.requests ?? 0,
          errors: stats?.errors ?? 0,
          estimated_cost: stats?.estimated_cost ?? 0,
          average_latency_ms: stats?.average_latency_ms ?? 0
        };
        if (upstream.cooldown_until) {
          item.cooldown_until = new Date(upstream.cooldown_until).toISOString();
        }
        if (stats?.last_error) item.last_error = stats.last_error;
        if (stats?.budget) item.budget = stats.budget;
        return item;
      }),
      models: health.models,
      recent_errors: data.recent_errors
    };
    if (this.configPath) snapshot.config_path = this.configPath;
    if (this.lastError) snapshot.last_error = this.lastError;
    if (this.portConflict) snapshot.port_conflict = this.portConflict;
    return snapshot;
  }

  setUpstreamDisabled(id: string, disabled: boolean): AgentMuxRuntimeSnapshot {
    if (!this.config?.upstreams.some((upstream) => upstream.id === id)) {
      throw new Error(`Unknown upstream: ${id}`);
    }
    if (!this.store) {
      throw new AgentMuxRuntimeError('AgentMux runtime is not running', 'not_running');
    }
    this.store.setDisabled(id, disabled);
    return this.snapshot();
  }

  validateForMacApp(config: AppConfig): MacAppValidationIssue[] {
    return validateForMacApp(config);
  }

  static validateForMacApp(config: AppConfig): MacAppValidationIssue[] {
    return validateForMacApp(config);
  }

  private emptySnapshot(): AgentMuxRuntimeSnapshot {
    const snapshot: AgentMuxRuntimeSnapshot = {
      state: this.state,
      running: false,
      totals: emptyTotals(),
      upstreams: [],
      models: [],
      recent_errors: []
    };
    if (this.configPath) snapshot.config_path = this.configPath;
    if (this.lastError) snapshot.last_error = this.lastError;
    if (this.portConflict) snapshot.port_conflict = this.portConflict;
    return snapshot;
  }

  private cleanupAfterFailedStart(): void {
    this.server = undefined;
    this.store?.close();
    this.store = undefined;
    this.config = undefined;
    this.restoreEnv?.();
    this.restoreEnv = undefined;
  }
}

export function validateForMacApp(config: AppConfig): MacAppValidationIssue[] {
  const issues: MacAppValidationIssue[] = [];
  if (!isLoopbackHost(config.server.host)) {
    issues.push(
      issue(
        'server_host_not_loopback',
        'server.host',
        'Mac App Store builds must bind only to 127.0.0.1, localhost, or ::1.'
      )
    );
  }
  if (config.server.allow_unauthenticated === true) {
    issues.push(
      issue(
        'server_auth_unauthenticated',
        'server.allow_unauthenticated',
        'Mac App Store builds must require local API authentication.'
      )
    );
  }
  if (!config.server.api_key && !config.server.api_key_env) {
    issues.push(
      issue(
        'server_auth_missing',
        'server.api_key_env',
        'Mac App Store builds need a Keychain-backed local API key environment name.'
      )
    );
  }
  if (config.server.api_key && !config.server.api_key_env) {
    issues.push(
      issue(
        'server_plaintext_api_key',
        'server.api_key',
        'Store the local server API key in Keychain and reference it with server.api_key_env.'
      )
    );
  }
  if (!isAbsolute(config.database.path)) {
    issues.push(
      issue(
        'database_path_not_absolute',
        'database.path',
        'Mac App Store builds need an absolute database path inside the app container or an imported folder.'
      )
    );
  }

  config.upstreams.forEach((upstream, index) => {
    const basePath = `upstreams[${index}]`;
    if (upstream.api_key) {
      issues.push(
        issue(
          'upstream_plaintext_api_key',
          `${basePath}.api_key`,
          `Move ${upstream.id} API key into Keychain and use api_key_env.`
        )
      );
    }
    if (!upstream.api_key_env && !upstream.api_key) {
      issues.push(
        issue(
          'upstream_api_key_env_missing',
          `${basePath}.api_key_env`,
          `Upstream ${upstream.id} needs a Keychain-backed api_key_env.`
        )
      );
    }
  });

  return issues;
}

function issue(
  code: MacAppValidationIssue['code'],
  path: string,
  message: string
): MacAppValidationIssue {
  return { code, severity: 'error', path, message };
}

function emptyTotals(): AgentMuxRuntimeTotals {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    estimated_cost: 0,
    average_latency_ms: 0,
    upstreams: 0,
    available_upstreams: 0
  };
}

function baseUrl(config: AppConfig): string {
  return `http://${urlHost(config.server.host)}:${config.server.port}`;
}

function urlHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return isIP(host) === 6 ? `[${host}]` : host;
}

function upstreamType(config: AppConfig, id: string): UpstreamType {
  return config.upstreams.find((upstream) => upstream.id === id)?.type ?? 'openai-compatible';
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function applyEnvOverrides(envOverrides: AgentMuxEnvOverrides): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(envOverrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function findPortConflict(
  host: string,
  port: number
): Promise<AgentMuxPortConflict | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve({ host, port, code: 'EADDRINUSE' });
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolve(undefined));
    });
    server.listen(port, host);
  });
}
