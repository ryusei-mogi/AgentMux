import { describe, expect, it } from 'vitest';
import {
  estimateCost,
  estimateInputTokens,
  normalizeUsage,
  usageFromResponse
} from '../src/cost.js';
import type { UpstreamConfig } from '../src/types.js';

describe('cost helpers', () => {
  it('estimates input tokens from messages or prompt fallbacks', () => {
    expect(
      estimateInputTokens({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      })
    ).toBeGreaterThan(0);
    expect(estimateInputTokens({ model: 'test', prompt: 'hello' })).toBeGreaterThan(0);
  });

  it('normalizes explicit and fallback usage', () => {
    expect(
      usageFromResponse(
        {
          usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5,
            prompt_tokens_details: { cached_tokens: 1 }
          }
        },
        99
      )
    ).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
      prompt_tokens_details: { cached_tokens: 1 }
    });

    expect(usageFromResponse({}, 7)).toEqual({
      prompt_tokens: 7,
      completion_tokens: 0,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 }
    });

    expect(normalizeUsage({ completion_tokens: 4 }, 6, 9)).toEqual({
      prompt_tokens: 6,
      completion_tokens: 4,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 }
    });
  });

  it('estimates priced and unpriced usage costs', () => {
    const upstream = {
      id: 'priced',
      type: 'openai-compatible',
      base_url: 'https://example.com/v1',
      api_key: 'key',
      strategy_weight: 1,
      pricing: { input_per_million: 10, output_per_million: 20, cached_input_per_million: 1 },
      models: { test: 'test' }
    } satisfies UpstreamConfig;

    expect(
      estimateCost(upstream, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 40 }
      })
    ).toBeCloseTo((60 * 10 + 40 * 1 + 50 * 20) / 1_000_000);

    expect(estimateCost({ ...upstream, pricing: undefined }, normalizeUsage(undefined, 1, 1))).toBe(
      0
    );
  });
});
