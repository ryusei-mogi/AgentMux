import { spawn } from 'node:child_process';
import { estimateInputTokens, normalizeUsage } from './cost.js';
import type {
  AppConfig,
  Candidate,
  ChatCompletionRequest,
  CliBackendUpstreamConfig,
  OpenAIUsage
} from './types.js';

export interface CliBackendCompletion {
  text: string;
  usage: Required<OpenAIUsage>;
  stdout: string;
  stderr: string;
}

export class CliBackendError extends Error {
  constructor(
    public reason: string,
    message: string
  ) {
    super(message);
    this.name = 'CliBackendError';
  }
}

interface ParsedCliOutput {
  text: string;
  usage?: OpenAIUsage | undefined;
}

const serializedLanes = new Map<string, Promise<void>>();

export async function runCliBackend(
  config: AppConfig,
  body: ChatCompletionRequest,
  candidate: Candidate,
  fallbackInput: number
): Promise<CliBackendCompletion> {
  const upstream = candidate.upstream as CliBackendUpstreamConfig;
  const run = () => executeCliBackend(config, body, candidate, upstream, fallbackInput);
  if (upstream.serialize !== true) return run();
  return runSerialized(upstream.id, run);
}

function runSerialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = serializedLanes.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  serializedLanes.set(key, next);
  return previous
    .catch(() => undefined)
    .then(run)
    .finally(() => {
      release();
      if (serializedLanes.get(key) === next) serializedLanes.delete(key);
    });
}

async function executeCliBackend(
  config: AppConfig,
  body: ChatCompletionRequest,
  candidate: Candidate,
  upstream: CliBackendUpstreamConfig,
  fallbackInput: number
): Promise<CliBackendCompletion> {
  const prompt = chatCompletionToCliPrompt(body);
  const args = cliArgs(upstream, candidate.upstreamModel, prompt);
  const timeoutMs = (upstream.timeout_seconds ?? config.routing.request_timeout_seconds) * 1000;
  const { stdout, stderr } = await spawnCli(upstream, args, prompt, timeoutMs);
  const parsed = parseCliOutput(stdout, upstream.output ?? 'text');
  const outputTokens = estimateInputTokens({ model: body.model, prompt: parsed.text });
  const usage = normalizeUsage(parsed.usage, fallbackInput, outputTokens);
  return { text: parsed.text, usage, stdout, stderr };
}

function cliArgs(upstream: CliBackendUpstreamConfig, model: string, prompt: string): string[] {
  const args = [...(upstream.args ?? [])];
  if (upstream.model_arg) args.push(upstream.model_arg, model);
  if ((upstream.input ?? 'arg') === 'arg') args.push(prompt);
  return args;
}

function spawnCli(
  upstream: CliBackendUpstreamConfig,
  args: string[],
  prompt: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(upstream.command, args, {
      cwd: upstream.cwd,
      env: cliEnv(upstream),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 1_000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new CliBackendError('network_error', error.message));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        reject(new CliBackendError('timeout', `CLI backend ${upstream.id} timed out`));
        return;
      }
      if (code !== 0) {
        const text = [stderr, stdout].filter(Boolean).join('\n');
        const reason = classifyCliFailure(text);
        reject(
          new CliBackendError(
            reason,
            text.trim() || `CLI backend ${upstream.id} exited with ${signal ?? code}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });

    if ((upstream.input ?? 'arg') === 'stdin') {
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }
  });
}

function cliEnv(upstream: CliBackendUpstreamConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of upstream.env_unset ?? []) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(upstream.env ?? {})) {
    env[name] = value;
  }
  return env;
}

function classifyCliFailure(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('usage limit')
  )
    return 'rate_limit';
  if (lower.includes('quota') || lower.includes('limit reached')) return 'quota_exceeded';
  if (
    lower.includes('auth') ||
    lower.includes('login') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  )
    return 'authentication_error';
  if (lower.includes('overloaded') || lower.includes('server error')) return 'server_error';
  return 'upstream_error';
}

function parseCliOutput(
  stdout: string,
  output: CliBackendUpstreamConfig['output']
): ParsedCliOutput {
  if (output === 'json') return parseJsonOutput(stdout);
  if (output === 'jsonl') return parseJsonlOutput(stdout);
  return { text: stdout.trimEnd() };
}

function parseJsonOutput(stdout: string): ParsedCliOutput {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    return {
      text: extractText(value) || stdout.trimEnd(),
      usage: extractUsage(value)
    };
  } catch (error) {
    throw new CliBackendError(
      'upstream_error',
      `CLI backend returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseJsonlOutput(stdout: string): ParsedCliOutput {
  let finalText = '';
  const deltas: string[] = [];
  let usage: OpenAIUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      usage = mergeUsage(usage, extractUsage(value));
      const event = extractJsonlText(value);
      if (!event) continue;
      if (event.mode === 'delta') deltas.push(event.text);
      else finalText = event.text;
    } catch {
      continue;
    }
  }
  return {
    text: finalText || deltas.join('') || stdout.trimEnd(),
    usage
  };
}

function extractJsonlText(value: unknown): { mode: 'full' | 'delta'; text: string } | undefined {
  const record = asRecord(value);
  if (!record) {
    const text = extractText(value);
    return text ? { mode: 'full', text } : undefined;
  }

  const eventType = stringValue(record.type);
  const msg = asRecord(record.msg);
  if (msg?.type === 'agent_message' && typeof msg.message === 'string') {
    return { mode: 'full', text: msg.message };
  }

  const item = asRecord(record.item);
  if (item?.role === 'assistant') {
    const text = extractText(item);
    if (text) return { mode: 'full', text };
  }

  const message = asRecord(record.message);
  if (message?.role === 'assistant') {
    const text = extractText(message);
    if (text) return { mode: 'full', text };
  }

  if (record.role === 'assistant') {
    const text = extractText(record);
    if (text) return { mode: 'full', text };
  }

  if (
    eventType?.includes('delta') ||
    eventType === 'content_block_delta' ||
    eventType === 'message_delta'
  ) {
    const text = extractText(record.delta) || extractText(record);
    if (text) return { mode: 'delta', text };
  }

  if (eventType === 'result' || eventType === 'completion' || eventType === 'assistant_message') {
    const text = extractText(record);
    if (text) return { mode: 'full', text };
  }

  const text = extractText(record.result) || extractText(record.response);
  return text ? { mode: 'full', text } : undefined;
}

function extractText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return contentArrayText(value);
  const record = asRecord(value);
  if (!record) return '';

  const choices = Array.isArray(record.choices) ? record.choices : undefined;
  const firstChoice = asRecord(choices?.[0]);
  const choiceMessage = asRecord(firstChoice?.message);
  const choiceText = extractText(choiceMessage?.content) || extractText(firstChoice?.text);
  if (choiceText) return choiceText;

  for (const key of ['result', 'response', 'text', 'content', 'output', 'message']) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return '';
}

function contentArrayText(values: unknown[]): string {
  return values
    .map((item) => {
      if (typeof item === 'string') return item;
      const record = asRecord(item);
      if (!record) return '';
      if (record.type === 'text' || record.type === 'output_text') {
        return stringValue(record.text) ?? '';
      }
      return stringValue(record.content) ?? stringValue(record.text) ?? '';
    })
    .filter(Boolean)
    .join('');
}

function extractUsage(value: unknown): OpenAIUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const usage = usageFromRecord(asRecord(record.usage));
  if (usage) return usage;
  const stats = asRecord(record.stats);
  if (!stats) return undefined;
  const prompt = numberValue(stats.prompt_tokens) ?? numberValue(stats.input_tokens);
  const completion = numberValue(stats.completion_tokens) ?? numberValue(stats.output_tokens);
  if (prompt === undefined && completion === undefined) return undefined;
  return openAIUsage(
    prompt,
    completion,
    numberValue(stats.total_tokens) ??
      (prompt !== undefined && completion !== undefined ? prompt + completion : undefined),
    numberValue(stats.cached_tokens) ?? numberValue(stats.cached)
  );
}

