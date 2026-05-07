# AgentMux

AgentMux is a local OpenAI-compatible LLM gateway for coding agents. It multiplexes requests from OpenCode, Claude Code-compatible tools, Codex-like CLIs, Cline, Continue, and other OpenAI-compatible clients across multiple providers, models, and API keys.

It tracks local usage, estimates remaining quota, avoids unhealthy upstreams, and falls back when rate limits or provider errors occur.

## Features

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`
- Non-streaming and streaming chat completion proxying
- Multiple OpenAI-compatible upstreams and model aliases
- SQLite usage tracking for tokens, estimated cost, latency, and status
- Routing strategies: `least_used`, `round_robin`, `weighted_round_robin`, `cheapest`, `fallback`, `quota_aware`
- Circuit breaker states: `healthy`, `cooldown`, `probation`, `disabled`
- Automatic cooldown recovery and retry on 429, 402, timeout, 5xx, and quota errors
- CLI status, upstream enable/disable, usage windows, config init, LiteLLM import, and provider presets
- Local dashboard at `/dashboard`
- Health check at `/health`

## Install

```bash
npm install -g https://github.com/ryusei-mogi/AgentMux/releases/download/v0.4.0/ryusei-mogi-agentmux-0.4.0.tgz
```

Or with Homebrew:

```bash
brew install ryusei-mogi/AgentMux/agentmux
```

The npm registry name `agentmux` is owned by a different project, so install from the GitHub release tarball for now. The package still exposes an `oc-router` binary alias for early users, but new docs use `agentmux`.

For local development:

```bash
npm install
npm run build
node dist/cli.js init --config ./agentmux.yaml
node dist/cli.js serve --config ./agentmux.yaml
```

## Quick Start

The default OSS example is an OpenCode Go subscription pool. Keep real credentials in ignored env files, not in YAML.

```bash
mkdir -p ~/.agentmux
cp examples/agentmux.yaml ~/.agentmux/agentmux.yaml
cp examples/accounts.env.example ~/.agentmux/accounts.env

export AGENTMUX_API_KEY="$(openssl rand -hex 32)"
perl -0pi -e "s/replace-with-a-random-32-byte-local-token/$ENV{AGENTMUX_API_KEY}/" ~/.agentmux/accounts.env

$EDITOR ~/.agentmux/accounts.env
source ~/.agentmux/accounts.env
agentmux serve --config ~/.agentmux/agentmux.yaml
```

Point OpenCode or any OpenAI-compatible client at:

```text
base_url: http://127.0.0.1:8787/v1
api_key: value of AGENTMUX_API_KEY
model: deepseek-chat
```

## Security Defaults

- AgentMux requires a local API key for `/v1/*` unless `server.allow_unauthenticated: true` is set explicitly.
- `agentmux init` generates a random `server.api_key`.
- Example configs use `server.api_key_env` so API keys stay out of tracked YAML.
- CORS is disabled by default. Add trusted origins to `server.cors_origins` only when a browser client needs them.
- The dashboard is rendered without third-party scripts.
- `.env`, `accounts.env`, SQLite databases, logs, `dist/`, and `node_modules/` are ignored.

Never commit real provider keys. Tracked files should only contain placeholders such as `sk-...`.

## OpenAI-Compatible API

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $AGENTMUX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}'
```

Streaming fallback works before a stream starts. If an upstream returns 429 or 5xx before sending bytes, AgentMux retries another upstream. After streaming has started, AgentMux cannot switch providers mid-generation; the next LLM request will be routed again.

## Configuration

See [examples/agentmux.yaml](examples/agentmux.yaml). The default config shape is:

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
```

## CLI

```bash
agentmux init
agentmux serve --config ~/.agentmux/agentmux.yaml
agentmux status --config ~/.agentmux/agentmux.yaml
agentmux upstream list --config ~/.agentmux/agentmux.yaml
agentmux upstream disable opencode-go-a --config ~/.agentmux/agentmux.yaml
agentmux upstream enable opencode-go-a --config ~/.agentmux/agentmux.yaml
agentmux usage today --config ~/.agentmux/agentmux.yaml
agentmux usage window 5h --config ~/.agentmux/agentmux.yaml
agentmux preset list
agentmux import-litellm litellm.yaml -o agentmux.yaml
```

## Dashboard and Health

- Dashboard: `http://127.0.0.1:8787/dashboard`
- Health: `http://127.0.0.1:8787/health`

The dashboard shows today's request volume, cost estimate, token usage, latency, errors, cooldowns, and upstream state.

## LiteLLM Import

```bash
agentmux import-litellm litellm.yaml -o agentmux.yaml
```

The importer maps LiteLLM `model_list` entries to OpenAI-compatible upstreams. Review generated environment variable names before running the gateway.

## OpenCode Example

Configure OpenCode as a custom OpenAI-compatible provider. See [examples/opencode.json](examples/opencode.json).

```json
{
  "provider": {
    "agentmux": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AgentMux (OpenCode Go pool)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "deepseek-chat": { "name": "DeepSeek Chat via AgentMux" },
        "qwen-coder": { "name": "Qwen Coder via AgentMux" },
        "kimi-k2": { "name": "Kimi K2 via AgentMux" }
      }
    }
  },
  "model": "agentmux/deepseek-chat"
}
```

Add AgentMux credentials through OpenCode `/connect` or by storing the `AGENTMUX_API_KEY` value for the `agentmux` provider in OpenCode's auth store. Keep OpenCode Go subscription keys in `.env` or `~/.agentmux/accounts.env`; both are ignored when copied locally.

## Development

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run check:oss-safety
```

## License

MIT
