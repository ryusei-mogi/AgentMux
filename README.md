# AgentMux

AgentMux is a local OpenAI-compatible LLM gateway for coding agents. It multiplexes requests from OpenCode, Claude Code-compatible tools, Codex-like CLIs, Cline, Continue, and other OpenAI-compatible clients across multiple providers, models, and API keys.

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
- Multiple OpenAI-compatible upstreams and model aliases
- Native Anthropic Messages upstreams exposed through the local OpenAI-compatible API
- Local CLI backend upstreams for Codex CLI, Claude Code, and other text-producing AI CLIs
- Per-upstream custom headers and header environment variables for provider projects, orgs, and attribution
- SQLite usage tracking for tokens, estimated cost, latency, and status
- Routing strategies: `least_used`, `round_robin`, `weighted_round_robin`, `cheapest`, `fallback`, `quota_aware`
- Circuit breaker states: `healthy`, `cooldown`, `probation`, `disabled`
- Automatic cooldown recovery and retry on 429, 402, timeout, 5xx, and quota errors
- CLI status, upstream enable/disable, usage windows, config init, LiteLLM import, and provider presets
- Local dashboard at `/dashboard`
- Health check at `/health`

## Install

```bash
npm install -g @ryusei-mogi/agentmux
```

Or install the GitHub release tarball directly:

```bash
npm install -g https://github.com/ryusei-mogi/AgentMux/releases/download/v0.5.1/ryusei-mogi-agentmux-0.5.1.tgz
```

Or with Homebrew:

```bash
brew install ryusei-mogi/AgentMux/agentmux
```

The unscoped npm registry name `agentmux` is owned by a different project, so use the scoped package name. The package still exposes an `oc-router` binary alias for early users, but new docs use `agentmux`.

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

## Multi-Key and Multi-Provider Routing

AgentMux can register multiple official API upstreams and route across them. This includes OpenAI API keys from different projects or organizations, Anthropic API keys, OpenRouter, DeepSeek, and other OpenAI-compatible providers. It does not automate browser ChatGPT or Claude web accounts, cookies, or sessions.

See [examples/multi-account.yaml](examples/multi-account.yaml) for a config that combines:

- `OPENAI_API_KEY_A` and `OPENAI_API_KEY_B` with `OpenAI-Organization` and `OpenAI-Project` headers
- `ANTHROPIC_API_KEY_A` and `ANTHROPIC_API_KEY_B` through native Anthropic Messages API upstreams
- OpenRouter and DeepSeek fallback upstreams

Anthropic upstreams use `type: anthropic-messages` and are converted to and from AgentMux's local OpenAI-compatible `/v1/chat/completions` API:

```yaml
models:
  claude-sonnet:
    upstreams: [anthropic-account-a, anthropic-account-b]
    strategy: quota_aware
upstreams:
  - id: anthropic-account-a
    type: anthropic-messages
    base_url: https://api.anthropic.com/v1
    api_key_env: ANTHROPIC_API_KEY_A
    anthropic_version: '2023-06-01'
    default_max_tokens: 4096
    models:
      claude-sonnet: claude-sonnet-4-5
```

Provider-side limits still apply. If two API keys share the same provider organization, project, or billing quota, AgentMux can observe failures and route around them, but it cannot multiply provider-enforced limits.

## CLI Backend Routing

AgentMux can also route to local AI CLIs through `type: cli-backend`. This is for logged-in CLI environments, not browser cookie extraction. Keep each subscription/profile isolated with the CLI's own config directory mechanism, such as `CODEX_HOME` for Codex CLI or `CLAUDE_CONFIG_DIR` for Claude Code.

CLI backend responses are wrapped as local OpenAI-compatible chat completions. Streaming requests are buffered in the initial implementation: AgentMux waits for the CLI to finish, emits one SSE content chunk, then emits `[DONE]`.

```yaml
models:
  codex-chat:
    upstreams: [codex-main, codex-sub]
    strategy: quota_aware
  claude-code:
    upstreams: [claude-main, claude-sub]
    strategy: fallback

upstreams:
  - id: codex-main
    type: cli-backend
    command: codex
    args: ['exec', '--json', '--color', 'never', '--skip-git-repo-check']
    model_arg: '--model'
    input: arg
    output: jsonl
    env:
      CODEX_HOME: ~/.codex-main
    env_unset: [OPENAI_API_KEY]
    serialize: true
    models:
      codex-chat: gpt-5.4

  - id: claude-main
    type: cli-backend
    command: claude
    args: ['-p', '--output-format', 'json', '--no-session-persistence']
    model_arg: '--model'
    input: arg
    output: json
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-main
    env_unset: [ANTHROPIC_API_KEY]
    serialize: true
    models:
      claude-code: sonnet
```

Use `serialize: true` for CLIs that store mutable profile state in one directory. AgentMux will run one request at a time for that upstream while still allowing other upstreams to run independently.

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
