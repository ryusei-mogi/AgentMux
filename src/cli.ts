#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { createDefaultConfig, loadConfig, writeDefaultConfig } from './config.js';
import { UsageStore } from './db.js';
import { importLiteLLMConfig } from './litellm.js';
import { defaultConfigPath } from './paths.js';
import { listPresetNames, providerPresets } from './presets.js';
import { startServer } from './server.js';
import { parseWindow, windowStart } from './time.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentmux')
    .description('Quota-aware local OpenAI-compatible LLM gateway.')
    .version('0.6.0');

  program
    .command('init')
    .description('Create an agentmux.yaml config file')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .option('-f, --force', 'overwrite an existing config')
    .action((options: { config: string; force?: boolean }) => {
      writeDefaultConfig(options.config, options.force ?? false);
      console.log(`Created ${options.config}`);
    });

  program
    .command('serve')
    .description('Start the OpenAI-compatible router API')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((options: { config: string }) => startServer(loadConfig(options.config)));

  program
    .command('status')
    .description('Show upstream status and usage')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((options: { config: string }) => {
      const config = loadConfig(options.config);
      const store = new UsageStore(config.database.path);
      printStatus(config, store);
      store.close();
    });

  const upstream = program.command('upstream').description('Manage upstreams');

  upstream
    .command('list')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((options: { config: string }) => {
      const config = loadConfig(options.config);
      const store = new UsageStore(config.database.path);
      printStatus(config, store);
      store.close();
    });

  upstream
    .command('disable <id>')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((id: string, options: { config: string }) => setDisabled(options.config, id, true));

  upstream
    .command('enable <id>')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((id: string, options: { config: string }) => setDisabled(options.config, id, false));

  const usage = program.command('usage').description('Show usage summaries');

  usage
    .command('today')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((options: { config: string }) => printUsage(options.config, windowStart('daily')));

  usage
    .command('window <window>')
    .option('-c, --config <path>', 'config path', defaultConfigPath())
    .action((window: string, options: { config: string }) =>
      printUsage(options.config, parseWindow(window))
    );

  const preset = program.command('preset').description('Show built-in provider presets');

  preset.command('list').action(() => console.log(listPresetNames().join('\n')));

  preset.command('show <name>').action((name: string) => {
    const value = providerPresets[name];
    if (!value) throw new Error(`Unknown preset: ${name}`);
    console.log(stringify(value));
  });

  program
    .command('import-litellm <input>')
    .description('Convert a LiteLLM YAML config to agentmux.yaml')
    .option('-o, --output <path>', 'output path', defaultConfigPath())
    .action((input: string, options: { output: string }) => {
      importLiteLLMConfig(input, options.output);
      console.log(`Wrote ${options.output}`);
    });

  program
    .command('config-example')
    .description('Print the default config')
    .action(() => console.log(stringify(createDefaultConfig())));

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export function isDirectRun(entry = process.argv[1], moduleUrl = import.meta.url): boolean {
  return entry ? realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry)) : false;
}

function printStatus(config: ReturnType<typeof loadConfig>, store: UsageStore): void {
  const since = windowStart('daily');
  const rows = config.upstreams.map((upstreamConfig) => {
    const state = store.recoverExpiredCooldown(upstreamConfig.id);
    const stats = store.getStats(upstreamConfig.id, since);
    return {
      id: upstreamConfig.id,
      state: state.state,
      requests: stats.requests,
      errors: stats.errors,
      cost: `$${stats.estimated_cost.toFixed(4)}`,
      latency: `${Math.round(stats.average_latency_ms)}ms`,
      cooldown_until: state.cooldown_until ? new Date(state.cooldown_until).toISOString() : '-'
    };
  });
  console.table(rows);
}

function setDisabled(configPath: string, id: string, disabled: boolean): void {
  const config = loadConfig(configPath);
  if (!config.upstreams.some((upstreamConfig) => upstreamConfig.id === id))
    throw new Error(`Unknown upstream: ${id}`);
  const store = new UsageStore(config.database.path);
  store.setDisabled(id, disabled);
  store.close();
  console.log(`${disabled ? 'Disabled' : 'Enabled'} ${id}`);
}

function printUsage(configPath: string, since: number): void {
  if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
  const config = loadConfig(configPath);
  const store = new UsageStore(config.database.path);
  console.table(store.getUsageSince(since));
  store.close();
}
