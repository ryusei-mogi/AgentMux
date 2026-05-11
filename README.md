# AgentMux

AgentMux is a dedicated multi-account manager for OpenCode GO. It multiplexes requests from OpenCode across multiple OpenCode GO subscription accounts, rotating between them to avoid rate limits and quota exhaustion.

It tracks local usage, estimates remaining quota, avoids unhealthy upstreams, and falls back when rate limits or provider errors occur.

## Start Here

If you are setting up AgentMux for the first time, start with the documentation index. Japanese readers can start from the Japanese index:

- [Documentation index in English](docs/README.md)
- [日本語のドキュメント入口](docs/README.ja.md)
- [Full usage guide in English](docs/usage.md)
- [日本語の詳細ガイド](docs/usage.ja.md)

## Features

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`
- Non-streaming and streaming chat completion proxying
- Multiple OpenCode GO account routing and model aliases
- Per-upstream custom headers and header environment variables for provider projects, orgs, and attribution
- SQLite usage tracking for tokens, estimated cost, latency, and status
- Routing strategies: `least_used`, `round_robin`, `quota_aware`
- Circuit breaker states: `healthy`, `cooldown`, `probation`, `disabled`
- Automatic cooldown recovery and retry on 429, 402, timeout, 5xx, and quota errors
- CLI status, upstream enable/disable, usage windows, config init, and provider presets
- Local dashboard at `/dashboard`
- Health check at `/health`

## For AI Agents

If you are an AI coding agent asked to install AgentMux, read [`AGENTS.md`](AGENTS.md) for step-by-step instructions.

## Install

```bash
npm install -g @ryusei-mogi/agentmux
```

Or install the GitHub release tarball directly:

```bash
npm install -g https://github.com/ryusei-mogi/AgentMux/releases/download/v0.7.0/ryusei-mogi-agentmux-0.7.0.tgz
```

Or with Homebrew:

```bash
brew install ryusei-mogi/AgentMux/agentmux
```

The unscoped npm registry name `agentmux` is owned by a different project, so use the scoped package name.

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

Point OpenCode at:

```text
base_url: http://127.0.0.1:8787/v1
api_key: value of AGENTMUX_API_KEY
model: deepseek-v4-flash
```

## Security Defaults

- AgentMux requires a local API key for `/v1/*` unless `server.allow_unauthenticated: true` is set explicitly.
- `agentmux init` generates a random `server.api_key`.
- Example configs use `server.api_key_env` so API keys stay out of tracked YAML.
- CORS is disabled by default. Add trusted origins to `server.cors_origins` only when a browser client needs them.
- The dashboard is rendered without third-party scripts.
- `.env`, `accounts.env`, SQLite databases, logs, `dist/`, and `node_modules/` are ignored.
- AgentMux does not read browser cookies, browser profiles, or private web app session stores.

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
```

## Dashboard and Health

- Dashboard: `http://127.0.0.1:8787/dashboard`
- Health: `http://127.0.0.1:8787/health`

The dashboard shows today's request volume, cost estimate, token usage, latency, errors, cooldowns, and upstream state.

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
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash via AgentMux" },
        "qwen-coder": { "name": "Qwen Coder via AgentMux" },
        "kimi-k2": { "name": "Kimi K2 via AgentMux" }
      }
    }
  },
  "model": "agentmux/deepseek-v4-flash"
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
