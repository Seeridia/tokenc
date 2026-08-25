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

Runtime values use the same typed CSS serializers as `@tokenc/backend-css`. Unsupported lossless
CSS shapes and normalized variable collisions fail during backend validation. A token whose complete
ID is a Tailwind namespace, such as `shadow`, maps to the explicit `--shadow-default` theme variable.
Token path segments are normalized before they become `@theme` custom-property names.

Serialization preserves source number precision. An sRGB color is shortened to hexadecimal only when
every component (including a non-opaque alpha) is exactly representable as an 8-bit value; otherwise
it remains `color(srgb ...)`. DTCG gradients are rejected with `BACKEND_UNSUPPORTED_VALUE` because
their stops do not specify a CSS gradient function or geometry. Apply an explicit platform transform
before this backend when a linear, radial, or conic gradient is intended. CSS-invalid negative
composite fields, such as a shadow blur radius, and font-family strings that CSS cannot represent
losslessly are rejected by the same preflight validation.

Without `selectors`, non-default contexts use mutually exclusive selectors such as
`[data-context="brand=consumer&theme=dark"]`. Set the attribute to the complete canonical context
key at runtime. If independent override predicates can combine but that combined context was not
declared, validation reports `BACKEND_CONTEXT_COVERAGE` instead of relying on CSS cascade order.

When `selectors` is non-empty, its keys are the explicit context output set. Keys use `name=value`
clauses joined by `&`; omitted dimensions take their defaults. A configured default context replaces
the base `:root` selector. Selectors must be non-empty, may not be reused by different contexts, and
should be mutually exclusive.

Requires Node.js 22.13 or newer. Licensed under MIT.
