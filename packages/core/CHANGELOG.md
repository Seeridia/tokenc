# @tokenc/core

## 0.5.0

### Minor Changes

- eb7e068: Add immutable Snapshot Diff v1 comparison for one explicit Context, including deterministic token
  facts, advisory rename candidates, dual-Graph impact, optional Backend plan comparison, incomplete
  coverage handling, deterministic JSON serialization, and an exported JSON Schema.
- eb7e068: Add immutable Impact Report v1 construction and deterministic serialization, including
  source-owned Token facts, optional base-Snapshot impact, Context Predicate coverage, and a public
  JSON Schema. Add `tokenc impact <source...> --context name=value --format text|json` with explicit
  empty/unknown source results and fail-closed exit behavior.
- eb7e068: Add immutable, lazy Resolver permutation planning with exact Context filters and mandatory bounds,
  ordered Session compilation, Snapshot Diff v1 comparison, and whole-batch Backend preflight before
  optional emission.
- eb7e068: Add Breaking-change Policy v1 with documented severity defaults, Context-scoped rules, auditable
  stable-change allow entries, fail-closed validation, deterministic Diagnostic findings, and a public
  JSON Schema. Add `tokenc diff --policy <path>` with shared text/JSON finding identity and exit codes
  for pass, policy failure, and incomplete decisions.

### Patch Changes

- eb7e068: Complete the coordinated M2 release-candidate hardening with independent differential proof,
  semantic-work performance budgets, locked declarations and schemas, and packed-consumer validation.

## 0.4.0

### Minor Changes

- Replace Backend `validate + emit(compilation)` with immutable `CompilationIR`, declared
  `BackendCapabilities`, `prepare(ir) → BackendPlan`, global artifact preflight, shared symbol
  allocation, and contract-checked `emit(plan)`. Output files now carry their planned artifact ID,
  and unsafe or colliding paths prevent every Backend from emitting.
- 07f4490: Expose complete compiler stage timings and read-only Context cycle-analysis work metrics through
  `CompilationResult.stats`. The existing `parse` timing now measures parsing only; linking has its
  own `link` field, and token resolution has its own `resolve` field.
- Lock CLI and bundled-backend consumers to public Core boundaries. All CLI commands now compile with
  `CompilerSession`; dev reuses one Session for config and Resolver reloads with latest-wins
  cancellation, and Query exposes effective Context construction without IR access.
- Add the transactional, correctness-first `CompilerSession`, injectable document loading, and a
  reusable full-compilation differential oracle. Migrate one-shot compilation, CLI dev mode, and the
  point-edit benchmark to immutable Session snapshots, and remove `IncrementalCompiler` and mutable
  Graph patching without compatibility aliases.
- Replace ID-only token dependency arrays and graph adjacency queries with source-located conditional
  dependency occurrences and edges. Context predicates now support exact symbolic intersection, union,
  complement, and subtraction without enumerating the Context Cartesian product.
- Replace the legacy diagnostic shape and CLI JSON output with Diagnostic v1. Diagnostics now carry a
  schema version, registered code metadata, structured parameters, semantic source anchors, stable
  SHA-256 fingerprints, documentation URLs, related information, and validated structured fixes.
- Replace mutable compilation results and implicit Backend output with immutable, revisioned
  `CompilationSnapshot` values. Valid snapshots expose fixed Query/IR state and explicit
  `prepare(backends)` / `emit(backends)` operations; invalid snapshots retain safe graph queries while
  resolution and explanation report unavailable.
- Finalize the M1 public API boundary, ship the Explain Trace v1 JSON Schema, lock generated public
  declarations and machine schemas, expand differential and concurrency proof, and enforce stable
  incremental-work performance budgets in CI.
- Add the read-only, predicate-aware Compilation Query API and versioned ExplainTraceV1. Migrate CLI
  explain, usages, and graph commands to the facade with deterministic v1 JSON output.
- Add Session-owned parser, cross-document Link component, conditional Graph, and Context-aware
  resolver caches. Expose immutable `SessionMetrics` with per-stage hit, miss, reuse, recomputation,
  and invalidation data while keeping Backend plan caching disabled without a complete stable key.

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

## 0.2.0

### Minor Changes

- 2519500: BREAKING: tokenc now accepts DTCG 2025.10 token documents only. The proprietary `tokenc` compatibility dialect, `TokenDialect`, `CompilerConfig.dialect`, parser dialect options, `CSSColor`, and shorthand string-color parsing have been removed. Existing shorthand token files must be converted to structured DTCG colors before compilation.

  This release also adds Resolver Module semantics, typed resolution traces, graph patching, affected-subgraph checking, deterministic graph/context resolution, and standard DTCG color serialization across the CLI and backends.

  DTCG 2025.10 conformance now includes reference-driven type inference across forward, chained, and cross-document aliases; a reusable RFC 6901 JSON Pointer engine and same-document `$ref`; semantic group `$extends` with provenance and cycle diagnostics; the complete named `fontWeight` alias set; shallow Resolver reference sibling overrides; runtime Resolver input guards; and typed field-level validation for cubic Bézier, stroke style, border, transition, shadow, gradient, and typography values. JSON Pointer and inheritance dependencies participate in graph queries and incremental invalidation.

## 0.1.1

### Patch Changes

- 9528343: Upgrade the CLI file-watching runtime to Chokidar 5, remove the unused watcher dependency from core, and retain the existing Node.js 22.13 baseline.
