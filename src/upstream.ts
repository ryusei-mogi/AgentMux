import { randomUUID } from 'node:crypto';
import { CliBackendError, runCliBackend } from './cli-backend.js';
import { estimateCost, estimateInputTokens, normalizeUsage, usageFromResponse } from './cost.js';
import type { UsageStore } from './db.js';
import type {
  AnthropicMessagesUpstreamConfig,
  AppConfig,
  Candidate,
  ChatCompletionRequest,
  OpenAIUsage,
  UpstreamConfig
} from './types.js';

export interface ProxyResult {
  response: Response;
  upstreamId: string;
}

interface ProviderAdapter {
  requestBody(body: ChatCompletionRequest, candidate: Candidate): unknown;
  url(upstream: UpstreamConfig): string;
  headers(candidate: Candidate): Headers;
  responseJson(json: unknown, body: ChatCompletionRequest, candidate: Candidate): unknown;
  usage(json: unknown, fallbackInput: number): Required<OpenAIUsage>;
  stream(response: Response, context: StreamContext): Response;
}

export async function proxyChatCompletion(
  config: AppConfig,
  store: UsageStore,
  body: ChatCompletionRequest,
  candidates: Candidate[]
): Promise<ProxyResult> {
  const requestId = randomUUID();
  const maxAttempts = Math.min(config.routing.retry_attempts, candidates.length);
  const errors: string[] = [];

  for (const candidate of candidates.slice(0, maxAttempts)) {
    const started = Date.now();
    const fallbackInput = estimateInputTokens(body);
    try {
      if (candidate.upstream.type === 'cli-backend') {
        const completion = await runCliBackend(config, body, candidate, fallbackInput);
        store.recordUsage({
          request_id: requestId,
          model: body.model,
          upstream_id: candidate.upstream.id,
          upstream_model: candidate.upstreamModel,
          input_tokens: completion.usage.prompt_tokens,
          output_tokens: completion.usage.completion_tokens,
          cached_tokens: completion.usage.prompt_tokens_details.cached_tokens ?? 0,
          estimated_cost: estimateCost(candidate.upstream, completion.usage),
          latency_ms: Date.now() - started,
          status: 'success',
          http_status: 200
        });
        store.recordSuccess(candidate.upstream.id);
        const responseJson = cliToOpenAIResponse(
          completion.text,
          completion.usage,
          body,
          candidate
        );
        return {
          response:
            body.stream === true
              ? cliBufferedStreamResponse(responseJson)
              : Response.json(responseJson, { status: 200 }),
          upstreamId: candidate.upstream.id
        };
      }

      const adapter = adapterFor(candidate.upstream);
      const upstreamResponse = await callUpstream(
        config,
        candidate,
        adapter.requestBody(body, candidate),
        adapter
      );
      if (!upstreamResponse.ok) {
        const text = await upstreamResponse.text();
        const reason = classifyFailure(upstreamResponse.status, text);
        store.recordUsage({
          request_id: requestId,
          model: body.model,
          upstream_id: candidate.upstream.id,
          upstream_model: candidate.upstreamModel,
          input_tokens: fallbackInput,
          output_tokens: 0,
          cached_tokens: 0,
          estimated_cost: 0,
          latency_ms: Date.now() - started,
          status: 'error',
          http_status: upstreamResponse.status,
          error_type: reason
        });
        if (isRetryable(upstreamResponse.status, text)) {
          store.recordFailure(
            candidate.upstream.id,
            reason,
            cooldownFor(config, reason, upstreamResponse.headers)
          );
          errors.push(`${candidate.upstream.id}: ${upstreamResponse.status} ${reason}`);
          continue;
        }
        return {
          response: jsonError(upstreamResponse.status, text),
          upstreamId: candidate.upstream.id
        };
      }

      if (body.stream === true) {
        store.recordSuccess(candidate.upstream.id);
        return {
          response: adapter.stream(upstreamResponse, {
            requestId,
            started,
            model: body.model,
            fallbackInput,
            candidate,
            store
          }),
          upstreamId: candidate.upstream.id
        };
      }

      const upstreamJson = (await upstreamResponse.json()) as unknown;
      const usage = adapter.usage(upstreamJson, fallbackInput);
      store.recordUsage({
        request_id: requestId,
        model: body.model,
        upstream_id: candidate.upstream.id,
        upstream_model: candidate.upstreamModel,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        cached_tokens: usage.prompt_tokens_details.cached_tokens ?? 0,
        estimated_cost: estimateCost(candidate.upstream, usage),
        latency_ms: Date.now() - started,
        status: 'success',
        http_status: 200
      });
      store.recordSuccess(candidate.upstream.id);
      return {
        response: Response.json(adapter.responseJson(upstreamJson, body, candidate), {
          status: 200
        }),
        upstreamId: candidate.upstream.id
      };
    } catch (error) {
      const reason =
        error instanceof CliBackendError
          ? error.reason
          : error instanceof DOMException && error.name === 'AbortError'
            ? 'timeout'
            : 'network_error';
      store.recordUsage({
        request_id: requestId,
        model: body.model,
        upstream_id: candidate.upstream.id,
        upstream_model: candidate.upstreamModel,
        input_tokens: fallbackInput,
        output_tokens: 0,
        cached_tokens: 0,
        estimated_cost: 0,
        latency_ms: Date.now() - started,
        status: 'error',
        error_type: reason
      });
      store.recordFailure(candidate.upstream.id, reason, cooldownFor(config, reason));
      errors.push(`${candidate.upstream.id}: ${reason}`);
    }
  }

  return {
    response: Response.json(
      { error: { message: 'All upstreams failed', details: errors } },
      { status: 503 }
    ),
    upstreamId: 'none'
  };
}

