# AgentMux Control Center Privacy Policy

Last updated: 2026-05-07

AgentMux Control Center is a Mac menu bar control center for running AgentMux locally on your Mac.

## Data Collection

AgentMux Control Center does not collect, transmit, sell, or share personal data, usage analytics,
or crash analytics with the developer by default.

The app uses Apple-provided App Store Connect sales and crash reporting that may be made available to
developers by Apple for apps distributed through the Mac App Store.

## Local Data

The app stores its own configuration and runtime data inside the macOS app container by default.
When you import an existing AgentMux configuration or configure a local CLI backend, the app asks you
to select the relevant files or folders through macOS file pickers and stores security-scoped
bookmarks so it can access those locations later.

Provider API keys and the local AgentMux API key are stored in macOS Keychain. The app is designed so
configuration files reference environment variables rather than storing plaintext secrets.

## Network Activity

AgentMux runs a local server on `127.0.0.1` for local client apps. When you configure upstream model
providers or local CLI backends, AgentMux sends requests only according to the upstreams you configure.

## Diagnostics

Diagnostics export is optional and user initiated. Exported diagnostics are written locally and are
redacted to avoid including secrets or security-scoped bookmark data. Diagnostics are not uploaded
automatically.

## Contact

For privacy or support questions, open an issue at:

https://github.com/ryusei-mogi/AgentMux/issues
