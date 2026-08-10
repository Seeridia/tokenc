---
"@tokenc/core": minor
"@tokenc/cli": minor
"@tokenc/backend-css": minor
"@tokenc/backend-tailwind": minor
"@tokenc/backend-typescript": minor
---

BREAKING: tokenc now accepts DTCG 2025.10 token documents only. The proprietary `tokenc` compatibility dialect, `TokenDialect`, `CompilerConfig.dialect`, parser dialect options, `CSSColor`, and shorthand string-color parsing have been removed. Existing shorthand token files must be converted to structured DTCG colors before compilation.

This release also adds Resolver Module semantics, typed resolution traces, graph patching, affected-subgraph checking, deterministic graph/context resolution, and standard DTCG color serialization across the CLI and backends.
