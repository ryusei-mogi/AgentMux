import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/db.js';
import { createApp } from '../src/server.js';
import type { AppConfig } from '../src/types.js';

describe('server', () => {
  it('serves OpenAI-compatible models behind local auth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const unauthorized = await app.request('/v1/models');
      expect(unauthorized.status).toBe(401);
      const response = await app.request('/v1/models', {
        headers: { Authorization: 'Bearer local-test-key-that-is-long-enough' }
      });
      const json = (await response.json()) as { data: Array<{ id: string }> };
      expect(response.status).toBe(200);
      expect(json.data[0]?.id).toBe('test-model');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects API requests when authentication is not configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    config.server.api_key = undefined;
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await app.request('/v1/models');
      expect(response.status).toBe(503);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fixtureConfig(path: string): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787, api_key: 'local-test-key-that-is-long-enough' },
    database: { path },
    routing: {
      default_strategy: 'quota_aware',
      retry_attempts: 1,
      request_timeout_seconds: 1,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { 'test-model': { upstreams: ['test-upstream'] } },
    upstreams: [
      {
        id: 'test-upstream',
        type: 'openai-compatible',
        base_url: 'https://example.com/v1',
        api_key: 'key',
        strategy_weight: 1,
        models: { 'test-model': 'upstream-model' }
      }
    ]
  };
}
