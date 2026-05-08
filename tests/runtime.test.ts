import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMuxRuntime, AgentMuxRuntimeError, validateForMacApp } from '../src/runtime.js';
import type { AppConfig } from '../src/types.js';

const serverEnv = 'AGENTMUX_RUNTIME_SERVER_KEY';
const upstreamEnv = 'AGENTMUX_RUNTIME_UPSTREAM_KEY';

describe('AgentMuxRuntime', () => {
  let previousServerKey: string | undefined;
  let previousUpstreamKey: string | undefined;

  beforeEach(() => {
    previousServerKey = process.env[serverEnv];
    previousUpstreamKey = process.env[upstreamEnv];
    delete process.env[serverEnv];
    delete process.env[upstreamEnv];
  });

  afterEach(() => {
    restoreEnv(serverEnv, previousServerKey);
    restoreEnv(upstreamEnv, previousUpstreamKey);
  });

  it('starts, snapshots, toggles upstream state, and stops cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-runtime-'));
    const runtime = new AgentMuxRuntime();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const port = await freePort();
      const configPath = join(dir, 'agentmux.yaml');
      writeFileSync(configPath, configYaml(dir, port), 'utf8');

      const running = await runtime.start(configPath, {
        [serverEnv]: 'server-key-that-is-long-enough',
        [upstreamEnv]: 'upstream-key'
      });
      expect(running).toMatchObject({
        state: 'running',
        running: true,
        config_path: configPath,
        base_url: `http://127.0.0.1:${port}`,
        totals: { upstreams: 1, available_upstreams: 1 },
        models: ['test-model']
      });
      expect(process.env[serverEnv]).toBe('server-key-that-is-long-enough');

      const disabled = runtime.setUpstreamDisabled('test-upstream', true);
      expect(disabled.upstreams[0]).toMatchObject({ id: 'test-upstream', state: 'disabled' });

      const stopped = await runtime.stop();
      expect(stopped).toMatchObject({ state: 'stopped', running: false });
      expect(process.env[serverEnv]).toBeUndefined();

      await runtime.start(configPath, {
        [serverEnv]: 'server-key-that-is-long-enough',
        [upstreamEnv]: 'upstream-key'
      });
      expect(runtime.snapshot().running).toBe(true);
    } finally {
      await runtime.stop();
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports port conflicts before starting the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-runtime-'));
    const runtime = new AgentMuxRuntime();
    const blocker = createServer();
    try {
      const port = await listenOnFreePort(blocker);
      const configPath = join(dir, 'agentmux.yaml');
      writeFileSync(configPath, configYaml(dir, port), 'utf8');

      await expect(
        runtime.start(configPath, {
          [serverEnv]: 'server-key-that-is-long-enough',
          [upstreamEnv]: 'upstream-key'
        })
      ).rejects.toMatchObject({ code: 'port_conflict' } satisfies Partial<AgentMuxRuntimeError>);
      expect(runtime.snapshot()).toMatchObject({
        state: 'error',
        running: false,
        port_conflict: { host: '127.0.0.1', port, code: 'EADDRINUSE' }
      });
    } finally {
      await closeServer(blocker);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('brackets IPv6 loopback hosts in the runtime base URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-runtime-'));
    const runtime = new AgentMuxRuntime();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const port = await freePort('::1');
      const configPath = join(dir, 'agentmux.yaml');
      writeFileSync(configPath, configYaml(dir, port, '::1'), 'utf8');

      const running = await runtime.start(configPath, {
        [serverEnv]: 'server-key-that-is-long-enough',
        [upstreamEnv]: 'upstream-key'
      });
      expect(running.base_url).toBe(`http://[::1]:${port}`);
      expect(() => new URL(`${running.base_url}/v1/models`)).not.toThrow();
    } finally {
      await runtime.stop();
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles stopped, already-running, restart, unknown upstream, and failed-start states', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-runtime-'));
    const runtime = new AgentMuxRuntime();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const previousExisting = process.env.EXISTING_RUNTIME_ENV;
    process.env.EXISTING_RUNTIME_ENV = 'before';
    try {
      expect(await runtime.stop()).toMatchObject({ state: 'stopped', running: false });
      await expect(runtime.restart()).rejects.toMatchObject({ code: 'not_running' });

      const port = await freePort();
      const configPath = join(dir, 'agentmux.yaml');
      writeFileSync(configPath, configYaml(dir, port), 'utf8');
      await runtime.start(configPath, {
        [serverEnv]: 'server-key-that-is-long-enough',
        [upstreamEnv]: 'upstream-key',
        EXISTING_RUNTIME_ENV: 'during'
      });
      await expect(runtime.start(configPath)).rejects.toMatchObject({ code: 'already_running' });
      expect(() => runtime.setUpstreamDisabled('missing-upstream', true)).toThrow(
        /Unknown upstream/
      );
      expect(process.env.EXISTING_RUNTIME_ENV).toBe('during');

      await runtime.restart(configPath, {
        [serverEnv]: 'server-key-that-is-long-enough',
        [upstreamEnv]: 'upstream-key',
        EXISTING_RUNTIME_ENV: 'again'
      });
      expect(runtime.snapshot()).toMatchObject({ state: 'running', running: true });
      expect(process.env.EXISTING_RUNTIME_ENV).toBe('again');
      await runtime.stop();
      expect(process.env.EXISTING_RUNTIME_ENV).toBe('before');

      const missingEnvConfigPath = join(dir, 'missing-env.yaml');
      writeFileSync(missingEnvConfigPath, configYaml(dir, await freePort()), 'utf8');
      await expect(
        runtime.start(missingEnvConfigPath, {
          [serverEnv]: undefined,
          [upstreamEnv]: 'upstream-key'
        })
      ).rejects.toMatchObject({ code: 'start_failed' });
      expect(runtime.snapshot()).toMatchObject({ state: 'error', running: false });
      expect(process.env.EXISTING_RUNTIME_ENV).toBe('before');
    } finally {
      await runtime.stop();
      log.mockRestore();
      restoreEnv('EXISTING_RUNTIME_ENV', previousExisting);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates Mac App Store safety constraints', () => {
    const invalid = macValidationConfig({
      server: {
        host: '0.0.0.0',
        port: 8787,
        api_key: 'plaintext-server-key',
        allow_unauthenticated: true,
        cors_origins: []
      },
      database: { path: 'relative.sqlite' },
      upstreams: [
        {
          id: 'http-upstream',
          type: 'openai-compatible',
          base_url: 'https://example.com/v1',
          api_key: 'plaintext-upstream-key',
          strategy_weight: 1,
          models: { 'test-model': 'test-model' }
        },
        {
          id: 'cli-upstream',
          type: 'cli-backend',
          command: 'codex',
          args: [],
          env: { CODEX_HOME: '.codex-main' },
          env_unset: [],
          input: 'arg',
          output: 'jsonl',
          serialize: true,
          strategy_weight: 1,
          models: { 'cli-model': 'gpt-5.4' }
        }
      ]
    });

    expect(validateForMacApp(invalid).map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'server_host_not_loopback',
        'server_auth_unauthenticated',
        'server_plaintext_api_key',
        'database_path_not_absolute',
        'upstream_plaintext_api_key',
        'cli_command_not_absolute',
        'cli_profile_path_not_absolute'
      ])
    );

    const valid = macValidationConfig({
      upstreams: [
        {
          id: 'http-upstream',
          type: 'openai-compatible',
          base_url: 'https://example.com/v1',
          api_key_env: 'HTTP_UPSTREAM_KEY',
          strategy_weight: 1,
          models: { 'test-model': 'test-model' }
        },
        {
          id: 'cli-upstream',
          type: 'cli-backend',
          command: process.execPath,
          args: [],
          env: { CODEX_HOME: tmpdir() },
          env_unset: [],
          input: 'arg',
          output: 'jsonl',
          serialize: true,
          strategy_weight: 1,
          models: { 'cli-model': 'gpt-5.4' }
        }
      ]
    });
    expect(validateForMacApp(valid)).toEqual([]);
  });

  it('covers additional Mac validation branches', () => {
    const missingAuthAndUpstreamKey = macValidationConfig({
      server: {
        host: 'localhost',
        port: 8787,
        allow_unauthenticated: false,
        cors_origins: []
      },
      upstreams: [
        {
          id: 'http-upstream',
          type: 'openai-compatible',
          base_url: 'https://example.com/v1',
          strategy_weight: 1,
          models: { 'test-model': 'test-model' }
        },
        {
          id: 'cli-upstream',
          type: 'cli-backend',
          command: join(tmpdir(), 'definitely-missing-agentmux-cli'),
          cwd: 'relative-workdir',
          args: [],
          env: { OTHER_VALUE: 'relative-ok', CLAUDE_CONFIG_DIR: 'relative-profile' },
          env_unset: [],
          input: 'arg',
          output: 'jsonl',
          serialize: true,
          strategy_weight: 1,
          models: { 'cli-model': 'gpt-5.4' }
        }
      ]
    });

    expect(validateForMacApp(missingAuthAndUpstreamKey).map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'server_auth_missing',
        'upstream_api_key_env_missing',
        'cli_command_not_found',
        'cli_cwd_not_absolute',
        'cli_profile_path_not_absolute'
      ])
    );
    expect(
      validateForMacApp(
        macValidationConfig({
          server: {
            host: '::1',
            port: 8787,
            api_key_env: 'SERVER_KEY',
            allow_unauthenticated: false,
            cors_origins: []
          }
        })
      )
    ).toEqual([]);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configYaml(dir: string, port: number, host = '127.0.0.1'): string {
  return [
    'server:',
    `  host: ${host}`,
    `  port: ${port}`,
    `  api_key_env: ${serverEnv}`,
    '  allow_unauthenticated: false',
    '  cors_origins: []',
    'database:',
    `  path: ${join(dir, 'usage.sqlite')}`,
    'routing:',
    '  default_strategy: quota_aware',
    '  retry_attempts: 3',
    '  request_timeout_seconds: 120',
    '  cooldown:',
    '    rate_limit_seconds: 900',
    '    server_error_seconds: 300',
    '    timeout_seconds: 180',
    'models:',
    '  test-model:',
    '    upstreams: [test-upstream]',
    'upstreams:',
    '  - id: test-upstream',
    '    type: openai-compatible',
    '    base_url: https://example.com/v1',
    `    api_key_env: ${upstreamEnv}`,
    '    strategy_weight: 1',
    '    models:',
    '      test-model: upstream-model',
    ''
  ].join('\n');
}

function macValidationConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 8787,
      api_key: 'server-key-that-is-long-enough',
      api_key_env: 'AGENTMUX_MAC_SERVER_API_KEY',
      allow_unauthenticated: false,
      cors_origins: []
    },
    database: { path: join(tmpdir(), 'agentmux.sqlite') },
    routing: {
      default_strategy: 'quota_aware',
      retry_attempts: 3,
      request_timeout_seconds: 120,
      cooldown: { rate_limit_seconds: 900, server_error_seconds: 300, timeout_seconds: 180 }
    },
    models: {
      'test-model': { upstreams: ['http-upstream'] },
      'cli-model': { upstreams: ['cli-upstream'] }
    },
    upstreams: [],
    ...overrides
  };
}

function freePort(host = '127.0.0.1'): Promise<number> {
  const server = createServer();
  return listenOnFreePort(server, host).finally(() => closeServer(server));
}

function listenOnFreePort(
  server: ReturnType<typeof createServer>,
  host = '127.0.0.1'
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('Failed to allocate a test port'));
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
