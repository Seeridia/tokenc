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

The package exposes the DTCG parser, typed Token AST, `TokenGraph`, context-aware resolver, type checker, compiler IR, structured diagnostics, and incremental compiler. It performs no terminal output, process termination, or artifact writes.

Requires Node.js 20 or newer. Licensed under MIT.
