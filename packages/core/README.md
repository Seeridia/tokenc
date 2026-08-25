# @tokenc/core

The compiler core for tokenc: a typed, graph-based compiler for DTCG Design Tokens.

```bash
pnpm add -D @tokenc/core
```

```ts
import { compile, parseTokenId } from "@tokenc/core";

const result = await compile({
  source: ["tokens/**/*.json"],
});

const impact = result.graph.analyzeImpact([parseTokenId("color.blue.600")]);
```

The package exposes the DTCG 2025.10 token and Resolver document parsers, typed Token AST, patchable `TokenGraph`, context-aware resolution traces, affected-subgraph checking, compiler IR, and structured diagnostics. It performs no terminal output, process termination, or artifact writes.

Context-aware cycle checking projects only the dimensions relevant to each cyclic candidate region.
It computes the projection size before enumeration and enforces the exported
`CONTEXT_CYCLE_PROJECTION_LIMIT` of 16,384 contexts per region. Larger projections fail with a
source-backed `TOKEN_CONTEXT_PROJECTION_LIMIT` error that identifies the region and dimensions;
the checker never silently skips an incomplete cycle analysis.

Backends may implement an optional read-only `validate(compilation)` preflight. Its diagnostics are
merged into the compilation result before any backend emits, so a target-name collision or an
unsupported platform value cannot leave a partial output set.
Artifact paths are resolved absolutely, normalized to Unicode NFC, and compared case-insensitively,
so a build cannot silently overwrite another backend's output on a different filesystem.

The compiler has one source language: DTCG 2025.10. Foreign and legacy formats must be converted to DTCG before calling the parser or compiler.

Requires Node.js 22.13 or newer. Licensed under MIT.
