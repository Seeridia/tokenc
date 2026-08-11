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

The compiler has one source language: DTCG 2025.10. Foreign and legacy formats must be converted to DTCG before calling the parser or compiler.

Requires Node.js 22.13 or newer. Licensed under MIT.
