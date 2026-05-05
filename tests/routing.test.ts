import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/db.js';
import { RouterEngine } from '../src/routing.js';
import type { AppConfig } from '../src/types.js';

describe('RouterEngine', () => {
  it('skips disabled and cooldown upstreams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-routing-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      const config = fixtureConfig();
      store.setDisabled('a', true);
      store.recordFailure('b', 'rate_limit', 60_000);
      const candidates = new RouterEngine(config, store).select('test-model');
      expect(candidates.map((candidate) => candidate.upstream.id)).toEqual(['c']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fixtureConfig(): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: ':memory:' },
    routing: {
      default_strategy: 'fallback',
      retry_attempts: 3,
      request_timeout_seconds: 1,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { 'test-model': { upstreams: ['a', 'b', 'c'] } },
    upstreams: ['a', 'b', 'c'].map((id) => ({
      id,
      type: 'openai-compatible',
      base_url: 'https://example.com/v1',
      api_key: 'key',
      strategy_weight: 1,
      models: { 'test-model': 'upstream-model' }
    }))
  };
}
