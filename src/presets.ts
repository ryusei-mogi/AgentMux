import type { UpstreamConfig } from './types.js';

export const providerPresets: Record<string, Omit<UpstreamConfig, 'id' | 'models'>> = {
  'opencode-go': {
    type: 'openai-compatible',
    base_url: 'https://opencode.ai/zen/go/v1',
    api_key_env: 'OPENCODE_GO_API_KEY',
    strategy_weight: 1
  },
  deepseek: {
    type: 'openai-compatible',
    base_url: 'https://api.deepseek.com/v1',
    api_key_env: 'DEEPSEEK_API_KEY',
    strategy_weight: 1,
    pricing: { input_per_million: 0.27, output_per_million: 1.1, cached_input_per_million: 0.07 }
  },
  openrouter: {
    type: 'openai-compatible',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    strategy_weight: 0.5
  },
  kimi: {
    type: 'openai-compatible',
    base_url: 'https://api.moonshot.ai/v1',
    api_key_env: 'KIMI_API_KEY',
    strategy_weight: 1
  },
  qwen: {
    type: 'openai-compatible',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_env: 'DASHSCOPE_API_KEY',
    strategy_weight: 1
  },
  'zen-balance': {
    type: 'openai-compatible',
    base_url: 'https://zenrouter.net/api/v1',
    api_key_env: 'ZEN_API_KEY',
    strategy_weight: 0.5
  }
};

export function listPresetNames(): string[] {
  return Object.keys(providerPresets);
}
