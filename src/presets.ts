import type {
  AnthropicMessagesUpstreamConfig,
  CliBackendUpstreamConfig,
  OpenAICompatibleUpstreamConfig
} from './types.js';

type ProviderPreset =
  | Omit<OpenAICompatibleUpstreamConfig, 'id' | 'models'>
  | Omit<AnthropicMessagesUpstreamConfig, 'id' | 'models'>
  | Omit<CliBackendUpstreamConfig, 'id' | 'models'>;

export const providerPresets: Record<string, ProviderPreset> = {
  openai: {
    type: 'openai-compatible',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    strategy_weight: 1
  },
  anthropic: {
    type: 'anthropic-messages',
    base_url: 'https://api.anthropic.com/v1',
    api_key_env: 'ANTHROPIC_API_KEY',
    anthropic_version: '2023-06-01',
    default_max_tokens: 4096,
    strategy_weight: 1
  },
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
  },
  'codex-cli': {
    type: 'cli-backend',
    command: 'codex',
    args: ['exec', '--json', '--color', 'never', '--skip-git-repo-check'],
    model_arg: '--model',
    input: 'arg',
    output: 'jsonl',
    env_unset: ['OPENAI_API_KEY'],
    serialize: true,
    strategy_weight: 1
  },
  'claude-cli': {
    type: 'cli-backend',
    command: 'claude',
    args: ['-p', '--output-format', 'json', '--no-session-persistence'],
    model_arg: '--model',
    input: 'arg',
    output: 'json',
    env_unset: ['ANTHROPIC_API_KEY'],
    serialize: true,
    strategy_weight: 1
  }
};

export function listPresetNames(): string[] {
  return Object.keys(providerPresets);
}
