import { encode } from 'gpt-tokenizer';
import type { ChatCompletionRequest, OpenAIUsage, UpstreamConfig } from './types.js';

export function estimateInputTokens(body: ChatCompletionRequest): number {
  const value = body.messages ?? body.prompt ?? body;
  return encode(JSON.stringify(value)).length;
}

export function usageFromResponse(json: unknown, fallbackInput: number): Required<OpenAIUsage> {
  const usage =
    typeof json === 'object' && json !== null && 'usage' in json
      ? (json as { usage?: OpenAIUsage }).usage
      : undefined;
  return normalizeUsage(usage, fallbackInput, 0);
}

export function normalizeUsage(
  usage: OpenAIUsage | undefined,
  fallbackInput: number,
  fallbackOutput: number
): Required<OpenAIUsage> {
  const prompt = usage && usage.prompt_tokens !== undefined ? usage.prompt_tokens : fallbackInput;
  const completion =
    usage && usage.completion_tokens !== undefined ? usage.completion_tokens : fallbackOutput;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens:
      usage && usage.total_tokens !== undefined ? usage.total_tokens : prompt + completion,
    prompt_tokens_details: {
      cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0
    }
  };
}

export function estimateCost(upstream: UpstreamConfig, usage: Required<OpenAIUsage>): number {
  const pricing = upstream.pricing;
  if (!pricing) return 0;
  const inputRate = pricing.input_per_million ?? 0;
  const outputRate = pricing.output_per_million ?? 0;
  const cachedRate = pricing.cached_input_per_million ?? inputRate;
  const cached = usage.prompt_tokens_details.cached_tokens ?? 0;
  const uncachedInput = Math.max(0, (usage.prompt_tokens ?? 0) - cached);
  return (
    (uncachedInput * inputRate +
      cached * cachedRate +
      (usage.completion_tokens ?? 0) * outputRate) /
    1_000_000
  );
}
