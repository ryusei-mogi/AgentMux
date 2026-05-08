import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UsageStore } from '../src/db.js';
import { dashboardData, renderDashboard } from '../src/dashboard.js';
import type { AppConfig } from '../src/types.js';

describe('dashboard', () => {
  it('renders the redesigned dashboard shell with escaped initial data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-dashboard-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      const html = renderDashboard(fixtureConfig('danger<&>"'), store);
      expect(html).toContain('Local routing command center');
      expect(html).toContain('id="dashboard-data" type="application/json"');
      expect(html).toContain('/dashboard/data');
      expect(html).toContain('Refreshes every 15s');
      expect(html).toContain('danger\\u003c\\u0026\\u003e\\"');
      expect(html).not.toContain('danger<&>"');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds dashboard data with totals, budgets, routes, and cooldown state', () => {
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

      const data = dashboardData(fixtureConfig('a', 'b'), store);
      expect(data.totals).toMatchObject({
        requests: 2,
        successes: 1,
        errors: 1,
        input_tokens: 13,
        output_tokens: 12,
        cached_tokens: 1,
        estimated_cost: 3,
        upstreams: 2,
        available_upstreams: 1
      });
      expect(Math.round(data.totals.average_latency_ms)).toBe(83);
      expect(data.upstreams[0]).toMatchObject({
        id: 'a',
        type: 'openai-compatible',
        state: 'healthy',
        model_count: 1,
        requests: 1,
        success_rate: 100,
        estimated_cost: 2,
        average_latency_ms: 123,
        budget: { limit_usd: 4, used_usd: 2, remaining_usd: 2, percent_used: 50 }
      });
      expect(data.upstreams[1]).toMatchObject({
        id: 'b',
        state: 'cooldown',
        requests: 1,
        errors: 1,
        success_rate: 0,
        last_error: 'server_error'
      });
      expect(data.upstreams[1]?.cooldown_until).toBeDefined();
      expect(data.recent_errors[0]).toMatchObject({
        upstream_id: 'b',
        model: 'test',
        http_status: 500,
        error_type: 'server_error'
      });
      expect(data.models).toEqual([{ name: 'test', strategy: 'fallback', upstream_count: 2 }]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calculates budget usage with each upstream budget window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-dashboard-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-08T06:00:00.000Z'));
      store.recordUsage({
        request_id: 'outside-budget-window',
        model: 'test',
        upstream_id: 'a',
        upstream_model: 'upstream',
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
        estimated_cost: 3,
        latency_ms: 100,
        status: 'success'
      });

      vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
      store.recordUsage({
        request_id: 'inside-budget-window',
        model: 'test',
        upstream_id: 'a',
        upstream_model: 'upstream',
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
        estimated_cost: 1,
        latency_ms: 100,
        status: 'success'
      });

      const config = fixtureConfig('a');
      config.upstreams[0] = {
        ...config.upstreams[0]!,
        budget: { window: '5h', limit_usd: 4 }
      };
      const data = dashboardData(config, store);

      expect(data.upstreams[0]).toMatchObject({
        estimated_cost: 4,
        budget: {
          window: '5h',
          limit_usd: 4,
          used_usd: 1,
          remaining_usd: 3,
          percent_used: 25
        }
      });
    } finally {
      vi.useRealTimers();
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
      budget: id === 'a' ? { window: 'daily', limit_usd: 4 } : undefined,
      models: { test: 'upstream' }
    }))
  };
}
