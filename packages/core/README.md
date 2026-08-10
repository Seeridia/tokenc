# @tokenc/core

The compiler core for tokenc: a DTCG-native, typed, graph-based Design Token compiler.

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

The package exposes strict and compatibility dialect parsing, the DTCG 2025.10 Resolver document parser, typed Token AST, patchable `TokenGraph`, context-aware resolution traces, affected-subgraph checking, compiler IR, and structured diagnostics. It performs no terminal output, process termination, or artifact writes.

Strict mode is opt-in with `dialect: "dtcg-2025.10"`; the v0.x default remains the backward-compatible `tokenc` dialect.

Requires Node.js 22.13 or newer. Licensed under MIT.