async function callUpstream(
  config: AppConfig,
  candidate: Candidate,
  body: unknown,
  adapter: ProviderAdapter
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.routing.request_timeout_seconds * 1000
  );
  try {
    return await fetch(adapter.url(candidate.upstream), {
      method: 'POST',
      headers: adapter.headers(candidate),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function adapterFor(upstream: UpstreamConfig): ProviderAdapter {
  if (upstream.type === 'cli-backend') throw new Error('CLI backends do not use HTTP adapters');
  if (upstream.type === 'anthropic-messages') return anthropicMessagesAdapter;
  return openAICompatibleAdapter;
}

const openAICompatibleAdapter: ProviderAdapter = {
  requestBody(body, candidate) {
    return { ...body, model: candidate.upstreamModel };
  },
  url(upstream) {
    if (upstream.type === 'cli-backend') throw new Error('CLI backend does not have an HTTP URL');
    return `${upstream.base_url.replace(/\/$/, '')}/chat/completions`;
  },
  headers(candidate) {
    return withExtraHeaders(candidate.upstream, {
      Authorization: `Bearer ${resolveApiKey(candidate)}`,
      'Content-Type': 'application/json'
    });
  },
  responseJson(json) {
    return json;
  },
  usage(json, fallbackInput) {
    return usageFromResponse(json, fallbackInput);
  },
  stream(response, context) {
    return openAIStreamResponse(response, context);
  }
};

const anthropicMessagesAdapter: ProviderAdapter = {
  requestBody(body, candidate) {
    return toAnthropicRequest(body, candidate);
  },
  url(upstream) {
    if (upstream.type === 'cli-backend') throw new Error('CLI backend does not have an HTTP URL');
    return `${upstream.base_url.replace(/\/$/, '')}/messages`;
  },
  headers(candidate) {
    const upstream = candidate.upstream as AnthropicMessagesUpstreamConfig;
    return withExtraHeaders(upstream, {
      'x-api-key': resolveApiKey(candidate),
      'anthropic-version': upstream.anthropic_version ?? '2023-06-01',
      'Content-Type': 'application/json'
    });
  },
  responseJson(json, body, candidate) {
    return anthropicToOpenAIResponse(json, body, candidate);
  },
  usage(json, fallbackInput) {
    return usageFromAnthropic(json, fallbackInput);
  },
  stream(response, context) {
    return anthropicStreamResponse(response, context);
  }
};

function resolveApiKey(candidate: Candidate): string {
  if (candidate.upstream.type === 'cli-backend') {
    throw new Error(`CLI backend ${candidate.upstream.id} does not use API keys`);
  }
  if (candidate.upstream.api_key) return candidate.upstream.api_key;
  const key = candidate.upstream.api_key_env
    ? process.env[candidate.upstream.api_key_env]
    : undefined;
  if (!key) throw new Error(`Missing API key env for upstream ${candidate.upstream.id}`);
  return key;
}

function withExtraHeaders(upstream: UpstreamConfig, base: Record<string, string>): Headers {
  if (upstream.type === 'cli-backend') {
    throw new Error(`CLI backend ${upstream.id} does not use HTTP headers`);
  }
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(upstream.headers ?? {})) {
    headers.set(name, value);
  }
  for (const [name, envName] of Object.entries(upstream.header_env ?? {})) {
    const value = process.env[envName];
    if (!value) throw new Error(`Missing header env ${envName} for upstream ${upstream.id}`);
    headers.set(name, value);
  }
  return headers;
}

function classifyFailure(status: number, text: string): string {
  const lower = text.toLowerCase();
  if (status === 429 || lower.includes('rate limit') || lower.includes('rate_limit_error'))
    return 'rate_limit';
  if (status === 402 || lower.includes('limit reached') || lower.includes('quota'))
    return 'quota_exceeded';
  if (status === 401 || status === 403 || lower.includes('authentication_error'))
    return 'authentication_error';
  if (status >= 500 || lower.includes('overloaded_error')) return 'server_error';
  return 'upstream_error';
}

function isRetryable(status: number, text: string): boolean {
  const reason = classifyFailure(status, text);
  return (
    status === 429 ||
    status === 402 ||
    status >= 500 ||
    reason === 'quota_exceeded' ||
    reason === 'rate_limit' ||
    reason === 'server_error'
  );
}

function cooldownFor(config: AppConfig, reason: string, headers?: Headers): number {
  const headerCooldown = headers ? cooldownFromHeaders(headers) : 0;
  if (headerCooldown > 0) return headerCooldown;
  if (reason === 'rate_limit' || reason === 'quota_exceeded')
    return config.routing.cooldown.rate_limit_seconds * 1000;
  if (reason === 'timeout') return config.routing.cooldown.timeout_seconds * 1000;
  return config.routing.cooldown.server_error_seconds * 1000;
}

function cooldownFromHeaders(headers: Headers): number {
  const retryAfter = parseRetryAfter(headers.get('retry-after'));
  if (retryAfter > 0) return retryAfter;
  for (const name of [
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset'
  ]) {
    const parsed = parseResetHeader(headers.get(name));
    if (parsed > 0) return parsed;
  }
  return 0;
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

function parseResetHeader(value: string | null): number {
  if (!value) return 0;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  const match = trimmed.match(/^(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/);
  if (!match) return 0;
  const minutes = Number(match[1] ?? 0);
  const secs = Number(match[2] ?? 0);
  const millis = Number(match[3] ?? 0);
  return minutes * 60_000 + secs * 1000 + millis;
}

function jsonError(status: number, text: string): Response {
  try {
    return Response.json(JSON.parse(text), { status });
  } catch {
    return Response.json({ error: { message: text || `Upstream returned ${status}` } }, { status });
  }
}

function cliToOpenAIResponse(
  text: string,
  usage: Required<OpenAIUsage>,
  body: ChatCompletionRequest,
  candidate: Candidate
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop'
      }
    ],
    usage,
    agentmux: {
      upstream_model: candidate.upstreamModel,
      upstream_type: candidate.upstream.type
    }
  };
}

function cliBufferedStreamResponse(json: Record<string, unknown>): Response {
  const encoder = new TextEncoder();
  const id = typeof json.id === 'string' ? json.id : `chatcmpl-${randomUUID()}`;
  const model = typeof json.model === 'string' ? json.model : '';
  const created = typeof json.created === 'number' ? json.created : Math.floor(Date.now() / 1000);
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const firstChoice = choices[0] as
    | { message?: { content?: unknown }; finish_reason?: string | null }
    | undefined;
  const content =
    typeof firstChoice?.message?.content === 'string' ? firstChoice.message.content : '';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify(openAIChunk(id, model, created, { role: 'assistant', content }, null))}\n\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify(openAIChunk(id, model, created, {}, firstChoice?.finish_reason ?? 'stop'))}\n\n`
        )
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

interface StreamContext {
  requestId: string;
  started: number;
  model: string;
  fallbackInput: number;
  candidate: Candidate;
  store: UsageStore;
}

function openAIStreamResponse(response: Response, context: StreamContext): Response {
  const stream = response.body?.pipeThrough(openAIUsageCaptureStream(context));
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/event-stream');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'no');
  return new Response(stream, { status: 200, headers });
}

function openAIUsageCaptureStream(context: StreamContext): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let usage: OpenAIUsage | undefined;
  let outputText = '';
  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^event:\s*keepalive\b/i.test(trimmed)) continue;
        if (trimmed.startsWith('data: ') && trimmed.slice(6).trim() !== '[DONE]') {
          try {
            const parsed = JSON.parse(trimmed.slice(6)) as {
              usage?: OpenAIUsage;
              choices?: Array<{ delta?: { content?: string } }>;
            };
            usage = parsed.usage ?? usage;
            outputText += parsed.choices?.[0]?.delta?.content ?? '';
          } catch (err) {
            console.warn('agentmux: malformed SSE chunk, passing through', err);
          }
        }
        controller.enqueue(encoder.encode(`${line}\n`));
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(buffer));
      const normalized = normalizeUsage(
        usage,
        context.fallbackInput,
        outputText.length > 0
          ? estimateInputTokens({ model: context.model, prompt: outputText })
          : 0
      );
      recordSuccessUsage(context, normalized);
    }
  });
}

type AnthropicRole = 'user' | 'assistant';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: unknown;
}

interface AnthropicMessage {
  role: AnthropicRole;
  content: AnthropicContentBlock[];
}

interface OpenAIMessageLike {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

interface OpenAIToolCallLike {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponseLike {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

function toAnthropicRequest(
  body: ChatCompletionRequest,
  candidate: Candidate
): Record<string, unknown> {
  const upstream = candidate.upstream as AnthropicMessagesUpstreamConfig;
  const { system, messages } = toAnthropicMessages(body);
  const request: Record<string, unknown> = {
    model: candidate.upstreamModel,
    messages,
    max_tokens:
      numberValue(body.max_tokens) ??
      numberValue(body.max_completion_tokens) ??
      upstream.default_max_tokens ??
      4096
  };
  if (system.length > 0) request.system = system.join('\n\n');
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (typeof body.stop === 'string' || Array.isArray(body.stop)) request.stop_sequences = body.stop;
  if (body.stream === true) request.stream = true;
  const tools = toAnthropicTools(body.tools);
  if (tools.length > 0) {
    request.tools = tools;
    const toolChoice = toAnthropicToolChoice(body.tool_choice);
    if (toolChoice) request.tool_choice = toolChoice;
  }
  return request;
}

function toAnthropicMessages(body: ChatCompletionRequest): {
  system: string[];
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length === 0 && body.prompt !== undefined) {
    pushAnthropicMessage(messages, 'user', openAIContentToAnthropicBlocks(body.prompt));
  }
  for (const raw of rawMessages) {
    const message = raw as OpenAIMessageLike;
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      const text = stringifyOpenAIContent(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === 'assistant') {
      const blocks = openAIContentToAnthropicBlocks(message.content);
      for (const toolCall of normalizeToolCalls(message.tool_calls)) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: parseToolArguments(toolCall.arguments)
        });
      }
      pushAnthropicMessage(
        messages,
        'assistant',
        blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
      );
      continue;
    }
    if (role === 'tool') {
      pushAnthropicMessage(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
          content: stringifyOpenAIContent(message.content)
        }
      ]);
      continue;
    }
    pushAnthropicMessage(messages, 'user', openAIContentToAnthropicBlocks(message.content));
  }
  if (messages.length === 0) pushAnthropicMessage(messages, 'user', [{ type: 'text', text: '' }]);
  return { system, messages };
}

function pushAnthropicMessage(
  messages: AnthropicMessage[],
  role: AnthropicRole,
  content: AnthropicContentBlock[]
): void {
  const last = messages.at(-1);
  if (last?.role === role) {
    last.content.push(...content);
    return;
  }
  messages.push({ role, content });
}

function openAIContentToAnthropicBlocks(content: unknown): AnthropicContentBlock[] {
  if (content === undefined || content === null) return [{ type: 'text', text: '' }];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    const blocks = content.flatMap((item): AnthropicContentBlock[] => {
      if (typeof item !== 'object' || item === null) return [{ type: 'text', text: String(item) }];
      const value = item as Record<string, unknown>;
      if (value.type === 'text') {
        return [{ type: 'text', text: typeof value.text === 'string' ? value.text : '' }];
      }
      if (value.type === 'image' || value.type === 'image_url') {
        return [];
      }
      return [{ type: 'text', text: stringifyOpenAIContent(value) }];
    });
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
  }
  return [{ type: 'text', text: stringifyOpenAIContent(content) }];
}

function stringifyOpenAIContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const value = item as Record<string, unknown>;
          if (value.type === 'text' && typeof value.text === 'string') return value.text;
        }
        return typeof item === 'string' ? item : JSON.stringify(item);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content);
}

function normalizeToolCalls(
  toolCalls: unknown
): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((toolCall, index) => {
    const value = toolCall as OpenAIToolCallLike;
    const name = value.function?.name;
    if (typeof name !== 'string' || name.length === 0) return [];
    const args = value.function?.arguments;
    return [
      {
        id: typeof value.id === 'string' ? value.id : `toolu_${index}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {})
      }
    ];
  });
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toAnthropicTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const value = tool as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    };
    if (value.type !== 'function' || typeof value.function?.name !== 'string') return [];
    const result: Record<string, unknown> = {
      name: value.function.name,
      input_schema: value.function.parameters ?? { type: 'object', properties: {} }
    };
    if (typeof value.function.description === 'string') {
      result.description = value.function.description;
    }
    return [result];
  });
}

