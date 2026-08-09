# @tokenc/backend-typescript

TypeScript constants backend for tokenc.

```bash
pnpm add -D @tokenc/core @tokenc/backend-typescript
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

Requires Node.js 20 or newer. Licensed under MIT.
