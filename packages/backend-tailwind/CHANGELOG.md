# @tokenc/backend-tailwind

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
