import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { appConfigSchema, createDefaultConfig } from './config.js';
import { ensureParentDir } from './paths.js';
import type { AppConfig, UpstreamConfig } from './types.js';

interface LiteLLMConfig {
  model_list?: Array<{
    model_name?: string;
    litellm_params?: {
      model?: string;
      api_base?: string;
      api_key?: string;
    };
  }>;
}

export function importLiteLLMConfig(inputPath: string, outputPath: string): AppConfig {
  const source = parse(readFileSync(inputPath, 'utf8')) as LiteLLMConfig;
  const config = createDefaultConfig();
  config.models = {};
  config.upstreams = [];

  for (const [index, item] of (source.model_list ?? []).entries()) {
    const modelName = item.model_name;
    const params = item.litellm_params;
    if (!modelName || !params?.model || !params.api_base) continue;
    const upstreamId = slugify(`${modelName}-${index + 1}`);
    const envName = `${upstreamId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    const upstream: UpstreamConfig = {
      id: upstreamId,
      type: 'openai-compatible',
      base_url: params.api_base,
      api_key_env: params.api_key?.startsWith('os.environ/')
        ? params.api_key.split('/').at(-1)
        : envName,
      strategy_weight: 1,
      models: { [modelName]: stripProviderPrefix(params.model) }
    };
    config.upstreams.push(upstream);
    config.models[modelName] = {
      upstreams: [...(config.models[modelName]?.upstreams ?? []), upstreamId]
    };
  }

  const parsed = appConfigSchema.parse(config);
  ensureParentDir(outputPath);
  writeFileSync(outputPath, stringify(parsed), 'utf8');
  return parsed;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripProviderPrefix(model: string): string {
  const parts = model.split('/');
  if (parts.length <= 1) return model;
  return parts.slice(1).join('/');
}
