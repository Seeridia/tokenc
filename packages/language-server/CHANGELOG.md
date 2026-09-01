# @tokenc/language-server

## 0.6.0

### Minor Changes

- d859461: Add semantic prepare-rename and rename transport backed by Core's atomic planner, including
  structured collision failures and version, revision, and digest guards. Add registry-authorized
  Diagnostic quick fixes with versioned multi-document edits and stale-result rejection.
- 5d7fadc: Index syntax-proven group declarations so inheritance references resolve to canonical source ranges.
  Add current-snapshot LSP definition, references, document-symbol, and workspace-symbol handlers with
  exact UTF-16 locations, canonical hierarchy, deterministic ordering, invalid-input safety, and
  removed-document clearing.
- bd02f13: Add Diagnostic v1 to LSP 3.17 projection with exact UTF-16 ranges, related information,
  documentation links, fingerprints, fix metadata, and document versions. Publish only current
  workspace revisions, clear removed documents, recover automatically from invalid buffers, and
  discard superseded work before Session commit or protocol publication.
- 2eba054: Add the public `@tokenc/language-server` package with pinned LSP 3.17 dependencies, a stdio
  executable, a testable server factory, fail-closed workspace trust, isolated multi-root compiler
  sessions, open-buffer overlays, watched-file routing, and latest-wins revision scheduling. Export the
  CLI's trusted config snapshot and Core Session configuration adapters so hosts reuse one config
  loading authority, including cache-safe executable config reloads.
- 85f14bb: Add Core-backed alias completion and Context-aware hover with exact replacement ranges, resolved
  values, explain provenance, and current diagnostics. Support isolated per-workspace ordinary Context
  overrides and transactional Resolver input changes through initialization and runtime configuration.

### Patch Changes

- Updated dependencies [5d7fadc]
- Updated dependencies [b4a18f6]
- Updated dependencies [2eba054]
  - @tokenc/core@0.6.0
  - @tokenc/cli@0.6.0
