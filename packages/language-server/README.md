# `@tokenc/language-server`

Language Server Protocol adapter for tokenc. The package exposes a testable server factory and the
`tokenc-language-server` stdio executable.

Workspace configuration is executable and therefore fail-closed: generic LSP clients must pass
`{ "trusted": true }` in `initializationOptions` before `tokenc.config.*` is discovered or loaded.

The server accepts incremental LSP text synchronization, applies complete open-buffer overlays to
one Core `CompilerSession` per workspace, and publishes Diagnostic v1 facts with UTF-16 ranges,
documentation links, fingerprints, related locations, and current document versions. Superseded
workspace revisions are discarded before publication.

Navigation is also snapshot-owned. The server advertises standard LSP definition, references,
document-symbol, and workspace-symbol capabilities. Alias, JSON Pointer, composite-field, and group
inheritance references resolve through Core's source index; requests wait for the current workspace
revision, preserve exact UTF-16 ranges, and return deterministic results. Document symbols retain
the canonical token/group hierarchy, while invalid or removed documents expose only facts proven by
the current snapshot.

Completion and hover are current-snapshot projections too. Completion is available only inside a
Core-proven alias and returns sorted canonical Token IDs. Hover reports the Token type, selected
expression, resolved value, effective Context, explain provenance, and relevant current diagnostics.

Generic clients can provide shared query settings at initialization:

```json
{
  "trusted": true,
  "context": { "theme": "dark" },
  "resolverInput": { "brand": "acme" },
  "workspaceSettings": {
    "file:///workspace/mobile": {
      "context": { "platform": "ios" },
      "resolverInput": { "brand": "mobile" }
    }
  }
}
```

Runtime changes use `workspace/didChangeConfiguration` with the same values under `tokenc`; scoped
entries under `workspaces` override shared entries for the exact workspace URI. `context` is a
query-only override and does not rebuild the Session snapshot. `resolverInput` selects Resolver
sources through an atomic Session transaction and is intentionally independent from `context`.
