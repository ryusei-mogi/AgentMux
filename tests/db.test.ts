import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/db.js';

describe('UsageStore', () => {
  it('records usage summaries and recent errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-db-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      store.recordUsage({
        request_id: 'r1',
        model: 'test',
        upstream_id: 'a',
        upstream_model: 'upstream',
        input_tokens: 10,
        output_tokens: 2,
        cached_tokens: 1,
        estimated_cost: 0.1,
        latency_ms: 100,
        status: 'success',
        http_status: 200
      });
      store.recordUsage({
        request_id: 'r2',
        model: 'test',
        upstream_id: 'a',
        upstream_model: 'upstream',
        input_tokens: 5,
        output_tokens: 1,
        cached_tokens: 0,
        estimated_cost: 0.2,
        latency_ms: 200,
        status: 'error',
        http_status: 429,
        error_type: 'rate_limit'
      });

      expect(store.getStats('a')).toMatchObject({
        requests: 2,
        successes: 1,
        errors: 1,
        input_tokens: 15,
        output_tokens: 3,
        cached_tokens: 1,
        estimated_cost: 0.30000000000000004,
        average_latency_ms: 150
      });
      expect(store.getUsageSince(0)[0]?.upstream_id).toBe('a');
      expect(store.getRecentErrors(1)).toEqual([
        {
          created_at: expect.any(Number),
          upstream_id: 'a',
          model: 'test',
          http_status: 429,
          error_type: 'rate_limit'
        }
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manages upstream state transitions and router kv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-db-'));
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      expect(store.getState('a')).toMatchObject({
        id: 'a',
        state: 'healthy',
        disabled: false,
        consecutive_failures: 0,
        consecutive_successes: 0
      });

      store.recordFailure('a', 'rate_limit', 1_000);
      const firstFailure = store.getState('a');
      expect(firstFailure).toMatchObject({
        state: 'cooldown',
        last_error: 'rate_limit',
        consecutive_failures: 1,
        consecutive_successes: 0
      });

      store.recordFailure('a', 'server_error', 1_000);
      const secondFailure = store.getState('a');
      expect(secondFailure.consecutive_failures).toBe(2);
      expect((secondFailure.cooldown_until ?? 0) - Date.now()).toBeGreaterThan(1_500);

      store.upsertState({ ...secondFailure, cooldown_until: Date.now() - 1 });
      expect(store.recoverExpiredCooldown('a').state).toBe('probation');

      store.recordSuccess('a');
      expect(store.getState('a')).toMatchObject({
        state: 'healthy',
        consecutive_failures: 0,
        consecutive_successes: 1
      });

      store.setDisabled('a', true);
      store.recordFailure('a', 'rate_limit', 1_000);
      store.recordSuccess('a');
      expect(store.getState('a')).toMatchObject({ state: 'disabled', disabled: true });

      store.setDisabled('a', false);
      expect(store.getState('a')).toMatchObject({ state: 'healthy', disabled: false });
      store.setKv('rr:test', '2');
      expect(store.getKv('rr:test')).toBe('2');
      expect(store.getKv('missing')).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
