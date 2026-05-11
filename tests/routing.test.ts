import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/db.js';
import { remainingBudgetRatio, RouterEngine } from '../src/routing.js';
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

  it('orders candidates by least_used and quota_aware strategies', () => {
    withStore((store) => {
      const config = fixtureConfig();
      config.upstreams[0] = {
        ...config.upstreams[0],
        pricing: { input_per_million: 10, output_per_million: 10 }
      };
      config.upstreams[1] = {
        ...config.upstreams[1],
        pricing: { input_per_million: 1, output_per_million: 1 }
      };
      config.upstreams[2] = {
        ...config.upstreams[2],
        pricing: { input_per_million: 5, output_per_million: 5 }
      };
      recordUsage(store, 'a', 2, 0.02);
      recordUsage(store, 'b', 1, 0.01);

      config.models['test-model'] = { upstreams: ['a', 'b', 'c'], strategy: 'least_used' };
      expect(
        new RouterEngine(config, store).select('test-model').map((c) => c.upstream.id)
      ).toEqual(['c', 'b', 'a']);

      config.models['test-model'] = { upstreams: ['a', 'b', 'c'], strategy: 'quota_aware' };
      expect(new RouterEngine(config, store).select('test-model')[0]?.upstream.id).toBe('b');
    });
  });

  it('rotates round-robin candidates', () => {
    withStore((store) => {
      const config = fixtureConfig();
      config.models['test-model'] = { upstreams: ['a', 'b', 'c'], strategy: 'round_robin' };
      const router = new RouterEngine(config, store);
      expect(router.select('test-model').map((c) => c.upstream.id)).toEqual(['a', 'b', 'c']);
      expect(router.select('test-model').map((c) => c.upstream.id)).toEqual(['b', 'c', 'a']);
    });
  });

  it('filters unknown, unmapped, and budget-exhausted upstreams', () => {
    withStore((store) => {
      const config = fixtureConfig();
      config.models['test-model'] = {
        upstreams: ['missing', 'a', 'b', 'c'],
        strategy: 'round_robin'
      };
      config.upstreams[1] = { ...config.upstreams[1], models: { other: 'other' } };
      config.upstreams[2] = {
        ...config.upstreams[2],
        budget: { window: 'daily', limit_usd: 0.01 }
      };
      recordUsage(store, 'c', 1, 0.01);
      expect(
        new RouterEngine(config, store).select('test-model').map((c) => c.upstream.id)
      ).toEqual(['a']);
      expect(() => new RouterEngine(config, store).select('unknown')).toThrow(/Unknown model/);
    });
  });

  it('recovers expired cooldowns and reports remaining budget ratio', () => {
    withStore((store) => {
      const config = fixtureConfig();
      store.upsertState({
        id: 'a',
        state: 'cooldown',
        disabled: false,
        cooldown_until: Date.now() - 1,
        last_error: 'rate_limit',
        consecutive_failures: 1,
        consecutive_successes: 0,
        updated_at: Date.now()
      });
      expect(new RouterEngine(config, store).select('test-model')[0]?.state.state).toBe(
        'probation'
      );
      expect(
        remainingBudgetRatio(
          { ...config.upstreams[0], budget: { window: 'daily', limit_usd: 10 } },
          {
            upstream_id: 'a',
            requests: 1,
            successes: 1,
            errors: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            estimated_cost: 2,
            average_latency_ms: 0
          }
        )
      ).toBe(0.8);
      expect(
        remainingBudgetRatio(
          { ...config.upstreams[0], budget: { window: 'daily', limit_usd: 10 } },
          {
            upstream_id: 'a',
            requests: 1,
            successes: 1,
            errors: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            estimated_cost: 12,
            average_latency_ms: 0
          }
        )
      ).toBe(0);
      expect(
        remainingBudgetRatio(config.upstreams[0], {
          upstream_id: 'a',
          requests: 0,
          successes: 0,
          errors: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          estimated_cost: 0,
          average_latency_ms: 0
        })
      ).toBe(1);
    });
  });
});

function withStore(run: (store: UsageStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentmux-routing-'));
  const store = new UsageStore(join(dir, 'usage.sqlite'));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordUsage(store: UsageStore, upstreamId: string, count: number, cost: number): void {
  for (let index = 0; index < count; index += 1) {
    store.recordUsage({
      request_id: `${upstreamId}-${index}`,
      model: 'test-model',
      upstream_id: upstreamId,
      upstream_model: 'upstream-model',
      input_tokens: 1,
      output_tokens: 1,
      cached_tokens: 0,
      estimated_cost: cost,
      latency_ms: 10,
      status: 'success',
      http_status: 200
    });
  }
}

function fixtureConfig(): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: ':memory:' },
    routing: {
      default_strategy: 'quota_aware',
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
