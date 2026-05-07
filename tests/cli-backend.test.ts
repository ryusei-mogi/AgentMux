import { describe, expect, it } from 'vitest';
import { CliBackendError, runCliBackend } from '../src/cli-backend.js';
import type { AppConfig, Candidate, CliBackendUpstreamConfig } from '../src/types.js';

describe('CLI backend runner', () => {
  it('formats rich chat messages for arg-mode text CLIs', async () => {
    const completion = await runCliBackend(
      fixtureConfig(),
      {
        model: 'cli-model',
        messages: [
          {
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
              { type: 'input_image' },
              { type: 'other', value: 1 },
              7
            ],
            tool_calls: [{ id: 'call_1', function: { name: 'tool', arguments: '{}' } }],
            tool_call_id: 'call_1'
          }
        ]
      },
      fixtureCandidate({
        output: 'text',
        args: ['-e', 'console.log(process.argv.at(-1));', '--']
      }),
      5
    );

    expect(completion.text).toContain('[user]');
    expect(completion.text).toContain('Hello');
    expect(completion.text).toContain('[image_url: {"url":"https://example.com/image.png"}]');
    expect(completion.text).toContain('[image omitted]');
    expect(completion.text).toContain('{"type":"other","value":1}');
    expect(completion.text).toContain('[tool_calls]');
    expect(completion.text).toContain('[tool_call_id]');
    expect(completion.usage.prompt_tokens).toBe(5);
    expect(completion.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('extracts JSON choices, content arrays, and stats usage', async () => {
    const completion = await runCliBackend(
      fixtureConfig(),
      { model: 'cli-model', prompt: { task: 'ping' } },
      fixtureCandidate({
        output: 'json',
        args: [
          '-e',
          [
            'console.log(JSON.stringify({',
            '  choices: [{ message: { content: [{ type: "output_text", text: "A" }, { content: "B" }] } }],',
            '  stats: { input_tokens: 4, output_tokens: 5, cached: 2 }',
            '}));'
          ].join('\n'),
          '--'
        ]
      }),
      9
    );

    expect(completion.text).toBe('AB');
    expect(completion.usage).toMatchObject({
      prompt_tokens: 4,
      completion_tokens: 5,
      total_tokens: 9,
      prompt_tokens_details: { cached_tokens: 2 }
    });
  });

  it('extracts JSONL full events, deltas, fallback fields, invalid lines, and usage', async () => {
    const completion = await runCliBackend(
      fixtureConfig(),
      { model: 'cli-model', prompt: 'ping' },
      fixtureCandidate({
        input: 'stdin',
        output: 'jsonl',
        args: [
          '-e',
          [
            'process.stdin.resume();',
            'process.stdin.on("end", () => {',
            '  console.log("not json");',
            '  console.log(JSON.stringify("string event"));',
            '  console.log(JSON.stringify({ msg: { type: "agent_message", message: "agent" } }));',
            '  console.log(JSON.stringify({ item: { role: "assistant", content: "item" } }));',
            '  console.log(JSON.stringify({ message: { role: "assistant", content: "message" } }));',
            '  console.log(JSON.stringify({ role: "assistant", text: "role" }));',
            '  console.log(JSON.stringify({ type: "content_block_delta", delta: { text: "delta" } }));',
            '  console.log(JSON.stringify({ type: "result", result: "result" }));',
            '  console.log(JSON.stringify({ response: "response", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }));',
            '});'
          ].join('\n'),
          '--'
        ]
      }),
      1
    );

    expect(completion.text).toBe('response');
    expect(completion.usage).toMatchObject({
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11
    });
  });

  it('rejects invalid JSON output', async () => {
    await expect(
      runCliBackend(
        fixtureConfig(),
        { model: 'cli-model', prompt: 'ping' },
        fixtureCandidate({ output: 'json', args: ['-e', 'console.log("not json");', '--'] }),
        1
      )
    ).rejects.toMatchObject({ reason: 'upstream_error' });
  });

  it('classifies CLI process failures', async () => {
    for (const [message, reason] of [
      ['quota exceeded', 'quota_exceeded'],
      ['unauthorized login required', 'authentication_error'],
      ['overloaded server error', 'server_error'],
      ['plain failure', 'upstream_error']
    ]) {
      await expect(
        runCliBackend(
          fixtureConfig(),
          { model: 'cli-model', prompt: 'ping' },
          fixtureCandidate({
            output: 'text',
            env: { FAILURE_MESSAGE: message },
            args: ['-e', 'console.error(process.env.FAILURE_MESSAGE); process.exit(1);', '--']
          }),
          1
        )
      ).rejects.toMatchObject({ reason });
    }
  });

  it('reports process spawn errors and timeouts', async () => {
    await expect(
      runCliBackend(
        fixtureConfig(),
        { model: 'cli-model', prompt: 'ping' },
        fixtureCandidate({ command: '/definitely/missing/agentmux-cli', output: 'text' }),
        1
      )
    ).rejects.toMatchObject({ reason: 'network_error' });

    await expect(
      runCliBackend(
        fixtureConfig(),
        { model: 'cli-model', prompt: 'ping' },
        fixtureCandidate({
          output: 'text',
          timeout_seconds: 0.01,
          args: ['-e', 'setTimeout(() => {}, 1000);', '--']
        }),
        1
      )
    ).rejects.toBeInstanceOf(CliBackendError);
  });
});

function fixtureConfig(): AppConfig {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: ':memory:' },
    routing: {
      default_strategy: 'fallback',
      retry_attempts: 1,
      request_timeout_seconds: 15,
      cooldown: { rate_limit_seconds: 60, server_error_seconds: 60, timeout_seconds: 60 }
    },
    models: { 'cli-model': { upstreams: ['cli'] } },
    upstreams: []
  };
}

function fixtureCandidate(overrides: Partial<CliBackendUpstreamConfig>): Candidate {
  const upstream: CliBackendUpstreamConfig = {
    id: 'cli',
    type: 'cli-backend',
    command: process.execPath,
    args: ['-e', 'console.log("ok");', '--'],
    input: 'arg',
    output: 'text',
    strategy_weight: 1,
    models: { 'cli-model': 'upstream-cli-model' },
    ...overrides
  };
  return {
    upstream,
    upstreamModel: 'upstream-cli-model',
    state: {
      id: upstream.id,
      state: 'healthy',
      disabled: false,
      consecutive_failures: 0,
      consecutive_successes: 0,
      updated_at: Date.now()
    },
    stats: {
      upstream_id: upstream.id,
      requests: 0,
      successes: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      estimated_cost: 0,
      average_latency_ms: 0
    },
    score: 0
  };
}
