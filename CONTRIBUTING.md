# Contributing

Thanks for helping make AgentMux better.

## Development

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run check:oss-safety
```

## Pull Requests

- Keep changes focused and include tests for routing, auth, config, and persistence behavior when relevant.
- Do not commit generated dependency folders, local databases, logs, `.env`, `accounts.env`, or real provider credentials.
- Use `api_key_env` in examples instead of inline API keys.
- Avoid adding browser-loaded third-party scripts to the dashboard. AgentMux often runs next to local credentials, so local-only UI should stay self-contained.
- Document user-facing config changes in `README.md` and update examples together.

## Security

Please follow [SECURITY.md](SECURITY.md) for vulnerability reports. Public issues and pull requests should not include secrets, private prompts, or exploit details that put users at risk.