function toAnthropicToolChoice(choice: unknown): Record<string, string> | undefined {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object' && choice !== null) {
    const value = choice as { type?: unknown; function?: { name?: unknown } };
    if (value.type === 'function' && typeof value.function?.name === 'string') {
      return { type: 'tool', name: value.function.name };
    }
  }
  return undefined;
}

function anthropicToOpenAIResponse(
  json: unknown,
  body: ChatCompletionRequest,
  candidate: Candidate
): Record<string, unknown> {
  const response = json as AnthropicResponseLike;
  const { text, toolCalls } = anthropicContentToOpenAI(response.content ?? []);
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text.length > 0 ? text : toolCalls.length > 0 ? null : ''
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = usageFromAnthropic(json, 0);
  return {
    id: response.id ?? `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapAnthropicStopReason(response.stop_reason)
      }
    ],
    usage,
    agentmux: {
      upstream_model: candidate.upstreamModel,
      upstream_type: candidate.upstream.type
    }
  };
}

function anthropicContentToOpenAI(content: AnthropicContentBlock[]): {
  text: string;
  toolCalls: Array<Record<string, unknown>>;
} {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text ?? '');
    } else if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: block.id ?? `toolu_${toolCalls.length}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        }
      });
    }
  }
  return { text: textParts.join(''), toolCalls };
}

