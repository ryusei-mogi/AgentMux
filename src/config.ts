import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { defaultConfigPath, defaultDatabasePath, ensureParentDir, expandHome } from './paths.js';
import type { AppConfig } from './types.js';

const routingStrategySchema = z.enum([
  'least_used',
  'round_robin',
  'weighted_round_robin',
  'cheapest',
  'fallback',
  'quota_aware'
]);

const upstreamSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('openai-compatible').default('openai-compatible'),
    base_url: z.string().url(),
    api_key_env: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    strategy_weight: z.number().positive().default(1),
    budget: z
      .object({
        window: z.union([
          z.enum(['daily', 'weekly', 'monthly']),
          z.custom<`${number}h`>((v) => /^\d+h$/.test(String(v)))
        ]),
        limit_usd: z.number().positive()
      })
      .optional(),
    pricing: z
      .object({
        input_per_million: z.number().nonnegative().optional(),
        output_per_million: z.number().nonnegative().optional(),
        cached_input_per_million: z.number().nonnegative().optional()
      })
      .optional(),
    models: z.record(z.string().min(1), z.string().min(1))
  })
  .refine((u) => u.api_key_env || u.api_key, 'upstream must define api_key_env or api_key');

export const appConfigSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8787),
    api_key: z.string().optional(),
    api_key_env: z.string().min(1).optional(),
    allow_unauthenticated: z.boolean().default(false),
    cors_origins: z.array(z.string().url()).default([])
  }),
  database: z.object({ path: z.string().default(defaultDatabasePath()) }),
  routing: z.object({
    default_strategy: routingStrategySchema.default('quota_aware'),
    retry_attempts: z.number().int().min(1).max(20).default(3),
    request_timeout_seconds: z.number().int().positive().default(120),
    cooldown: z.object({
      rate_limit_seconds: z.number().int().positive().default(900),
      server_error_seconds: z.number().int().positive().default(300),
      timeout_seconds: z.number().int().positive().default(180)
    })
  }),
  models: z.record(
    z.string().min(1),
    z.object({
      upstreams: z.array(z.string().min(1)).min(1),
      strategy: routingStrategySchema.optional()
    })
  ),
  upstreams: z.array(upstreamSchema).min(1)
});

export function loadConfig(path = defaultConfigPath()): AppConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = parse(readFileSync(path, 'utf8')) as unknown;
  const config = appConfigSchema.parse(raw);
  const apiKey = resolveServerApiKey(config.server.api_key, config.server.api_key_env);
  return {
    ...config,
    server: { ...config.server, api_key: apiKey },
    database: { path: expandHome(config.database.path) }
  };
}

export function createDefaultConfig(): AppConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 8787,
      api_key: generateServerApiKey(),
      allow_unauthenticated: false,
      cors_origins: []
    },
    database: { path: defaultDatabasePath() },
    routing: {
      default_strategy: 'quota_aware',
      retry_attempts: 3,
      request_timeout_seconds: 120,
      cooldown: { rate_limit_seconds: 900, server_error_seconds: 300, timeout_seconds: 180 }
    },
    models: {
      'deepseek-chat': { upstreams: ['opencode-go-a', 'opencode-go-b', 'opencode-go-c'] },
      'qwen-coder': { upstreams: ['opencode-go-a', 'opencode-go-b', 'opencode-go-c'] },
      'kimi-k2': { upstreams: ['opencode-go-a', 'opencode-go-b', 'opencode-go-c'] }
    },
    upstreams: ['opencode-go-a', 'opencode-go-b', 'opencode-go-c'].map((id, index) => ({
      id,
      type: 'openai-compatible',
      base_url: 'https://opencode.ai/zen/go/v1',
      api_key_env: `OPENCODE_GO_${String.fromCharCode(65 + index)}_KEY`,
      strategy_weight: 1,
      budget: { window: '5h', limit_usd: 12 },
      models: { 'deepseek-chat': 'deepseek-chat', 'qwen-coder': 'qwen-coder', 'kimi-k2': 'kimi-k2' }
    }))
  };
}

function generateServerApiKey(): string {
  return `agmx_${randomBytes(32).toString('base64url')}`;
}

function resolveServerApiKey(apiKey?: string, apiKeyEnv?: string): string | undefined {
  const value = apiKeyEnv ? process.env[apiKeyEnv] : apiKey;
  if (apiKeyEnv && !value) {
    throw new Error(`Missing server API key env: ${apiKeyEnv}`);
  }
  if (value && value.length < 16) {
    throw new Error('server.api_key must be at least 16 characters');
  }
  if (value && isPlaceholderServerApiKey(value)) {
    throw new Error('server.api_key must be replaced with a private random value');
  }
  return value;
}

function isPlaceholderServerApiKey(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('replace-with') ||
    lower.includes('change-me') ||
    lower === `local-${'router'}-key`
  );
}

export function writeDefaultConfig(path = defaultConfigPath(), force = false): void {
  if (existsSync(path) && !force) {
    throw new Error(`Config already exists: ${path}`);
  }
  ensureParentDir(path);
  writeFileSync(path, stringify(createDefaultConfig()), 'utf8');
}
