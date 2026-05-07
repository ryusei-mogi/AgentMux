# Release Notes - v0.5.1

## Hotfix

v0.5.1 is a packaging bugfix release on top of v0.5.0.

- Fixed npm and Homebrew package bin execution when `agentmux` is launched through an installed symlink.
- Updated the Homebrew formula so same-day installs can resolve the previous Hono patch release while Homebrew's npm dependency age gate is active.

## v0.5.0 Highlights

### Highlights

AgentMux can now route across a broader set of upstream types while preserving the local OpenAI-compatible API surface. This update adds native Anthropic Messages API support, local CLI backend routing for tools such as Codex CLI and Claude Code, and richer examples for multi-key / multi-provider quota-aware routing.

### Added

- Added native `anthropic-messages` upstreams.
  - Converts local `/v1/chat/completions` requests into Anthropic Messages API requests.
  - Converts Anthropic responses back into OpenAI-compatible chat completion responses.
  - Translates Anthropic SSE streaming events into OpenAI-compatible streaming chunks.
  - Normalizes tool calls, tool results, system / developer messages, stop reasons, token usage, and cached token accounting where possible.
- Added `cli-backend` upstreams for routing to local AI CLIs.
  - Supports command arguments, optional model argument injection, stdin or argv prompt delivery, text / JSON / JSONL output parsing, custom working directories, custom environment variables, and environment variable removal.
  - Supports `serialize: true` so CLIs that share mutable profile state can process one request at a time per upstream.
  - Wraps non-streaming CLI responses as OpenAI-compatible chat completions.
  - Supports streaming CLI requests through an initial buffered SSE implementation: AgentMux waits for the CLI to finish, emits one content chunk, then emits `[DONE]`.
- Added per-upstream HTTP custom headers.
  - `headers` supports static header values.
  - `header_env` resolves header values from environment variables, useful for OpenAI organization / project headers and provider attribution headers.
- Added provider presets for OpenAI, Anthropic, Codex CLI, and Claude CLI.
- Added `examples/multi-account.yaml`.
  - Covers OpenAI projects, Anthropic accounts, OpenRouter, DeepSeek, Codex CLI profiles, and Claude Code profiles.
- Extended `examples/accounts.env.example` with multi-provider API key and CLI profile examples.

### Changed

- Generalized upstream configuration from an OpenAI-compatible-only shape into typed upstream variants: `openai-compatible`, `anthropic-messages`, and `cli-backend`.
- Expands `~` in CLI backend `command`, `cwd`, and configured `env` values during config loading.
- Improved retry and cooldown handling.
  - Broadens detection for rate limit, quota, authentication, and overloaded / server error cases.
  - Allows cooldowns to honor `Retry-After`, OpenAI rate-limit reset headers, and Anthropic rate-limit reset headers before falling back to configured cooldown durations.
- Updated the README with multi-key / multi-provider routing, Anthropic upstream configuration, CLI backend configuration, and the privacy boundary that AgentMux does not read browser cookies, browser profiles, or private web app session stores.

### Tests

- Added config coverage for the new multi-account example and CLI backend path expansion.
- Added routing coverage for mixing CLI backends with HTTP upstreams.
- Added coverage/reporting scripts and CI artifact uploads for Vitest results and coverage output.
- Expanded server coverage for:
  - custom upstream headers and usage recording,
  - Anthropic request / response conversion,
  - Anthropic streaming conversion and usage recording,
  - CLI JSON / JSONL output parsing,
  - buffered SSE responses for CLI streaming requests,
  - fallback after CLI rate-limit failures,
  - serialized CLI backend execution,
  - `Retry-After` based cooldowns.

### Compatibility Notes

- Existing `openai-compatible` upstreams remain supported.
- Anthropic and CLI upstreams are exposed through AgentMux's local OpenAI-compatible API, but provider-specific features are only normalized when they map cleanly to OpenAI chat completions.
- CLI backend routing requires the target CLI to be installed and authenticated outside AgentMux.
- AgentMux routes official API keys and local CLI profiles. It does not automate browser ChatGPT or Claude web accounts, cookies, or session stores.
