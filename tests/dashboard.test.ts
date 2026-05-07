import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/db.js';
import { renderDashboard } from '../src/dashboard.js';
import type { AppConfig } from '../src/types.js';

describe('dashboard', () => {
  it('renders empty usage with escaped upstream values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-dashboard-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      const html = renderDashboard(fixtureConfig('danger<&>"'), store);
      expect(html).toContain('No usage recorded today.');
      expect(html).toContain('danger&lt;&amp;&gt;&quot;');
      expect(html).toContain('<span class="badge healthy">healthy</span>');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders usage totals, cost bars, and cooldown state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-dashboard-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      store.recordUsage({
        request_id: 'r1',
        model: 'test',
        upstream_id: 'a',
        upstream_model: 'upstream',
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 1,
        estimated_cost: 2,
        latency_ms: 123,
        status: 'success',
        http_status: 200
      });
      store.recordUsage({
        request_id: 'r2',
        model: 'test',
        upstream_id: 'b',
        upstream_model: 'upstream',
        input_tokens: 3,
        output_tokens: 7,
        cached_tokens: 0,
        estimated_cost: 1,
        latency_ms: 42,
        status: 'error',
        http_status: 500,
        error_type: 'server_error'
      });
      store.recordFailure('b', 'server_error', 60_000);

      const html = renderDashboard(fixtureConfig('a', 'b'), store);
      expect(html).toContain('<strong>2</strong>');
      expect(html).toContain('<strong>$3.0000</strong>');
      expect(html).toContain('<strong>13</strong>');
      expect(html).toContain('<strong>12</strong>');
      expect(html).toContain('width:100.00%');
      expect(html).toContain('width:50.00%');
      expect(html).toContain('<span class="badge cooldown">cooldown</span>');
      expect(html).toContain('123ms');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fixtureConfig(...ids: string[]): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: ':memory:' },
    routing: {
      default_strategy: 'fallback',
      retry_attempts: 1,
      request_timeout_seconds: 1,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { test: { upstreams: ids } },
    upstreams: ids.map((id) => ({
      id,
      type: 'openai-compatible',
      base_url: 'https://example.com/v1',
      api_key: 'key',
      strategy_weight: 1,
      models: { test: 'upstream' }
    }))
  };
}
