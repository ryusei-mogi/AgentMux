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

  it('converts Anthropic Messages responses to OpenAI-compatible chat completions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = anthropicFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    let capturedBody: Record<string, unknown> | undefined;
    try {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
        const headers = new Headers(init?.headers);
        expect(headers.get('x-api-key')).toBe('anthropic-key');
        expect(headers.get('anthropic-version')).toBe('2023-06-01');
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [
            { type: 'text', text: 'checking ' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Tokyo' } }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 }
        });
      }) satisfies typeof fetch;
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'claude-sonnet',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Weather?' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'get_weather' } }
      });
      const json = (await response.json()) as {
        choices: Array<{
          finish_reason: string;
          message: { content: string; tool_calls?: Array<{ function: { arguments: string } }> };
        }>;
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          prompt_tokens_details: { cached_tokens: number };
        };
      };
      expect(response.status).toBe(200);
      expect(capturedBody?.system).toBe('You are terse.');
      expect(capturedBody?.model).toBe('claude-test');
      expect(capturedBody?.max_tokens).toBe(4096);
      expect(json.choices[0]?.finish_reason).toBe('tool_calls');
      expect(json.choices[0]?.message.content).toBe('checking ');
      expect(json.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{"city":"Tokyo"}');
      expect(json.usage.prompt_tokens).toBe(7);
      expect(json.usage.completion_tokens).toBe(3);
      expect(json.usage.prompt_tokens_details.cached_tokens).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts Anthropic streaming events and records stream usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = anthropicFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
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
                    'event: message_start',
                    'data: {"type":"message_start","message":{"id":"msg_stream","usage":{"input_tokens":8}}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
                    '',
                    'event: message_delta',
                    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
                    '',
                    'event: message_stop',
                    'data: {"type":"message_stop"}',
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
        model: 'claude-sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('"content":"hello"');
      expect(text).toContain('data: [DONE]');
      const stats = store.getStats('anthropic-a');
      expect(stats.requests).toBe(1);
      expect(stats.input_tokens).toBe(8);
      expect(stats.output_tokens).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs CLI backend JSON output and records usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = cliFixtureConfig(join(dir, 'usage.sqlite'), [
      {
        id: 'cli-a',
        type: 'cli-backend',
        command: process.execPath,
        args: [
          '-e',
          [
            'const argv = process.argv.slice(1);',
            'const model = argv[argv.indexOf("--model") + 1];',
            'const prompt = argv.at(-1) ?? "";',
            'console.log(JSON.stringify({',
            '  result: JSON.stringify({',
            '    model,',
            '    profile: process.env.AGENTMUX_PROFILE,',
            '    unset: process.env.AGENTMUX_SHOULD_UNSET ?? null,',
            '    system: prompt.includes("[system]\\nBe terse."),',
            '    user: prompt.includes("[user]\\nPing")',
            '  }),',
            '  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }',
            '}));'
          ].join('\n'),
          '--'
        ],
        model_arg: '--model',
        input: 'arg',
        output: 'json',
        env: { AGENTMUX_PROFILE: 'profile-a' },
        env_unset: ['AGENTMUX_SHOULD_UNSET'],
        strategy_weight: 1,
        models: { 'cli-model': 'upstream-cli-model' }
      }
    ]);
    const previous = process.env.AGENTMUX_SHOULD_UNSET;
    process.env.AGENTMUX_SHOULD_UNSET = 'secret';
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'cli-model',
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Ping' }
        ]
      });
      const json = await expectJsonStatus<{
        choices: Array<{ message: { content: string } }>;
      }>(response, 200);
      const content = JSON.parse(json.choices[0]?.message.content ?? '{}') as {
        model?: string;
        profile?: string;
        unset?: string | null;
        system?: boolean;
        user?: boolean;
      };
      expect(content).toEqual({
        model: 'upstream-cli-model',
        profile: 'profile-a',
        unset: null,
        system: true,
        user: true
      });
      const stats = store.getStats('cli-a');
      expect(stats.requests).toBe(1);
      expect(stats.input_tokens).toBe(7);
      expect(stats.output_tokens).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.AGENTMUX_SHOULD_UNSET;
      else process.env.AGENTMUX_SHOULD_UNSET = previous;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses CLI backend JSONL deltas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = cliFixtureConfig(join(dir, 'usage.sqlite'), [
      {
        id: 'cli-jsonl',
        type: 'cli-backend',
        command: process.execPath,
        args: [
          '-e',
          [
            'let input = "";',
            'process.stdin.on("data", (chunk) => { input += chunk; });',
            'process.stdin.on("end", () => {',
            '  const text = input.includes("[user]\\nPing") ? "hello" : "bad";',
            '  console.log(JSON.stringify({ type: "message_delta", delta: { text: text.slice(0, 3) } }));',
            '  console.log(JSON.stringify({ type: "message_delta", delta: { text: text.slice(3) } }));',
            '  console.log(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));',
            '});'
          ].join('\n'),
          '--'
        ],
        input: 'stdin',
        output: 'jsonl',
        strategy_weight: 1,
        models: { 'cli-model': 'upstream-cli-model' }
      }
    ]);
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'cli-model',
        messages: [{ role: 'user', content: 'Ping' }]
      });
      const json = await expectJsonStatus<{
        choices: Array<{ message: { content: string } }>;
      }>(response, 200);
      expect(json.choices[0]?.message.content).toBe('hello');
      const stats = store.getStats('cli-jsonl');
      expect(stats.input_tokens).toBe(3);
      expect(stats.output_tokens).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns buffered SSE for streaming CLI backend responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = cliFixtureConfig(join(dir, 'usage.sqlite'), [
      {
        id: 'cli-stream',
        type: 'cli-backend',
        command: process.execPath,
        args: ['-e', 'console.log("stream pong");', '--'],
        input: 'arg',
        output: 'text',
        strategy_weight: 1,
        models: { 'cli-model': 'upstream-cli-model' }
      }
    ]);
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'cli-model',
        stream: true,
        messages: [{ role: 'user', content: 'Ping' }]
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('"content":"stream pong"');
      expect(text).toContain('data: [DONE]');
      expect(store.getStats('cli-stream').requests).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back after CLI backend rate-limit failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = cliFixtureConfig(
      join(dir, 'usage.sqlite'),
      [
        {
          id: 'cli-rate-limited',
          type: 'cli-backend',
          command: process.execPath,
          args: ['-e', 'console.error("rate limit reached"); process.exit(1);', '--'],
          input: 'arg',
          output: 'text',
          strategy_weight: 1,
          models: { 'cli-model': 'upstream-cli-model' }
        },
        {
          id: 'cli-fallback',
          type: 'cli-backend',
          command: process.execPath,
          args: ['-e', 'console.log("fallback ok");', '--'],
          input: 'arg',
          output: 'text',
          strategy_weight: 1,
          models: { 'cli-model': 'upstream-cli-model' }
        }
      ],
      ['cli-rate-limited', 'cli-fallback'],
      2
    );
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'cli-model',
        messages: [{ role: 'user', content: 'Ping' }]
      });
      const json = await expectJsonStatus<{
        choices: Array<{ message: { content: string } }>;
      }>(response, 200);
      expect(json.choices[0]?.message.content).toBe('fallback ok');
      expect(store.getState('cli-rate-limited').state).toBe('cooldown');
      expect(store.getStats('cli-rate-limited').errors).toBe(1);
      expect(store.getStats('cli-fallback').successes).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent requests for a serialized CLI backend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const lockPath = join(dir, 'cli-lock.txt');
    const config = cliFixtureConfig(join(dir, 'usage.sqlite'), [
      {
        id: 'cli-serialized',
        type: 'cli-backend',
        command: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'const path = process.env.AGENTMUX_LOCK_FILE;',
            'const current = path && fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "0";',
            'if (current !== "0") { console.error("overlap"); process.exit(1); }',
            'if (path) fs.writeFileSync(path, "1");',
            'setTimeout(() => {',
            '  if (path) fs.writeFileSync(path, "0");',
            '  console.log("serialized");',
            '}, 75);'
          ].join('\n'),
          '--'
        ],
        input: 'arg',
        output: 'text',
        env: { AGENTMUX_LOCK_FILE: lockPath },
        timeout_seconds: 10,
        serialize: true,
        strategy_weight: 1,
        models: { 'cli-model': 'upstream-cli-model' }
      }
    ]);
    const store = new UsageStore(config.database.path);
    try {
      const app = createApp(config, store);
      const responses = await Promise.all([
        authedChat(app, { model: 'cli-model', messages: [{ role: 'user', content: 'a' }] }),
        authedChat(app, { model: 'cli-model', messages: [{ role: 'user', content: 'b' }] })
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(store.getStats('cli-serialized').successes).toBe(2);
    } finally {
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

  it('converts rich Anthropic request shapes and max-token responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = anthropicFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    let capturedBody: Record<string, unknown> | undefined;
    try {
      globalThis.fetch = (async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: 'msg_length',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: 'max_tokens',
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4
          }
        });
      }) satisfies typeof fetch;

      const app = createApp(config, store);
      const response = await authedChat(app, {
        model: 'claude-sonnet',
        max_completion_tokens: 123,
        temperature: 0.5,
        top_p: 0.9,
        stop: ['END'],
        tool_choice: 'required',
        messages: [
          { role: 'system', content: 'Sys' },
          { role: 'developer', content: 'Dev' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
              { type: 'unknown', value: 'kept' }
            ]
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'calc', arguments: '{bad json' } }]
          },
          { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '42' }] }
        ],
        tools: [
          { type: 'function', function: { name: 'calc', parameters: { type: 'object' } } },
          { type: 'invalid' }
        ]
      });
      const json = await expectJsonStatus<{
        choices: Array<{ finish_reason: string; message: { content: string } }>;
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          prompt_tokens_details: { cached_tokens: number };
        };
      }>(response, 200);
      expect(capturedBody).toMatchObject({
        model: 'claude-test',
        max_tokens: 123,
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ['END'],
        tool_choice: { type: 'any' }
      });
      expect(capturedBody?.system).toBe('Sys\n\nDev');
      expect(capturedBody?.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: '{"type":"unknown","value":"kept"}' }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 'call_1', name: 'calc', input: {} }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '42' }] }
      ]);
      expect(json.choices[0]?.finish_reason).toBe('length');
      expect(json.choices[0]?.message.content).toBe('');
      expect(json.usage.prompt_tokens).toBe(6);
      expect(json.usage.completion_tokens).toBe(4);
      expect(json.usage.prompt_tokens_details.cached_tokens).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts Anthropic streaming tool deltas and flushes unfinished streams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = anthropicFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
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
                    'event: message_start',
                    'data: {"type":"message_start","message":{"id":"msg_tool","usage":{"input_tokens":2}}}',
                    '',
                    'event: content_block_start',
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"Tokyo\\"}"}}',
                    '',
                    'event: message_delta',
                    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
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
        model: 'claude-sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'weather' }]
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).toContain('"name":"get_weather"');
      expect(text).toContain('{\\"city\\"');
      expect(text).toContain(':\\"Tokyo\\"}');
      expect(text).toContain('"finish_reason":"tool_calls"');
      expect(text).toContain('data: [DONE]');
      expect(store.getStats('anthropic-a')).toMatchObject({
        requests: 1,
        input_tokens: 2,
        output_tokens: 1
      });
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers additional Anthropic request, response, and stream edge cases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = anthropicFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const store = new UsageStore(config.database.path);
    const capturedBodies: Record<string, unknown>[] = [];
    const responses: unknown[] = [
      {
        content: [{ type: 'tool_use', name: 'fallback_tool' }],
        usage: undefined
      },
      {
        id: 'msg_text',
        content: [
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 'ignored_without_name' }
        ],
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ];
    try {
      globalThis.fetch = (async (_input, init) => {
        capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const next = responses.shift();
        return Response.json(next);
      }) satisfies typeof fetch;

      const app = createApp(config, store);
      const promptResponse = await authedChat(app, {
        model: 'claude-sonnet',
        prompt: ['prompt text', { type: 'image' }],
        max_tokens: 77,
        tools: [{ type: 'function', function: { name: 'fallback_tool' } }],
        tool_choice: 'auto'
      });
      const promptJson = await expectJsonStatus<{
        id: string;
        choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }>;
      }>(promptResponse, 200);
      expect(promptJson.id).toMatch(/^chatcmpl-/);
      expect(promptJson.choices[0]?.message.content).toBeNull();
      expect(promptJson.choices[0]?.message.tool_calls).toHaveLength(1);

      const richResponse = await authedChat(app, {
        model: 'claude-sonnet',
        tool_choice: 'invalid',
        messages: [
          { role: 123, content: [1, { type: 'text', text: 2 }, { type: 'image' }, { foo: 'bar' }] },
          { role: 'user', content: 'second user part' },
          { role: 'system', content: null },
          {
            role: 'assistant',
            content: 'assistant text',
            tool_calls: [
              { function: { name: '', arguments: { skipped: true } } },
              { function: { name: 'ok_tool', arguments: { value: 1 } } }
            ]
          }
        ],
        tools: [{ type: 'function', function: { name: 'ok_tool', description: 'Ok' } }]
      });
      const richJson = await expectJsonStatus<{
        choices: Array<{ finish_reason: string; message: { content: string } }>;
      }>(richResponse, 200);
      expect(richJson.choices[0]?.finish_reason).toBe('stop');
      expect(richJson.choices[0]?.message.content).toBe('done');

      expect(capturedBodies[0]).toMatchObject({
        max_tokens: 77,
        tool_choice: { type: 'auto' },
        tools: [{ name: 'fallback_tool', input_schema: { type: 'object', properties: {} } }]
      });
      expect(capturedBodies[0]?.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'prompt text' }] }
      ]);
      expect(capturedBodies[1]?.tool_choice).toBeUndefined();
      expect(capturedBodies[1]?.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: '1' },
            { type: 'text', text: '' },
            { type: 'text', text: '{"foo":"bar"}' },
            { type: 'text', text: 'second user part' }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'assistant text' },
            { type: 'tool_use', id: 'toolu_1', name: 'ok_tool', input: { value: 1 } }
          ]
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts Anthropic text block starts and malformed stream events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-server-'));
    const config = anthropicFixtureConfig(join(dir, 'usage.sqlite'));
    const originalFetch = globalThis.fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new UsageStore(config.database.path);
    try {
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    'event: message_start',
                    'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
                    '',
                    'event: content_block_start',
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"started"}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" delta"}}',
                    '',
                    'event: message_delta',
                    'data: not-json',
                    '',
                    'event: message_stop',
                    'data: {"type":"message_stop"}',
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
        model: 'claude-sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }]
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).toContain('"content":"started"');
      expect(text).toContain('"content":" delta"');
      expect(warn).toHaveBeenCalledWith(
        'agentmux: malformed Anthropic SSE chunk, skipping',
        expect.any(SyntaxError)
      );
      expect(store.getStats('anthropic-a').input_tokens).toBe(4);
    } finally {
      warn.mockRestore();
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

function anthropicFixtureConfig(path: string): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787, api_key: 'local-test-key-that-is-long-enough' },
    database: { path },
    routing: {
      default_strategy: 'quota_aware',
      retry_attempts: 1,
      request_timeout_seconds: 1,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { 'claude-sonnet': { upstreams: ['anthropic-a'] } },
    upstreams: [
      {
        id: 'anthropic-a',
        type: 'anthropic-messages',
        base_url: 'https://api.anthropic.com/v1',
        api_key: 'anthropic-key',
        anthropic_version: '2023-06-01',
        default_max_tokens: 4096,
        strategy_weight: 1,
        models: { 'claude-sonnet': 'claude-test' }
      }
    ]
  };
}

function cliFixtureConfig(
  path: string,
  upstreams: AppConfig['upstreams'],
  routeIds = upstreams.map((upstream) => upstream.id),
  retryAttempts = 1
): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787, api_key: 'local-test-key-that-is-long-enough' },
    database: { path },
    routing: {
      default_strategy: 'fallback',
      retry_attempts: retryAttempts,
      request_timeout_seconds: 5,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { 'cli-model': { upstreams: routeIds, strategy: 'fallback' } },
    upstreams
  };
}

function retryFixtureConfig(path: string): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787, api_key: 'local-test-key-that-is-long-enough' },
    database: { path },
    routing: {
      default_strategy: 'fallback',
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
