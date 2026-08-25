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

The backend serializes scalar values plus cubic Bézier, border, transition, and shadow composites.
Typography is emitted as lossless `-font-family`, `-font-size`, `-font-weight`, `-letter-spacing`,
and `-line-height` variables. Numbers are not rounded; sRGB values use compact hex only when every
component (including alpha) is exactly representable as an 8-bit value. DTCG gradients specify
stops but not a CSS gradient function or geometry, so they require an explicit platform transform.
Font-family control characters use CSS hexadecimal escapes; null and lone surrogate code units
cannot be represented losslessly. Those values, gradients, custom dash-array stroke styles, and
CSS-invalid negative composite fields produce `BACKEND_UNSUPPORTED_VALUE` instead of lossy or
invalid output. Normalized custom-property collisions produce `BACKEND_NAME_COLLISION` before
output is emitted.

Without `selectors`, non-default contexts use mutually exclusive selectors such as
`[data-context="brand=consumer&theme=dark"]`. Set the attribute to the complete canonical context
key at runtime. Unsafe UTF-16 code units in dimension names and values use `%XXXX` encoding in that
key. If independent override predicates can combine but that combined context was not declared,
validation reports `BACKEND_CONTEXT_COVERAGE` rather than emitting an incomplete context set.

When `selectors` is non-empty, its keys are the explicit context output set. Keys use `name=value`
clauses joined by `&`; omitted dimensions take their defaults. A configured default context replaces
`selector` (or `:root`) for the base declarations. Selectors must be non-empty and may not be reused
by different contexts. When `selector` is a custom base and explicit variants are present, put that
base in the explicit default-context entry so the complete selector set is auditable. Custom
selectors should be mutually exclusive.

Requires Node.js 22.13 or newer. Licensed under MIT.