function usageFromAnthropic(json: unknown, fallbackInput: number): Required<OpenAIUsage> {
  const usage =
    typeof json === 'object' && json !== null && 'usage' in json
      ? (json as { usage?: AnthropicUsage }).usage
      : undefined;
  return normalizeAnthropicUsage(usage, fallbackInput);
}

function normalizeAnthropicUsage(
  usage: AnthropicUsage | undefined,
  fallbackInput: number
): Required<OpenAIUsage> {
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const prompt = usage ? (usage.input_tokens ?? 0) + cacheCreation + cacheRead : fallbackInput;
  const completion = usage?.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: cacheRead
    }
  };
}

function mapAnthropicStopReason(reason: string | null | undefined): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function anthropicStreamResponse(response: Response, context: StreamContext): Response {
  const stream = response.body?.pipeThrough(anthropicToOpenAIStream(context));
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/event-stream');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'no');
  return new Response(stream, { status: 200, headers });
}

function anthropicToOpenAIStream(context: StreamContext): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let eventName = '';
  let streamId = `chatcmpl-${randomUUID()}`;
  let finishReason = 'stop';
  let done = false;
  let usage: AnthropicUsage | undefined;
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          if (eventName === 'message_start') {
            const message = event.message as { id?: unknown; usage?: AnthropicUsage } | undefined;
            if (typeof message?.id === 'string') streamId = message.id;
            usage = mergeAnthropicUsage(usage, message?.usage);
          } else if (eventName === 'message_delta') {
            const delta = event.delta as { stop_reason?: unknown } | undefined;
            if (typeof delta?.stop_reason === 'string')
              finishReason = mapAnthropicStopReason(delta.stop_reason);
            usage = mergeAnthropicUsage(usage, event.usage as AnthropicUsage | undefined);
          }
          for (const payload of anthropicStreamEventToOpenAI(
            eventName,
            event,
            context.model,
            created,
            streamId
          )) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
          if (eventName === 'message_stop') {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(openAIChunk(streamId, context.model, created, {}, finishReason))}\n\n`
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            done = true;
          }
        } catch (err) {
          console.warn('agentmux: malformed Anthropic SSE chunk, skipping', err);
        }
      }
    },
    flush(controller) {
      if (!done) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify(openAIChunk(streamId, context.model, created, {}, finishReason))}\n\n`
          )
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      recordSuccessUsage(context, normalizeAnthropicUsage(usage, context.fallbackInput));
    }
  });
}

