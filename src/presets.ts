import type { OpenAICompatibleUpstreamConfig } from './types.js';

type ProviderPreset = Omit<OpenAICompatibleUpstreamConfig, 'id' | 'models'>;

export const providerPresets: Record<string, ProviderPreset> = {
  'opencode-go': {
    type: 'openai-compatible',
    base_url: 'https://opencode.ai/zen/go/v1',
    api_key_env: 'OPENCODE_GO_API_KEY',
    strategy_weight: 1
  }
};

export function listPresetNames(): string[] {
  return Object.keys(providerPresets);
}
