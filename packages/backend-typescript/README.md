# @tokenc/backend-typescript

TypeScript constants backend for tokenc.

```bash
vp add -D @tokenc/core @tokenc/backend-typescript
```

```ts
import { typescript } from "@tokenc/backend-typescript";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  outputs: [
    typescript({
      output: "dist/tokens.ts",
      mode: "flat",
      references: "symbol",
    }),
  ],
});
```

The backend supports nested object output, flat exports, preserved symbol references, and resolved literal output.
Flat bindings and private bindings used by object symbol mode are allocated by Core's shared
`SymbolAllocator` and checked for normalized-name collisions before emit. The explicit `rename` map
can resolve collisions. JavaScript reserved and strict-mode binding names receive a stable `token`
prefix. sRGB colors are emitted as hex only when every channel (including alpha) is exactly
representable as an 8-bit value; otherwise the backend preserves their precision with CSS
`color(srgb ...)` syntax.

Requires Node.js 22.13 or newer. Licensed under MIT.
