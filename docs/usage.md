# AgentMux Usage Guide

This guide explains how to install, configure, operate, and troubleshoot AgentMux in detail.

AgentMux is a dedicated multi-account manager for OpenCode GO. You run it on your machine, point OpenCode at `http://127.0.0.1:8787/v1`, and let AgentMux rotate between OpenCode GO subscription accounts.

## Table of Contents

- [What AgentMux Does](#what-agentmux-does)
- [Install](#install)
- [First Run](#first-run)
- [Core Concepts](#core-concepts)
- [Configuration File](#configuration-file)
- [Secrets and Environment Variables](#secrets-and-environment-variables)
- [Model Routing](#model-routing)
- [Routing Strategies](#routing-strategies)
- [Budgets and Pricing](#budgets-and-pricing)
- [Cooldowns and Failover](#cooldowns-and-failover)
- [OpenAI-Compatible API](#openai-compatible-api)
- [Client Setup](#client-setup)
- [CLI Reference](#cli-reference)
- [Dashboard and Health Checks](#dashboard-and-health-checks)
- [Provider Presets](#provider-presets)
- [Common Recipes](#common-recipes)
- [Troubleshooting](#troubleshooting)
- [Security Checklist](#security-checklist)
- [Development](#development)

## What AgentMux Does

AgentMux sits between OpenAI-compatible clients and OpenAI-compatible upstream providers.

Typical use cases:

- Rotate between multiple API keys for the same provider.
- Route one logical model name to several upstream providers.
- Avoid accounts that are rate-limited, over budget, or temporarily failing.
- Keep multiple OpenCode GO accounts behind one stable local endpoint.
- Track request counts, errors, latency, token usage, and estimated cost in SQLite.

AgentMux currently exposes:

- `GET /health`
- `GET /dashboard`
- `GET /v1/models`
- `POST /v1/chat/completions`

The `/v1/*` endpoints require `Authorization: Bearer <local AgentMux API key>` unless you explicitly set `server.allow_unauthenticated: true`.

## Install

### npm

```bash
npm install -g @ryusei-mogi/agentmux
agentmux --version
```

The unscoped npm package name `agentmux` belongs to another project. Use the scoped package name `@ryusei-mogi/agentmux`.

AgentMux requires Node.js `>=22.13`.

### GitHub Release Tarball

```bash
npm install -g https://github.com/ryusei-mogi/AgentMux/releases/download/v0.7.0/ryusei-mogi-agentmux-0.7.0.tgz
agentmux --version
```

### Homebrew

```bash
brew install ryusei-mogi/AgentMux/agentmux
agentmux --version
```

Homebrew installs from the GitHub release tarball and verifies the checksum in `Formula/agentmux.rb`.

### Local Development Checkout

```bash
git clone https://github.com/ryusei-mogi/AgentMux.git
cd AgentMux
npm install
npm run build
node dist/cli.js --version
```

## First Run

Create a config directory:

```bash
mkdir -p ~/.agentmux
```

Generate a local API key used by clients when talking to AgentMux:

```bash
export AGENTMUX_API_KEY="$(openssl rand -hex 32)"
```

Create the default config:

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

If the file already exists and you want to replace it:

```bash
agentmux init --config ~/.agentmux/agentmux.yaml --force
```

Create a local environment file for secrets:

```bash
cat > ~/.agentmux/accounts.env <<'EOF'
export AGENTMUX_API_KEY="replace-with-your-local-agentmux-api-key"
export OPENCODE_GO_A_KEY="sk-..."
export OPENCODE_GO_B_KEY="sk-..."
export OPENCODE_GO_C_KEY="sk-..."
EOF
```

Edit it:

```bash
$EDITOR ~/.agentmux/accounts.env
```

Load it into your shell:

```bash
source ~/.agentmux/accounts.env
```

Start AgentMux:

```bash
agentmux serve --config ~/.agentmux/agentmux.yaml
```

Expected output:

```text
AgentMux listening on http://127.0.0.1:8787
```

Check health:

```bash
curl http://127.0.0.1:8787/health
```

List models:

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

Send a chat completion:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [
      { "role": "user", "content": "Say hello from AgentMux." }
    ]
  }'
```

Open the dashboard:

```text
http://127.0.0.1:8787/dashboard
```

## Core Concepts

### Client

A client is anything that sends OpenAI-compatible requests to AgentMux. Examples:

- OpenCode
- Custom scripts using `curl`, `fetch`, or an OpenAI SDK configured with a custom base URL
- Any tool that supports an OpenAI-compatible `base_url`

The client only knows about AgentMux:

```text
base_url: http://127.0.0.1:8787/v1
api_key:  your AGENTMUX_API_KEY
model:    an AgentMux logical model such as deepseek-v4-flash
```

### Logical Model

A logical model is the model name clients request from AgentMux, such as:

```yaml
models:
  deepseek-v4-flash:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]
```

Clients request `deepseek-v4-flash`. AgentMux then chooses one of the upstreams listed for that logical model.

### Upstream

An upstream is an OpenCode GO account endpoint plus credentials and model mapping. AgentMux supports only one upstream type: `openai-compatible`. For OpenCode GO accounts, the `base_url` is always `https://opencode.ai/zen/go/v1`.

```yaml
upstreams:
  - id: opencode-go-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: OPENCODE_GO_A_KEY
    models:
      deepseek-v4-flash: deepseek-v4-flash
```

AgentMux calls:

```text
https://opencode.ai/zen/go/v1/chat/completions
```

with the upstream API key.

### Model Mapping

The left side is the AgentMux logical model name. The right side is the provider's actual model name:

```yaml
models:
  deepseek-v4-flash: deepseek-v4-flash
  qwen-coder: qwen/qwen-2.5-coder-32b-instruct
```

This allows clients to use one stable model name even when providers use different names.

## Configuration File

By default, AgentMux uses:

```text
~/.agentmux/agentmux.yaml
```

You can pass another path with:

```bash
agentmux serve --config ./agentmux.yaml
```

Print a complete default config:

```bash
agentmux config-example
```

### Full Example

```yaml
server:
  host: 127.0.0.1
  port: 8787
  api_key_env: AGENTMUX_API_KEY
  allow_unauthenticated: false
  cors_origins: []

database:
  path: ~/.agentmux/usage.sqlite

routing:
  default_strategy: quota_aware
  retry_attempts: 3
  request_timeout_seconds: 120
  cooldown:
    rate_limit_seconds: 900
    server_error_seconds: 300
    timeout_seconds: 180

models:
  deepseek-v4-flash:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]
  qwen-coder:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]
  kimi-k2:
    upstreams: [opencode-go-a, opencode-go-b, opencode-go-c]

upstreams:
  - id: opencode-go-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: OPENCODE_GO_A_KEY
    strategy_weight: 1
    budget:
      window: 5h
      limit_usd: 12
    pricing:
      input_per_million: 0
      output_per_million: 0
    models:
      deepseek-v4-flash: deepseek-v4-flash
      qwen-coder: qwen-coder
      kimi-k2: kimi-k2
```

### `server`

```yaml
server:
  host: 127.0.0.1
  port: 8787
  api_key_env: AGENTMUX_API_KEY
  allow_unauthenticated: false
  cors_origins: []
```

Fields:

- `host`: Interface AgentMux binds to. Use `127.0.0.1` for local-only access.
- `port`: HTTP port.
- `api_key`: Literal local API key for clients. Prefer `api_key_env` for secrets.
- `api_key_env`: Environment variable containing the local AgentMux API key.
- `allow_unauthenticated`: If `true`, `/v1/*` endpoints do not require auth. Keep this `false` for normal use.
- `cors_origins`: Browser origins allowed to call `/v1/*`. Leave empty unless a browser app needs CORS.

If `api_key_env` is set but missing from the environment, AgentMux refuses to start. If the resolved API key is shorter than 16 characters, AgentMux refuses to start.

### `database`

```yaml
database:
  path: ~/.agentmux/usage.sqlite
```

AgentMux stores runtime state and usage records in SQLite:

- upstream cooldown state
- disabled upstreams
- round-robin cursors
- request usage
- estimated cost
- latency
- error counts

The `~` prefix is expanded.

### `routing`

```yaml
routing:
  default_strategy: quota_aware
  retry_attempts: 3
  request_timeout_seconds: 120
  cooldown:
    rate_limit_seconds: 900
    server_error_seconds: 300
    timeout_seconds: 180
```

Fields:

- `default_strategy`: Strategy used when a model route does not override it.
- `retry_attempts`: Maximum number of upstreams AgentMux tries for one request. Capped by the number of available candidates.
- `request_timeout_seconds`: Timeout per upstream request.
- `cooldown.rate_limit_seconds`: Cooldown applied to rate limits and quota errors.
- `cooldown.server_error_seconds`: Cooldown applied to 5xx and generic retryable server failures.
- `cooldown.timeout_seconds`: Cooldown applied when an upstream request times out.

### `models`

```yaml
models:
  deepseek-v4-flash:
    upstreams: [opencode-go-a, opencode-go-b]
    strategy: round_robin
```

Fields:

- The key, `deepseek-v4-flash`, is the logical model clients request.
- `upstreams` is the ordered set of upstream IDs allowed for that logical model.
- `strategy` is optional and overrides `routing.default_strategy` for that model.

Every upstream referenced in a route must exist in `upstreams`.

### `upstreams`

```yaml
upstreams:
  - id: opencode-go-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: OPENCODE_GO_A_KEY
    budget:
      window: daily
      limit_usd: 5
    pricing:
      input_per_million: 0
      output_per_million: 0
    models:
      deepseek-v4-flash: deepseek-v4-flash
```

Fields:

- `id`: Unique upstream identifier used by routes and CLI commands.
- `type`: Always `openai-compatible`. This is the only supported upstream type.
- `base_url`: OpenCode GO base URL: `https://opencode.ai/zen/go/v1`.
- `api_key_env`: Environment variable containing the upstream API key.
- `api_key`: Literal upstream API key. Prefer `api_key_env`.
- `budget.window`: Budget window. Supported values are `daily`, `weekly`, `monthly`, or a duration such as `5h`.
- `budget.limit_usd`: Estimated cost ceiling for the window.
- `pricing.input_per_million`: Input token cost in USD per 1M tokens.
- `pricing.output_per_million`: Output token cost in USD per 1M tokens.
- `pricing.cached_input_per_million`: Cached input token cost in USD per 1M tokens. Defaults to `input_per_million`.
- `models`: Mapping from AgentMux logical model to upstream provider model.

Each upstream must define either `api_key_env` or `api_key`.

## Secrets and Environment Variables

Recommended pattern:

```bash
mkdir -p ~/.agentmux
touch ~/.agentmux/accounts.env
chmod 600 ~/.agentmux/accounts.env
```

Example:

```bash
export AGENTMUX_API_KEY="replace-with-a-random-local-key"
export OPENCODE_GO_A_KEY="sk-..."
export OPENCODE_GO_B_KEY="sk-..."
export OPENCODE_GO_C_KEY="sk-..."
```

Load it before starting AgentMux:

```bash
source ~/.agentmux/accounts.env
agentmux serve --config ~/.agentmux/agentmux.yaml
```

Do not commit real keys. Keep copied env files outside the repository or in ignored files.

## Model Routing

AgentMux chooses candidates in this order:

1. Find the requested logical model in `models`.
2. Load the upstream IDs listed in that route.
3. Remove upstreams that do not map the requested model.
4. Remove disabled upstreams.
5. Remove upstreams currently in cooldown.
6. Remove upstreams over their configured budget.
7. Order remaining upstreams by the route strategy.
8. Try up to `routing.retry_attempts` candidates.

If no candidate remains, AgentMux returns `503`.

## Routing Strategies

### `least_used`

Orders upstreams by the number of recorded requests in the upstream's budget window.

Use this when you want to spread requests across accounts based on recent request count.

### `round_robin`

Rotates between available upstreams. The cursor is stored in SQLite, so rotation survives process restarts.

Use this for roughly even distribution across equivalent accounts.

### `quota_aware`

Scores candidates using:

- remaining budget ratio
- success rate
- recent errors
- latency
- configured cost

This is the default. It is a good fit for OpenCode GO multi-account pools.

## Budgets and Pricing

Budgets are soft local routing limits based on AgentMux's recorded estimated cost. They do not change provider-side billing limits.

Example daily budget:

```yaml
budget:
  window: daily
  limit_usd: 10
```

Example rolling 5-hour budget:

```yaml
budget:
  window: 5h
  limit_usd: 12
```

When recorded estimated cost reaches `limit_usd`, the upstream is removed from routing until the window moves forward.

Cost estimation:

- If the upstream response includes OpenAI-compatible `usage`, AgentMux uses it.
- If usage is missing, AgentMux estimates prompt tokens with `gpt-tokenizer`.
- For streaming responses, AgentMux captures usage chunks if present and estimates output tokens from streamed text if needed.
- If `pricing` is omitted, estimated cost is `0`.

Pricing example:

```yaml
pricing:
  input_per_million: 0.14
  output_per_million: 0.28
  cached_input_per_million: 0.0028
```

## Cooldowns and Failover

AgentMux records failures and can temporarily avoid unhealthy upstreams.

Retryable conditions:

- `429`
- `402`
- response text containing `rate limit`
- response text containing `limit reached`
- response text containing `quota`
- upstream `5xx`
- request timeout
- network error

Cooldown mapping:

- `rate_limit` and `quota_exceeded`: `routing.cooldown.rate_limit_seconds`
- `timeout`: `routing.cooldown.timeout_seconds`
- other retryable server failures: `routing.cooldown.server_error_seconds`

Streaming behavior:

- If an upstream fails before a stream starts, AgentMux can try another upstream.
- Once streaming bytes have started, AgentMux cannot switch providers mid-stream.
- The next request will be routed again using the updated state.

## OpenAI-Compatible API

### List Models

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

Example response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "created": 0,
      "owned_by": "agentmux"
    }
  ]
}
```

### Non-Streaming Chat Completion

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [
      { "role": "system", "content": "You are concise." },
      { "role": "user", "content": "What is AgentMux?" }
    ]
  }'
```

### Streaming Chat Completion

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Stream a short answer." }
    ]
  }'
```

## Client Setup

### OpenCode

Example config: `examples/opencode.json`.

```json
{
  "provider": {
    "agentmux": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AgentMux",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash via AgentMux" },
        "qwen-coder": { "name": "Qwen Coder via AgentMux" },
        "kimi-k2": { "name": "Kimi K2 via AgentMux" }
      }
    }
  },
  "model": "agentmux/deepseek-v4-flash",
  "small_model": "agentmux/deepseek-v4-flash"
}
```

Add the AgentMux local API key to OpenCode through `/connect` for the `agentmux` provider, or store the same value as `AGENTMUX_API_KEY` in OpenCode's auth store.

### Other OpenAI-Compatible Clients

Use these connection values:

```text
base URL: http://127.0.0.1:8787/v1
API key:  value of AGENTMUX_API_KEY
model:    any key under models in agentmux.yaml
```

If the client expects an OpenAI API key field, put the AgentMux local key there. Do not put a provider key there; provider keys belong in AgentMux upstream config or environment variables.

### OpenAI SDK for JavaScript

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AGENTMUX_API_KEY,
  baseURL: 'http://127.0.0.1:8787/v1'
});

const result = await client.chat.completions.create({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Hello through AgentMux' }]
});

console.log(result.choices[0]?.message?.content);
```

## CLI Reference

### `agentmux init`

Create a config file:

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

Overwrite an existing config:

```bash
agentmux init --config ~/.agentmux/agentmux.yaml --force
```

### `agentmux serve`

Start the gateway:

```bash
source ~/.agentmux/accounts.env
agentmux serve --config ~/.agentmux/agentmux.yaml
```

### `agentmux status`

Show upstream state and today's usage:

```bash
agentmux status --config ~/.agentmux/agentmux.yaml
```

Output columns:

- `id`: upstream ID
- `state`: `healthy`, `cooldown`, `probation`, or `disabled`
- `requests`: request count for today
- `errors`: error count for today
- `cost`: estimated cost for today
- `latency`: average latency
- `cooldown_until`: ISO timestamp when cooldown expires, or `-`

### `agentmux upstream list`

Same status table as `agentmux status`:

```bash
agentmux upstream list --config ~/.agentmux/agentmux.yaml
```

### `agentmux upstream disable`

Temporarily remove an upstream from routing:

```bash
agentmux upstream disable opencode-go-a --config ~/.agentmux/agentmux.yaml
```

This writes runtime state to SQLite. It does not edit YAML.

### `agentmux upstream enable`

Re-enable a disabled upstream:

```bash
agentmux upstream enable opencode-go-a --config ~/.agentmux/agentmux.yaml
```

### `agentmux usage today`

Show all usage rows since the start of the current day:

```bash
agentmux usage today --config ~/.agentmux/agentmux.yaml
```

### `agentmux usage window`

Show usage since a rolling window:

```bash
agentmux usage window 5h --config ~/.agentmux/agentmux.yaml
agentmux usage window 24h --config ~/.agentmux/agentmux.yaml
```

### `agentmux preset list`

List available provider presets:

```bash
agentmux preset list
```

### `agentmux config-example`

Print the default config:

```bash
agentmux config-example
```

## Dashboard and Health Checks

### Health

```bash
curl http://127.0.0.1:8787/health
```

The response includes:

- overall status: `ok` or `degraded`
- upstream states
- configured logical models

`status` is `ok` if at least one upstream is `healthy` or `probation`.

### Dashboard

Open:

```text
http://127.0.0.1:8787/dashboard
```

The dashboard is local HTML rendered by AgentMux. It shows request volume, token usage, cost estimates, latency, errors, cooldowns, and upstream state.

## Provider Presets

List presets:

```bash
agentmux preset list
```

Available presets:

- `opencode-go` — OpenCode GO account configuration

Presets are snippets for upstream configuration. You still need to choose an `id`, configure `models`, and provide credentials.

## Common Recipes

### Three OpenCode GO Accounts

```yaml
models:
  deepseek-v4-flash:
    upstreams: [account-a, account-b, account-c]
    strategy: round_robin

upstreams:
  - id: account-a
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: ACCOUNT_A_KEY
    models:
      deepseek-v4-flash: deepseek-v4-flash
  - id: account-b
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: ACCOUNT_B_KEY
    models:
      deepseek-v4-flash: deepseek-v4-flash
  - id: account-c
    type: openai-compatible
    base_url: https://opencode.ai/zen/go/v1
    api_key_env: ACCOUNT_C_KEY
    models:
      deepseek-v4-flash: deepseek-v4-flash
```

### Browser Client with CORS

```yaml
server:
  host: 127.0.0.1
  port: 8787
  api_key_env: AGENTMUX_API_KEY
  allow_unauthenticated: false
  cors_origins:
    - http://localhost:5173
```

Only add origins you trust.

## Troubleshooting

### `Config file not found`

Create one:

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

Or pass the correct path:

```bash
agentmux serve --config ./agentmux.yaml
```

### `Missing server API key env`

If config contains:

```yaml
server:
  api_key_env: AGENTMUX_API_KEY
```

then run:

```bash
export AGENTMUX_API_KEY="$(openssl rand -hex 32)"
```

or load your env file:

```bash
source ~/.agentmux/accounts.env
```

### `Unauthorized`

Your client is not sending the expected AgentMux local API key.

Check:

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

If this works but your client fails, update the client's OpenAI API key field to the AgentMux local key.

### `No available upstreams for model`

Possible causes:

- The model does not exist under `models`.
- All routed upstreams are disabled.
- All routed upstreams are in cooldown.
- All routed upstreams are over budget.
- The upstreams listed under `models.<model>.upstreams` do not map that model under their own `models`.

Check:

```bash
agentmux status --config ~/.agentmux/agentmux.yaml
curl http://127.0.0.1:8787/health
```

### `Missing API key env for upstream`

If an upstream contains:

```yaml
api_key_env: OPENCODE_GO_A_KEY
```

then run:

```bash
export OPENCODE_GO_A_KEY="sk-..."
```

or load your env file before starting AgentMux.

### All upstreams failed

AgentMux tried every candidate allowed by `routing.retry_attempts`.

Look at:

- upstream provider status
- API key validity
- provider account quota
- local network connectivity
- `agentmux status`
- `/dashboard`

### Cost Stays at `$0.0000`

This is expected if `pricing` is missing. Add pricing to each upstream to get estimated cost.

### Streaming Stops Mid-Response

AgentMux cannot switch upstreams after bytes have started streaming. The current stream ends according to the upstream behavior; the next request will be routed again.

### Homebrew Install Fails on a Fresh Release

Homebrew's Node helper delays npm packages published in the last day when building formulae. If a newly released dependency is involved, `brew install` may work after the package age window passes. The npm install path is usually available immediately:

```bash
npm install -g @ryusei-mogi/agentmux
```

## Security Checklist

- Keep `server.allow_unauthenticated: false` unless you are intentionally running without auth.
- Prefer `server.api_key_env` over `server.api_key`.
- Prefer upstream `api_key_env` over upstream `api_key`.
- Keep secrets in `~/.agentmux/accounts.env` or another private file.
- Use `chmod 600 ~/.agentmux/accounts.env` for local secret files.
- Do not bind to `0.0.0.0` unless you understand the network exposure.
- If you expose AgentMux beyond localhost, put it behind trusted network controls.
- Do not commit real provider keys, SQLite usage databases, logs, or copied env files.

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:oss-safety
```

Start from source:

```bash
npm run dev -- serve --config ./agentmux.yaml
```

Build and run compiled output:

```bash
npm run build
node dist/cli.js serve --config ./agentmux.yaml
```
