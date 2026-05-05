# Security Policy

## Supported Versions

AgentMux is pre-1.0 software. Security fixes are applied to the latest released version and the `main` branch.

## Reporting a Vulnerability

Please do not open a public issue with exploit details, API keys, logs that contain prompts, or private configuration.

Use GitHub private vulnerability reporting when it is enabled for this repository. If it is not available, open a minimal public issue asking for a secure contact path without including sensitive details.

We aim to acknowledge reports within 7 days. Confirmed vulnerabilities will be fixed as quickly as practical, with release notes that avoid exposing working exploit instructions before users can upgrade.

## Secret Handling

- Do not commit `.env`, `accounts.env`, SQLite databases, provider keys, bearer tokens, logs, or private prompt data.
- Prefer `server.api_key_env` and upstream `api_key_env` over inline keys in YAML.
- Rotate any provider key that may have been committed, pasted into an issue, or shared in logs.
- Run `npm run check:oss-safety` before publishing source or npm packages.