function usageFromRecord(record: Record<string, unknown> | undefined): OpenAIUsage | undefined {
  if (!record) return undefined;
  const prompt = numberValue(record.prompt_tokens) ?? numberValue(record.input_tokens);
  const completion = numberValue(record.completion_tokens) ?? numberValue(record.output_tokens);
  const total = numberValue(record.total_tokens);
  const details = asRecord(record.prompt_tokens_details);
  const cached = numberValue(details?.cached_tokens) ?? numberValue(record.cached_tokens);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return openAIUsage(prompt, completion, total, cached);
}

function mergeUsage(
  current: OpenAIUsage | undefined,
  next: OpenAIUsage | undefined
): OpenAIUsage | undefined {
  if (!next) return current;
  return openAIUsage(
    next.prompt_tokens ?? current?.prompt_tokens,
    next.completion_tokens ?? current?.completion_tokens,
    next.total_tokens ?? current?.total_tokens,
    next.prompt_tokens_details?.cached_tokens ?? current?.prompt_tokens_details?.cached_tokens
  );
}

function openAIUsage(
  prompt: number | undefined,
  completion: number | undefined,
  total: number | undefined,
  cached: number | undefined
): OpenAIUsage {
  const usage: OpenAIUsage = {};
  if (prompt !== undefined) usage.prompt_tokens = prompt;
  if (completion !== undefined) usage.completion_tokens = completion;
  if (total !== undefined) usage.total_tokens = total;
  if (cached !== undefined) usage.prompt_tokens_details = { cached_tokens: cached };
  return usage;
}

function chatCompletionToCliPrompt(body: ChatCompletionRequest): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return `[user]\n${stringifyCliContent(body.prompt ?? '')}`;
  return messages
    .map((raw) => {
      const message = asRecord(raw);
      const role = stringValue(message?.role) ?? 'user';
      const parts = [stringifyCliContent(message?.content)];
      if (message?.tool_calls !== undefined) {
        parts.push(`[tool_calls]\n${stringifyCliContent(message.tool_calls)}`);
      }
      if (message?.tool_call_id !== undefined) {
        parts.push(`[tool_call_id]\n${stringifyCliContent(message.tool_call_id)}`);
      }
      return `[${role}]\n${parts.filter(Boolean).join('\n\n')}`;
    })
    .join('\n\n');
}

function stringifyCliContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        const record = asRecord(item);
        if (!record) return String(item);
        if (record.type === 'text' && typeof record.text === 'string') return record.text;
        if (record.type === 'image_url')
          return `[image_url: ${stringifyCliContent(record.image_url)}]`;
        if (record.type === 'image' || record.type === 'input_image') return '[image omitted]';
        return JSON.stringify(record);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
