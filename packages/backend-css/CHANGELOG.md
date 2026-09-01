# @tokenc/backend-css

## 0.5.0

### Patch Changes

- eb7e068: Complete the coordinated M2 release-candidate hardening with independent differential proof,
  semantic-work performance budgets, locked declarations and schemas, and packed-consumer validation.
- Updated dependencies [eb7e068]
- Updated dependencies [eb7e068]
- Updated dependencies [eb7e068]
- Updated dependencies [eb7e068]
- Updated dependencies [eb7e068]
  - @tokenc/core@0.5.0

## 0.4.0

### Minor Changes

- Replace Backend `validate + emit(compilation)` with immutable `CompilationIR`, declared
  `BackendCapabilities`, `prepare(ir) → BackendPlan`, global artifact preflight, shared symbol
  allocation, and contract-checked `emit(plan)`. Output files now carry their planned artifact ID,
  and unsafe or colliding paths prevent every Backend from emitting.
- Replace the legacy diagnostic shape and CLI JSON output with Diagnostic v1. Diagnostics now carry a
  schema version, registered code metadata, structured parameters, semantic source anchors, stable
  SHA-256 fingerprints, documentation URLs, related information, and validated structured fixes.
- Finalize the M1 public API boundary, ship the Explain Trace v1 JSON Schema, lock generated public
  declarations and machine schemas, expand differential and concurrency proof, and enforce stable
  incremental-work performance budgets in CI.

### Patch Changes

- Updated dependencies
- Updated dependencies [07f4490]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @tokenc/core@0.4.0

## 0.3.0

### Minor Changes

- dc74750: Establish a stricter semantic compilation baseline. Context-dependent references now participate in
  cycle checks only when their selectors can be active together, and diagnostics identify the active
  context. Canonical context keys now escape unsafe UTF-16 code units as `%XXXX`; consumers that set
  the generated `data-context` attribute must use the emitted canonical key. Document-root `$schema`
  declarations are accepted. Conditional-cycle candidates that exceed 16,384 Context projections now
  fail with `TOKEN_CONTEXT_PROJECTION_LIMIT` instead of consuming unbounded compilation time.

  Backends can validate a compilation before any output is emitted. The bundled backends reject
  normalized-name collisions, CSS and Tailwind serialize supported composite values without JSON
  fallbacks, unsupported lossless CSS shapes produce diagnostics, Tailwind uses a stable
  `--shadow-default` name for a top-level shadow token, and TypeScript avoids reserved binding names
  and object leaf/namespace conflicts. CSS and Tailwind now reject incomplete automatic
  multi-dimensional context coverage, duplicate selector targets, and invalid explicit context sets.
  CSS numbers and colors no longer lose precision. DTCG gradients now fail CSS/Tailwind preflight
  until an explicit platform transform supplies the missing gradient function and geometry, rather
  than emitting a non-standalone stop list. CSS font-family control characters use CSS escapes, while
  code units that CSS cannot preserve produce an unsupported-value diagnostic.

  `tokenc check` runs backend preflight without generating artifacts. Builds also reject duplicate
  normalized output paths before the CLI writes files, and dev mode reloads custom-named config files
  and their imported configuration modules when backend settings change.

### Patch Changes

- Updated dependencies [dc74750]
  - @tokenc/core@0.3.0

## 0.2.0

### Minor Changes

- 2519500: BREAKING: tokenc now accepts DTCG 2025.10 token documents only. The proprietary `tokenc` compatibility dialect, `TokenDialect`, `CompilerConfig.dialect`, parser dialect options, `CSSColor`, and shorthand string-color parsing have been removed. Existing shorthand token files must be converted to structured DTCG colors before compilation.

  This release also adds Resolver Module semantics, typed resolution traces, graph patching, affected-subgraph checking, deterministic graph/context resolution, and standard DTCG color serialization across the CLI and backends.

  DTCG 2025.10 conformance now includes reference-driven type inference across forward, chained, and cross-document aliases; a reusable RFC 6901 JSON Pointer engine and same-document `$ref`; semantic group `$extends` with provenance and cycle diagnostics; the complete named `fontWeight` alias set; shallow Resolver reference sibling overrides; runtime Resolver input guards; and typed field-level validation for cubic Bézier, stroke style, border, transition, shadow, gradient, and typography values. JSON Pointer and inheritance dependencies participate in graph queries and incremental invalidation.

### Patch Changes

- Updated dependencies [2519500]
  - @tokenc/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [9528343]
  - @tokenc/core@0.1.1
