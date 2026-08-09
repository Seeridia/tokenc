# @tokenc/backend-css

CSS Custom Properties backend for tokenc.

```bash
pnpm add -D @tokenc/core @tokenc/backend-css
```

```ts
import { css } from "@tokenc/backend-css";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  outputs: [
    css({
      output: "dist/tokens.css",
      references: "preserve",
    }),
  ],
});
```

References can be preserved as CSS `var()` expressions or resolved to literals. Context selectors emit only declarations whose generated values differ from the default context.

Requires Node.js 20 or newer. Licensed under MIT.
