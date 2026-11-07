# adapters/opencode

Fully wired (v1) — see the top-level `README.md` for the authoritative usage docs
(config options, enabling as a plugin, persistence). This directory contains:

- `map.ts` — translates opencode SDK message types to/from `NeutralMessage`
- `plugin.ts` — the plugin factory; binds the core pipeline to opencode's hooks
  (`messages.transform`, `system.transform`, `text.complete`, `event`, `config`,
  `command.execute.before`) and registers the `compress` tool
- `tool.ts` — the `compress` tool implementation
- `services.ts` — `FilePersistence` (JSON sidecar per session), `AnthropicTokenizer`
  (falls back to char/4), `AdapterLogger`
- `config.ts` — opencode plugin options → `CoreConfig` translation
- `host-types.ts` — local declarations mirroring the vendored opencode plugin API

The OpenCode V2 plugin API binding lives in `../opencode-v2/` and reuses this
adapter unchanged through a V1 `PluginInput` facade.
