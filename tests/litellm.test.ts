import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { importLiteLLMConfig } from '../src/litellm.js';

describe('LiteLLM import', () => {
  it('imports valid LiteLLM models and skips incomplete entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-litellm-'));
    try {
      const input = join(dir, 'litellm.yaml');
      const output = join(dir, 'nested', 'agentmux.yaml');
      writeFileSync(
        input,
        [
          'model_list:',
          '  - model_name: chat',
          '    litellm_params:',
          '      model: openai/gpt-4.1',
          '      api_base: https://api.openai.com/v1',
          '      api_key: os.environ/OPENAI_API_KEY',
          '  - model_name: skipped',
          '    litellm_params:',
          '      model: missing-base',
          '  - model_name: chat',
          '    litellm_params:',
          '      model: anthropic/claude-sonnet',
          '      api_base: https://api.anthropic.com/v1',
          ''
        ].join('\n'),
        'utf8'
      );

      const config = importLiteLLMConfig(input, output);
      expect(config.models.chat?.upstreams).toEqual(['chat-1', 'chat-3']);
      expect(config.upstreams[0]).toMatchObject({
        id: 'chat-1',
        api_key_env: 'OPENAI_API_KEY',
        models: { chat: 'gpt-4.1' }
      });
      expect(config.upstreams[1]).toMatchObject({
        id: 'chat-3',
        api_key_env: 'CHAT_3_API_KEY',
        models: { chat: 'claude-sonnet' }
      });
      expect(parse(readFileSync(output, 'utf8'))).toMatchObject({
        models: { chat: { upstreams: ['chat-1', 'chat-3'] } }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
