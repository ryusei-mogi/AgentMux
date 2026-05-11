# AGENTS.md — AI Agent Quick-Start for AgentMux

This file is designed to be read by AI coding agents (OpenCode, Claude Code, Codex CLI, etc.) when a user asks you to install and configure AgentMux on their machine.

## What is AgentMux?

AgentMux is a local HTTP gateway that bundles multiple OpenCode Go subscription accounts behind a single OpenAI-compatible API endpoint. Your user has multiple OpenCode Go accounts and wants to use them all through one local endpoint.

## Quick Install + Configure for OpenCode

Run these commands in order. All commands are safe to execute.

### Step 1: Install AgentMux

```bash
npm install -g @ryusei-mogi/agentmux
```

Verify:
```bash
agentmux --version
# Expected: 0.7.0 or later
```

### Step 2: Create config directory and generate local API key

```bash
mkdir -p ~/.agentmux
export AGENTMUX_API_KEY="$(openssl rand -hex 32)"
```

### Step 3: Create the AgentMux config file

```bash
agentmux init --config ~/.agentmux/agentmux.yaml
```

### Step 4: Create the secrets file

Read `examples/accounts.env.example` for the template. Create `~/.agentmux/accounts.env` with the user's actual OpenCode Go API keys. The user must provide their API keys — AgentMux does not store keys in the repository.

Template:
```bash
cat > ~/.agentmux/accounts.env <<'ENVEOF'
export AGENTMUX_API_KEY="FILL_IN_YOUR_LOCAL_KEY"
export OPENCODE_GO_A_KEY="FILL_IN"
export OPENCODE_GO_B_KEY="FILL_IN"
export OPENCODE_GO_C_KEY="FILL_IN"
ENVEOF
chmod 600 ~/.agentmux/accounts.env
```

**IMPORTANT**: Ask the user for their OpenCode Go API keys before writing this file. Never invent or guess keys. If the user doesn't have keys ready, stop and tell them to get keys from [OpenCode Go](https://opencode.ai) first.

### Step 5: Load secrets and start AgentMux

```bash
source ~/.agentmux/accounts.env
agentmux serve --config ~/.agentmux/agentmux.yaml
```

AgentMux is now running at `http://127.0.0.1:8787`.

### Step 6: Configure OpenCode to use AgentMux

Read the current OpenCode configuration. The config file location depends on how OpenCode is installed:

- **OpenCode CLI**: `~/.config/opencode/config.json` or `opencode.json` in the workspace
- **OpenCode Desktop**: Use `/connect` command inside OpenCode

Add AgentMux as a provider. The configuration format is:

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

Reference: `examples/opencode.json` contains the exact configuration.

### Step 7: Verify

```bash
curl http://127.0.0.1:8787/health
# Expected: {"status":"ok","upstreams":[...],"models":[...]}

curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $AGENTMUX_API_KEY"
# Expected: list of configured models
```

Open `http://127.0.0.1:8787/dashboard` in a browser to see live usage.

## Troubleshooting

- **"Config file not found"**: Run `agentmux init` (Step 3).
- **"Missing server API key env"**: Run `source ~/.agentmux/accounts.env` (Step 5).
- **"No available upstreams for model"**: Check that API keys are set in `~/.agentmux/accounts.env` and the upstream IDs match `agentmux.yaml`.
- **Port 8787 already in use**: Change `server.port` in `~/.agentmux/agentmux.yaml` or stop the conflicting process.

## Key Files

| File | Purpose |
|---|---|
| `~/.agentmux/agentmux.yaml` | Main configuration |
| `~/.agentmux/accounts.env` | API keys (secret, chmod 600) |
| `~/.agentmux/usage.sqlite` | Usage database (auto-created) |
| `examples/opencode.json` | OpenCode provider config reference |
| `examples/agentmux.yaml` | Default config reference |

## Configuration Notes

- Default config creates 3 upstreams (`opencode-go-a`, `opencode-go-b`, `opencode-go-c`) all pointing at `https://opencode.ai/zen/go/v1`.
- Each upstream has a 5-hour budget of $12 by default. Adjust in `agentmux.yaml`.
- The default routing strategy is `quota_aware` which balances usage across accounts.
- All upstreams are `type: openai-compatible`. No other types are supported in v0.7.0+.