function anthropicStreamEventToOpenAI(
  eventName: string,
  event: Record<string, unknown>,
  model: string,
  created: number,
  streamId: string
): Array<Record<string, unknown>> {
  if (eventName === 'message_start') {
    return [openAIChunk(streamId, model, created, { role: 'assistant' }, null)];
  }
  if (eventName === 'content_block_start') {
    const index = numberValue(event.index) ?? 0;
    const block = event.content_block as AnthropicContentBlock | undefined;
    if (block?.type === 'tool_use') {
      return [
        openAIChunk(
          streamId,
          model,
          created,
          {
            tool_calls: [
              {
                index,
                id: block.id ?? `toolu_${index}`,
                type: 'function',
                function: { name: block.name ?? '', arguments: '' }
              }
            ]
          },
          null
        )
      ];
    }
    if (block?.type === 'text' && block.text) {
      return [openAIChunk(streamId, model, created, { content: block.text }, null)];
    }
  }
  if (eventName === 'content_block_delta') {
    const index = numberValue(event.index) ?? 0;
    const delta = event.delta as
      | { type?: unknown; text?: unknown; partial_json?: unknown }
      | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [openAIChunk(streamId, model, created, { content: delta.text }, null)];
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      return [
        openAIChunk(
          streamId,
          model,
          created,
          { tool_calls: [{ index, function: { arguments: delta.partial_json } }] },
          null
        )
      ];
    }
  }
  return [];
}

