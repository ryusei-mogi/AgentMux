import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it('allows explicitly unauthenticated API requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    config.server.api_key = undefined;
    config.server.allow_unauthenticated = true;
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await app.request('/v1/models');
      expect(response.status).toBe(200);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies configured CORS headers to API routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    config.server.cors_origins = ['https://app.example'];
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await app.request('/v1/models', {
        headers: {
          Authorization: 'Bearer local-test-key-that-is-long-enough',
          Origin: 'https://app.example'
        }
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles route validation, no-candidate, not-found, and health states', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const missingModel = await authedChat(app, { messages: [] });
      expect(missingModel.status).toBe(400);

      store.setDisabled('test-upstream', true);
      const noCandidate = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      await expectJsonStatus(noCandidate, 503);

      const health = await app.request('/health');
      const healthJson = (await health.json()) as { status: string };
      expect(healthJson.status).toBe('degraded');

      const dashboard = await app.request('/dashboard');
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain('AgentMux');

      const dashboardData = await app.request('/dashboard/data');
      const dashboardJson = (await dashboardData.json()) as {
        totals: { upstreams: number };
        upstreams: Array<{ id: string; state: string }>;
        models: Array<{ name: string }>;
        recent_errors: unknown[];
      };
      expect(dashboardData.status).toBe(200);
      expect(dashboardJson.totals.upstreams).toBe(1);
      expect(dashboardJson.upstreams[0]).toMatchObject({
        id: 'test-upstream',
        state: 'disabled'
      });
      expect(dashboardJson.models[0]?.name).toBe('test-model');
      expect(Array.isArray(dashboardJson.recent_errors)).toBe(true);

      const notFound = await app.request('/missing');
      expect(notFound.status).toBe(404);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns request errors through the server error handler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      const json = await expectJsonStatus<{ error: { message: string } }>(response, 500);
      expect(json.error.message).toMatch(/Unknown model/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes OpenAI-compatible upstream headers and records usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    config.upstreams[0] = {
      ...config.upstreams[0],
      headers: { 'X-Static': 'static-value' },
      header_env: { 'OpenAI-Project': 'AGENTMUX_TEST_PROJECT' }
    };
    const previousProject = process.env.AGENTMUX_TEST_PROJECT;
    const originalFetch = globalThis.fetch;
    process.env.AGENTMUX_TEST_PROJECT = 'proj_test';
    const store = new UsageStore(config.database.path);
    try {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe('https://example.com/v1/chat/completions');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer key');
        expect(headers.get('x-static')).toBe('static-value');
        expect(headers.get('openai-project')).toBe('proj_test');
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        });
      }) satisfies typeof fetch;
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }]
      });
      expect(response.status).toBe(200);
      const stats = store.getStats('test-upstream');
      expect(stats.requests).toBe(1);
      expect(stats.input_tokens).toBe(4);
      expect(stats.output_tokens).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousProject === undefined) delete process.env.AGENTMUX_TEST_PROJECT;
      else process.env.AGENTMUX_TEST_PROJECT = previousProject;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses Retry-After cooldowns before falling back to the next upstream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = retryFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { message: 'rate limit' } },
            { status: 429, headers: { 'Retry-After': '2' } }
          );
        }
        return Response.json({
          id: 'chatcmpl-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }) satisfies typeof fetch;
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      const state = store.getState('a');
      expect(state.state).toBe('cooldown');
      expect((state.cooldown_until ?? 0) - Date.now()).toBeGreaterThan(0);
      expect((state.cooldown_until ?? 0) - Date.now()).toBeLessThanOrEqual(2_500);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures OpenAI-compatible streaming usage and passes malformed SSE through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new UsageStore(config.database.path);
    try {
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  [
                    'event: keepalive',
                    '',
                    'data: not-json',
                    '',
                    'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
                    '',
                    'data: [DONE]',
                    ''
                  ].join('\n')
                )
              );
              controller.close();
            }
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )) satisfies typeof fetch;

      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).toContain('data: not-json');
      expect(text).toContain('"content":"hello"');
      expect(warn).toHaveBeenCalledWith(
        'agentmux: malformed SSE chunk, passing through',
        expect.any(SyntaxError)
      );
      expect(store.getStats('test-upstream')).toMatchObject({
        requests: 1,
        input_tokens: 2,
        output_tokens: 3
      });
    } finally {
      warn.mockRestore();
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('estimates OpenAI streaming usage when providers omit stream usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = fixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    try {
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    'data: {"choices":[{"delta":{"content":"fallback usage text"}}]}',
                    'event: leftover'
                  ].join('\n')
                )
              );
              controller.close();
            }
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )) satisfies typeof fetch;

      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).toContain('fallback usage text');
      expect(store.getStats('test-upstream').output_tokens).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns non-retryable upstream errors without falling back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = retryFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        return Response.json({ error: { message: 'bad key' } }, { status: 401 });
      }) satisfies typeof fetch;
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      const json = await expectJsonStatus<{ error: { message: string } }>(response, 401);
      expect(json.error.message).toBe('bad key');
      expect(calls).toBe(1);
      expect(store.getStats('a')).toMatchObject({ requests: 1, errors: 1 });
      expect(store.getState('a').state).toBe('healthy');
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles missing upstream API key and header env failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(join(dir, 'usage.sqlite'));
    try {
      globalThis.fetch = (async () => {
        throw new Error('fetch should not be called');
      }) satisfies typeof fetch;

      const missingKeyConfig = fixtureConfig(join(dir, 'usage.sqlite'));
      missingKeyConfig.upstreams[0] = {
        ...missingKeyConfig.upstreams[0],
        api_key: undefined,
        api_key_env: 'AGENTMUX_MISSING_UPSTREAM_KEY'
      };
      delete process.env.AGENTMUX_MISSING_UPSTREAM_KEY;
      const missingKey = await authedChat(createApp(missingKeyConfig, store), {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      await expectJsonStatus(missingKey, 503);
      store.setDisabled('test-upstream', false);

      const missingHeaderConfig = fixtureConfig(join(dir, 'usage.sqlite'));
      missingHeaderConfig.upstreams[0] = {
        ...missingHeaderConfig.upstreams[0],
        header_env: { 'OpenAI-Project': 'AGENTMUX_MISSING_PROJECT' }
      };
      delete process.env.AGENTMUX_MISSING_PROJECT;
      const missingHeader = await authedChat(createApp(missingHeaderConfig, store), {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      await expectJsonStatus(missingHeader, 503);
      expect(store.getStats('test-upstream').errors).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses provider reset headers before falling back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = retryFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { message: 'overloaded_error' } },
            { status: 500, headers: { 'x-ratelimit-reset-tokens': '1m2s3ms' } }
          );
        }
        return Response.json({
          id: 'chatcmpl-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }) satisfies typeof fetch;
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      const remaining = (store.getState('a').cooldown_until ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(60_000);
      expect(remaining).toBeLessThanOrEqual(63_000);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses date and numeric cooldown headers and falls back for empty error bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = retryFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { message: 'rate_limit_error' } },
            { status: 429, headers: { 'Retry-After': new Date(Date.now() + 3_000).toUTCString() } }
          );
        }
        if (calls === 2) {
          return new Response('', { status: 400 });
        }
        if (calls === 3) {
          return Response.json(
            { error: { message: 'server error' } },
            { status: 500, headers: { 'x-ratelimit-reset-requests': '2' } }
          );
        }
        return Response.json({
          id: 'chatcmpl-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }) satisfies typeof fetch;

      const app = createApp(config, store);
      const retryResponse = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'retry' }]
      });
      const retryJson = await expectJsonStatus<{ error: { message: string } }>(retryResponse, 400);
      expect(retryJson.error.message).toBe('Upstream returned 400');
      const state = store.getState('a');
      expect((state.cooldown_until ?? 0) - Date.now()).toBeGreaterThan(0);
      store.setDisabled('a', false);

      const numericReset = await authedChat(app, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'numeric reset' }]
      });
      expect(numericReset.status).toBe(200);
      const remaining = (store.getState('a').cooldown_until ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(4_500);
      expect(calls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function authedChat(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>
): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-test-key-that-is-long-enough',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

async function expectJsonStatus<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  const json = JSON.parse(text) as T;
  expect(response.status, text).toBe(status);
  return json;
}

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

function retryFixtureConfig(path: string): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787, api_key: 'local-test-key-that-is-long-enough' },
    database: { path },
    routing: {
      default_strategy: 'quota_aware',
      retry_attempts: 2,
      request_timeout_seconds: 1,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { 'test-model': { upstreams: ['a', 'b'] } },
    upstreams: ['a', 'b'].map((id) => ({
      id,
      type: 'openai-compatible',
      base_url: 'https://example.com/v1',
      api_key: 'key',
      strategy_weight: 1,
      models: { 'test-model': 'upstream-model' }
    }))
  };
}
