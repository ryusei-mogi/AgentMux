import { describe, expect, it } from 'vitest';
import { listPresetNames, providerPresets } from '../src/presets.js';

describe('provider presets', () => {
  it('lists the built-in provider preset', () => {
    expect(listPresetNames()).toEqual(['opencode-go']);
    expect(providerPresets['opencode-go']?.type).toBe('openai-compatible');
    expect(providerPresets['opencode-go']?.base_url).toBe('https://opencode.ai/zen/go/v1');
  });
});
