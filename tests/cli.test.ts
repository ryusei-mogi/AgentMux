import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProgram, main } from '../src/cli.js';

describe('CLI program', () => {
  it('prints presets and config examples', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCli(['preset', 'list']);
      expect(log.mock.calls.at(-1)?.[0]).toContain('openai');

      await runCli(['preset', 'show', 'openai']);
      expect(log.mock.calls.at(-1)?.[0]).toContain('type: openai-compatible');

      await expect(runCli(['preset', 'show', 'missing'])).rejects.toThrow(/Unknown preset/);

      await runCli(['config-example']);
      expect(log.mock.calls.at(-1)?.[0]).toContain('server:');
    } finally {
      log.mockRestore();
    }
  });

  it('creates configs and imports LiteLLM files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const configPath = join(dir, 'agentmux.yaml');
      await runCli(['init', '--config', configPath]);
      expect(existsSync(configPath)).toBe(true);
      expect(log.mock.calls.at(-1)?.[0]).toBe(`Created ${configPath}`);

      const litellmPath = join(dir, 'litellm.yaml');
      const outputPath = join(dir, 'imported.yaml');
      writeFileSync(
        litellmPath,
        [
          'model_list:',
          '  - model_name: chat',
          '    litellm_params:',
          '      model: openai/gpt-4.1',
          '      api_base: https://api.openai.com/v1',
          ''
        ].join('\n'),
        'utf8'
      );
      await runCli(['import-litellm', litellmPath, '--output', outputPath]);
      expect(existsSync(outputPath)).toBe(true);
      expect(log.mock.calls.at(-1)?.[0]).toBe(`Wrote ${outputPath}`);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manages upstream state and usage commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    try {
      const configPath = join(dir, 'agentmux.yaml');
      writeFileSync(configPath, minimalConfig(dir), 'utf8');

      await runCli(['upstream', 'disable', 'test-upstream', '--config', configPath]);
      expect(log.mock.calls.at(-1)?.[0]).toBe('Disabled test-upstream');

      await runCli(['upstream', 'enable', 'test-upstream', '--config', configPath]);
      expect(log.mock.calls.at(-1)?.[0]).toBe('Enabled test-upstream');

      await runCli(['status', '--config', configPath]);
      await runCli(['upstream', 'list', '--config', configPath]);
      await runCli(['usage', 'today', '--config', configPath]);
      await runCli(['usage', 'window', '5h', '--config', configPath]);
      expect(table).toHaveBeenCalledTimes(4);

      await expect(
        runCli(['upstream', 'disable', 'missing', '--config', configPath])
      ).rejects.toThrow(/Unknown upstream/);
      await expect(
        runCli(['usage', 'today', '--config', join(dir, 'missing.yaml')])
      ).rejects.toThrow(/Config not found/);
    } finally {
      log.mockRestore();
      table.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes main without running on import', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await main(['node', 'agentmux', 'preset', 'list']);
      expect(log.mock.calls.at(-1)?.[0]).toContain('openai');
    } finally {
      log.mockRestore();
    }
  });
});

async function runCli(args: string[]): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined
  });
  await program.parseAsync(['node', 'agentmux', ...args]);
}

function minimalConfig(dir: string): string {
  return [
    'server:',
    '  host: 127.0.0.1',
    '  port: 8787',
    '  api_key: test-server-key-that-is-long-enough',
    'database:',
    `  path: ${join(dir, 'usage.sqlite')}`,
    'routing:',
    '  default_strategy: quota_aware',
    '  retry_attempts: 3',
    '  request_timeout_seconds: 120',
    '  cooldown:',
    '    rate_limit_seconds: 900',
    '    server_error_seconds: 300',
    '    timeout_seconds: 180',
    'models:',
    '  test-model:',
    '    upstreams: [test-upstream]',
    'upstreams:',
    '  - id: test-upstream',
    '    type: openai-compatible',
    '    base_url: https://example.com/v1',
    '    api_key: upstream-key',
    '    strategy_weight: 1',
    '    models:',
    '      test-model: upstream-model',
    ''
  ].join('\n');
}