function openAIChunk(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function mergeAnthropicUsage(
  current: AnthropicUsage | undefined,
  next: AnthropicUsage | undefined
): AnthropicUsage | undefined {
  if (!next) return current;
  const merged: AnthropicUsage = {};
  setOptionalNumber(merged, 'input_tokens', next.input_tokens ?? current?.input_tokens);
  setOptionalNumber(merged, 'output_tokens', next.output_tokens ?? current?.output_tokens);
  setOptionalNumber(
    merged,
    'cache_creation_input_tokens',
    next.cache_creation_input_tokens ?? current?.cache_creation_input_tokens
  );
  setOptionalNumber(
    merged,
    'cache_read_input_tokens',
    next.cache_read_input_tokens ?? current?.cache_read_input_tokens
  );
  return merged;
}

function setOptionalNumber(
  target: AnthropicUsage,
  key: keyof AnthropicUsage,
  value: number | undefined
): void {
  if (value !== undefined) target[key] = value;
}

function recordSuccessUsage(context: StreamContext, usage: Required<OpenAIUsage>): void {
  context.store.recordUsage({
    request_id: context.requestId,
    model: context.model,
    upstream_id: context.candidate.upstream.id,
    upstream_model: context.candidate.upstreamModel,
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cached_tokens: usage.prompt_tokens_details.cached_tokens ?? 0,
    estimated_cost: estimateCost(context.candidate.upstream, usage),
    latency_ms: Date.now() - context.started,
    status: 'success',
    http_status: 200
  });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
