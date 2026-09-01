# `@tokenc/language-server`

Language Server Protocol adapter for tokenc. The package exposes a testable server factory and the
`tokenc-language-server` stdio executable.

Workspace configuration is executable and therefore fail-closed: generic LSP clients must pass
`{ "trusted": true }` in `initializationOptions` before `tokenc.config.*` is discovered or loaded.

The server accepts incremental LSP text synchronization, applies complete open-buffer overlays to
one Core `CompilerSession` per workspace, and publishes Diagnostic v1 facts with UTF-16 ranges,
documentation links, fingerprints, related locations, and current document versions. Superseded
workspace revisions are discarded before publication.
