# `@tokenc/language-server`

Language Server Protocol adapter for tokenc. The package exposes a testable server factory and the
`tokenc-language-server` stdio executable.

Workspace configuration is executable and therefore fail-closed: generic LSP clients must pass
`{ "trusted": true }` in `initializationOptions` before `tokenc.config.*` is discovered or loaded.
