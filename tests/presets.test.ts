import { describe, expect, it } from 'vitest';
import { listPresetNames, providerPresets } from '../src/presets.js';

describe('provider presets', () => {
  it('lists built-in HTTP and CLI providers', () => {
    expect(listPresetNames()).toEqual(expect.arrayContaining(['openai', 'anthropic', 'codex-cli']));
    expect(providerPresets.openai?.type).toBe('openai-compatible');
    expect(providerPresets.anthropic?.type).toBe('anthropic-messages');
    expect(providerPresets['codex-cli']?.type).toBe('cli-backend');
  });

  it('keeps provider-specific routing and pricing defaults', () => {
    expect(providerPresets.deepseek?.strategy_weight).toBe(1);
    expect(providerPresets.deepseek).toMatchObject({
      pricing: { input_per_million: 0.27, output_per_million: 1.1 }
    });
    expect(providerPresets.openrouter?.strategy_weight).toBe(0.5);
  });
});
