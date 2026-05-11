export type UpstreamState = 'healthy' | 'cooldown' | 'probation' | 'disabled';

export type RoutingStrategy = 'least_used' | 'round_robin' | 'quota_aware';

export type BudgetWindow = 'daily' | 'weekly' | 'monthly' | `${number}h`;

export type UpstreamType = 'openai-compatible';

export interface ServerConfig {
  host: string;
  port: number;
  api_key?: string | undefined;
  api_key_env?: string | undefined;
  allow_unauthenticated?: boolean | undefined;
  cors_origins?: string[] | undefined;
}

export interface DatabaseConfig {
  path: string;
}

export interface RoutingConfig {
  default_strategy: RoutingStrategy;
  retry_attempts: number;
  request_timeout_seconds: number;
  cooldown: {
    rate_limit_seconds: number;
    server_error_seconds: number;
    timeout_seconds: number;
  };
}

export interface UpstreamBudgetConfig {
  window: BudgetWindow;
  limit_usd: number;
}

export interface UpstreamPricingConfig {
  input_per_million?: number | undefined;
  output_per_million?: number | undefined;
  cached_input_per_million?: number | undefined;
}

export interface BaseUpstreamConfig {
  id: string;
  type: UpstreamType;
  strategy_weight: number;
  budget?: UpstreamBudgetConfig | undefined;
  pricing?: UpstreamPricingConfig | undefined;
  models: Record<string, string>;
}

export interface HttpUpstreamConfig extends BaseUpstreamConfig {
  base_url: string;
  api_key_env?: string | undefined;
  api_key?: string | undefined;
  headers?: Record<string, string> | undefined;
  header_env?: Record<string, string> | undefined;
}

export interface OpenAICompatibleUpstreamConfig extends HttpUpstreamConfig {
  type: 'openai-compatible';
}

export type UpstreamConfig = OpenAICompatibleUpstreamConfig;

export interface ModelRouteConfig {
  upstreams: string[];
  strategy?: RoutingStrategy | undefined;
}

export interface AppConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  routing: RoutingConfig;
  models: Record<string, ModelRouteConfig>;
  upstreams: UpstreamConfig[];
}

export interface UsageRecordInput {
  request_id: string;
  model: string;
  upstream_id: string;
  upstream_model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  status: 'success' | 'error';
  http_status?: number | undefined;
  error_type?: string | undefined;
}

export interface UpstreamRuntimeState {
  id: string;
  state: UpstreamState;
  disabled: boolean;
  cooldown_until?: number | undefined;
  last_error?: string | undefined;
  consecutive_failures: number;
  consecutive_successes: number;
  updated_at: number;
}

export interface UpstreamStats {
  upstream_id: string;
  requests: number;
  successes: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  average_latency_ms: number;
}

export interface Candidate {
  upstream: UpstreamConfig;
  upstreamModel: string;
  state: UpstreamRuntimeState;
  stats: UpstreamStats;
  score: number;
}

export interface ChatCompletionRequest {
  model: string;
  stream?: boolean;
  messages?: unknown[];
  prompt?: unknown;
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}
