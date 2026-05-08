import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../src/config.js';

describe('config', () => {
  it('writes and loads the default config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    try {
      const path = join(dir, 'agentmux.yaml');
      writeDefaultConfig(path);
      const config = loadConfig(path);
      expect(config.server.port).toBe(8787);
      expect(config.server.api_key).toMatch(/^agmx_/);
      expect(config.routing.default_strategy).toBe('quota_aware');
      expect(config.models['deepseek-chat']?.upstreams.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the server API key from an environment variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    const envName = 'AGENTMUX_TEST_API_KEY';
    const previous = process.env[envName];
    process.env[envName] = 'test-server-key-that-is-long-enough';
    try {
      const path = join(dir, 'agentmux.yaml');
      writeFileSync(
        path,
        [
          'server:',
          '  host: 127.0.0.1',
          '  port: 8787',
          `  api_key_env: ${envName}`,
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
          '    api_key_env: UPSTREAM_TEST_API_KEY',
          '    strategy_weight: 1',
          '    models:',
          '      test-model: upstream-model',
          ''
        ].join('\n'),
        'utf8'
      );
      const config = loadConfig(path);
      expect(config.server.api_key).toBe(process.env[envName]);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing config files and missing server API key env vars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    const envName = 'AGENTMUX_MISSING_TEST_API_KEY';
    const previous = process.env[envName];
    delete process.env[envName];
    try {
      expect(() => loadConfig(join(dir, 'missing.yaml'))).toThrow(/Config file not found/);
      const path = join(dir, 'agentmux.yaml');
      writeFileSync(
        path,
        minimalConfigWithServer(`  api_key_env: ${envName}`, 'UPSTREAM_TEST_API_KEY', dir),
        'utf8'
      );
      expect(() => loadConfig(path)).toThrow(
        /Missing configured server API key environment variable/
      );
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects short server API keys and upstreams without API keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    try {
      const shortKeyPath = join(dir, 'short.yaml');
      writeFileSync(shortKeyPath, minimalConfig('too-short', dir), 'utf8');
      expect(() => loadConfig(shortKeyPath)).toThrow(/at least 16 characters/);

      const missingUpstreamKeyPath = join(dir, 'missing-upstream-key.yaml');
      writeFileSync(
        missingUpstreamKeyPath,
        minimalConfigWithServer('  api_key: test-server-key-that-is-long-enough', undefined, dir),
        'utf8'
      );
      expect(() => loadConfig(missingUpstreamKeyPath)).toThrow(/api_key_env or api_key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects placeholder server API keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    try {
      const path = join(dir, 'agentmux.yaml');
      writeFileSync(path, minimalConfig('replace-with-a-random-32-byte-local-token', dir), 'utf8');
      expect(() => loadConfig(path)).toThrow(/private random value/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite default configs unless forced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    try {
      const path = join(dir, 'agentmux.yaml');
      writeDefaultConfig(path);
      expect(() => writeDefaultConfig(path)).toThrow(/Config already exists/);
      writeDefaultConfig(path, true);
      expect(loadConfig(path).server.api_key).toMatch(/^agmx_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the multi-account example with OpenAI-compatible and Anthropic upstreams', () => {
    const envName = 'AGENTMUX_API_KEY';
    const previous = process.env[envName];
    process.env[envName] = 'test-server-key-that-is-long-enough';
    try {
      const config = loadConfig('examples/multi-account.yaml');
      expect(config.upstreams.some((upstream) => upstream.type === 'openai-compatible')).toBe(true);
      expect(config.upstreams.some((upstream) => upstream.type === 'anthropic-messages')).toBe(
        true
      );
      const anthropic = config.upstreams.find((upstream) => upstream.id === 'anthropic-account-a');
      expect(anthropic?.type).toBe('anthropic-messages');
      expect(anthropic && 'default_max_tokens' in anthropic).toBe(true);
      const openai = config.upstreams.find((upstream) => upstream.id === 'openai-project-a');
      expect(openai?.header_env?.['OpenAI-Project']).toBe('OPENAI_PROJECT_A');
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it('loads CLI backend upstreams and expands profile paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-config-'));
    try {
      const path = join(dir, 'agentmux.yaml');
      writeFileSync(
        path,
        [
          'server:',
          '  host: 127.0.0.1',
          '  port: 8787',
          '  api_key: test-server-key-that-is-long-enough',
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
          '  codex-chat:',
          '    upstreams: [codex-main]',
          'upstreams:',
          '  - id: codex-main',
          '    type: cli-backend',
          '    command: codex',
          '    args: ["exec", "--json"]',
          '    model_arg: "--model"',
          '    input: arg',
          '    output: jsonl',
          '    env:',
          '      CODEX_HOME: ~/.codex-main',
          '    env_unset: [OPENAI_API_KEY]',
          '    cwd: "~"',
          '    serialize: true',
          '    models:',
          '      codex-chat: gpt-5.4',
          ''
        ].join('\n'),
        'utf8'
      );
      const config = loadConfig(path);
      const upstream = config.upstreams[0];
      expect(upstream?.type).toBe('cli-backend');
      if (upstream?.type !== 'cli-backend') throw new Error('expected cli backend');
      expect(upstream.env?.CODEX_HOME).not.toBe('~/.codex-main');
      expect(upstream.env?.CODEX_HOME.endsWith('/.codex-main')).toBe(true);
      expect(upstream.cwd).not.toBe('~');
      expect(upstream.env_unset).toEqual(['OPENAI_API_KEY']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function minimalConfig(apiKey: string, dir: string): string {
  return minimalConfigWithServer(`  api_key: ${apiKey}`, 'UPSTREAM_TEST_API_KEY', dir);
}

function minimalConfigWithServer(
  serverApiKeyLine: string,
  upstreamApiKeyEnv: string | undefined,
  dir: string
): string {
  return [
    'server:',
    '  host: 127.0.0.1',
    '  port: 8787',
    serverApiKeyLine,
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
    upstreamApiKeyEnv ? `    api_key_env: ${upstreamApiKeyEnv}` : undefined,
    '    strategy_weight: 1',
    '    models:',
    '      test-model: upstream-model',
    ''
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
