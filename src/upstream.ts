import { randomUUID } from 'node:crypto';
import { estimateCost, estimateInputTokens, normalizeUsage, usageFromResponse } from './cost.js';
import type { UsageStore } from './db.js';
import type { AppConfig, Candidate, ChatCompletionRequest, OpenAIUsage } from './types.js';

export interface ProxyResult {
  response: Response;
  upstreamId: string;
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
    const upstreamBody = { ...body, model: candidate.upstreamModel };
    const fallbackInput = estimateInputTokens(body);
    try {
      const response = await callUpstream(config, candidate, upstreamBody);
      if (!response.ok) {
        const text = await response.text();
        const reason = classifyFailure(response.status, text);
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
          http_status: response.status,
          error_type: reason
        });
        if (isRetryable(response.status, text)) {
          store.recordFailure(candidate.upstream.id, reason, cooldownFor(config, reason));
          errors.push(`${candidate.upstream.id}: ${response.status} ${reason}`);
          continue;
        }
        return { response: jsonError(response.status, text), upstreamId: candidate.upstream.id };
      }

      if (body.stream === true) {
        store.recordSuccess(candidate.upstream.id);
        return {
          response: streamResponse(response, () => ({
            requestId,
            started,
            model: body.model,
            fallbackInput,
            candidate,
            store
          })),
          upstreamId: candidate.upstream.id
        };
      }

      const json = (await response.json()) as unknown;
      const usage = usageFromResponse(json, fallbackInput);
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
      return { response: Response.json(json, { status: 200 }), upstreamId: candidate.upstream.id };
    } catch (error) {
      const reason =
        error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network_error';
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
  body: ChatCompletionRequest
): Promise<Response> {
  const apiKey = resolveApiKey(candidate);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.routing.request_timeout_seconds * 1000
  );
  try {
    return await fetch(`${candidate.upstream.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function resolveApiKey(candidate: Candidate): string {
  if (candidate.upstream.api_key) return candidate.upstream.api_key;
  const key = candidate.upstream.api_key_env
    ? process.env[candidate.upstream.api_key_env]
    : undefined;
  if (!key) throw new Error(`Missing API key env for upstream ${candidate.upstream.id}`);
  return key;
}

function classifyFailure(status: number, text: string): string {
  const lower = text.toLowerCase();
  if (status === 429 || lower.includes('rate limit')) return 'rate_limit';
  if (status === 402 || lower.includes('limit reached') || lower.includes('quota'))
    return 'quota_exceeded';
  if (status >= 500) return 'server_error';
  return 'upstream_error';
}

function isRetryable(status: number, text: string): boolean {
  const reason = classifyFailure(status, text);
  return status === 429 || status === 402 || status >= 500 || reason === 'quota_exceeded';
}

function cooldownFor(config: AppConfig, reason: string): number {
  if (reason === 'rate_limit' || reason === 'quota_exceeded')
    return config.routing.cooldown.rate_limit_seconds * 1000;
  if (reason === 'timeout') return config.routing.cooldown.timeout_seconds * 1000;
  return config.routing.cooldown.server_error_seconds * 1000;
}

function jsonError(status: number, text: string): Response {
  try {
    return Response.json(JSON.parse(text), { status });
  } catch {
    return Response.json({ error: { message: text || `Upstream returned ${status}` } }, { status });
  }
}

interface StreamContext {
  requestId: string;
  started: number;
  model: string;
  fallbackInput: number;
  candidate: Candidate;
  store: UsageStore;
}

function streamResponse(response: Response, contextFactory: () => StreamContext): Response {
  const context = contextFactory();
  const stream = response.body?.pipeThrough(usageCaptureStream(context));
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/event-stream');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'no');
  return new Response(stream, { status: 200, headers });
}

function usageCaptureStream(context: StreamContext): TransformStream<Uint8Array, Uint8Array> {
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
      context.store.recordUsage({
        request_id: context.requestId,
        model: context.model,
        upstream_id: context.candidate.upstream.id,
        upstream_model: context.candidate.upstreamModel,
        input_tokens: normalized.prompt_tokens,
        output_tokens: normalized.completion_tokens,
        cached_tokens: normalized.prompt_tokens_details.cached_tokens ?? 0,
        estimated_cost: estimateCost(context.candidate.upstream, normalized),
        latency_ms: Date.now() - context.started,
        status: 'success',
        http_status: 200
      });
    }
  });
}
