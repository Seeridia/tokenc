# @tokenc/backend-tailwind

Tailwind CSS v4 backend for tokenc.

```bash
pnpm add -D @tokenc/core @tokenc/backend-tailwind
```

```ts
import { tailwind } from "@tokenc/backend-tailwind";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  outputs: [tailwind({ output: "dist/tailwind.css" })],
});
```

The backend emits shared `--token-*` runtime properties and maps supported types into Tailwind v4 `@theme` namespaces. Theme switching changes the runtime layer without duplicating semantic values.

Requires Node.js 22.13 or newer. Licensed under MIT.
