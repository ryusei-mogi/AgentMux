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
