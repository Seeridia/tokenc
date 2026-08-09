# tokenc

[English](README.md) | [简体中文](README.zh-CN.md)

> A DTCG-native, typed, graph-based Design Token compiler.

`tokenc` treats design tokens as a small typed program: tokens are nodes, references are dependency edges, contexts are evaluation inputs, and CSS, Tailwind, and TypeScript are compilation targets.

## Why

Traditional token pipelines commonly look like this:

```text
JSON → deep merge → transform → filter → format
```

That model makes aliases, themes, diagnostics, impact analysis, and incremental work secondary concerns. `tokenc` uses a compiler model instead:

- **DTCG-native** — `$value`, `$type`, `$description`, `$extensions`, and group type inheritance are the source language.
- **Typed** — core values have explicit models; references are checked before output.
- **Graph-based** — forward and reverse edges power resolution, cycles, `explain`, `usages`, and invalidation.
- **Context-aware** — theme, brand, density, platform, or custom dimensions are lazy evaluation inputs, not dictionaries users must merge.
- **Incremental** — changed files alone are reparsed; reverse edges select affected evaluations.
- **Compiler diagnostics** — errors retain file, line, column, related locations, codes, and suggestions.
- **Backend architecture** — output policy is isolated behind one `emit(compilation)` operation.

## Quick start

Requirements: Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm build
pnpm test
pnpm --dir examples/basic tokenc build
```

To use published packages in an application, install the CLI, core, and the backends referenced by your configuration:

```bash
pnpm add -D \
  @tokenc/cli \
  @tokenc/core \
  @tokenc/backend-css \
  @tokenc/backend-tailwind \
  @tokenc/backend-typescript
```

Create `tokenc.config.ts`:

```ts
import { defineConfig } from "@tokenc/core";
import { css } from "@tokenc/backend-css";
import { tailwind } from "@tokenc/backend-tailwind";
import { typescript } from "@tokenc/backend-typescript";

export default defineConfig({
  source: ["tokens/**/*.json"],
  contexts: {
    theme: { default: "light", values: ["light", "dark"] },
  },
  outputs: [
    css({ output: "dist/tokens.css" }),
    tailwind({ output: "dist/tailwind.css" }),
    typescript({ output: "dist/tokens.ts", mode: "flat", references: "symbol" }),
  ],
});
```

## Example

DTCG input:

```json
{
  "color": {
    "$type": "color",
    "blue": { "600": { "$value": "#0052D9" } },
    "brand": { "default": { "$value": "{color.blue.600}" } }
  },
  "button": {
    "primary": {
      "background": {
        "$type": "color",
        "$value": "{color.brand.default}"
      }
    }
  }
}
```

CSS output with reference preservation:

```css
:root {
  --color-blue-600: #0052d9;
  --color-brand-default: var(--color-blue-600);
  --button-primary-background: var(--color-brand-default);
}
```

References are not globally erased. CSS can preserve them as `var()`, TypeScript can preserve them as symbols, or either backend can request resolved literals.

## Context overrides

Context dimensions are configured once. A token may declare sparse overrides through the project extension namespace:

```json
{
  "color": {
    "page": {
      "$type": "color",
      "$value": "#ffffff",
      "$extensions": {
        "org.token-compiler.contexts": {
          "theme=dark": { "$value": "#111111" },
          "theme=dark&brand=enterprise": { "$value": "#0b0b0b" }
        }
      }
    }
  }
}
```

The extension is intentionally narrow and namespaced; it does not invent a second token language. Resolution chooses the most-specific matching override. The compiler enumerates only declared contexts and evaluates tokens on demand—never a full theme × brand × density Cartesian product.

CSS selectors can be explicit:

```ts
css({
  selectors: {
    "theme=light": ":root",
    "theme=dark": "[data-theme='dark']",
  },
});
```

Only declarations whose emitted representation differs from the default block are repeated.

## Tailwind v4 design

The Tailwind backend emits one runtime token layer and maps supported token types into Tailwind's CSS-first namespace:

```css
:root {
  --token-color-brand-primary: var(--token-color-blue-600);
}

@theme {
  --color-brand-primary: var(--token-color-brand-primary);
}
```

This indirection is deliberate: CSS and Tailwind share the same runtime value, theme switching changes only `--token-*`, and semantic values are not duplicated. Color, spacing, radius, font-weight, and shadow namespaces are supported.

## CLI

```bash
tokenc build
tokenc check
tokenc check --json
tokenc dev
tokenc explain button.primary.background
tokenc explain button.primary.background --theme dark
tokenc usages color.blue.600
tokenc graph color.brand.default
tokenc graph --format mermaid
```

`build` writes nothing when compilation contains an error. `check --json` exposes stable diagnostic objects for CI and future editor integrations. `dev` debounces file events, handles add/change/remove, survives invalid JSON, and recovers after the next valid edit.

## Programmatic API

```ts
import { compile, parseTokenId } from "@tokenc/core";

const result = await compile({
  cwd: process.cwd(),
  source: ["tokens/**/*.json"],
  outputs: [],
});

if (result.success) {
  const impact = result.graph.analyzeImpact([parseTokenId("color.blue.600")]);
  console.log(impact.directlyAffected, impact.indirectlyAffected);
}
```

For virtual or remote sources, use `parseTokenDocument(content, source)` and `compileDocuments(inputs)`. The parser performs no filesystem IO.

## Architecture

```text
DTCG JSON
    ↓
Parser + source map
    ↓
Typed Token AST
    ↓
Dependency Graph
    ↓
Context Resolver
    ↓
Type Checker
    ↓
Compiler IR
    ↓
Backend
    ↓
CSS / Tailwind / TypeScript
```

### Why graph-based?

The same `TokenGraph` provides O(1) token/adjacency lookup and O(V + E) traversal for dependency analysis, circular-reference diagnostics, topological output order, incremental invalidation, impact analysis, `explain`, and `usages`. No command searches raw JSON text.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the detailed model and decisions.

Release preparation is documented in [docs/RELEASING.md](docs/RELEASING.md). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Packages

- `@tokenc/core` — parser, typed model, graph, resolver, checker, IR, loader, incremental session.
- `@tokenc/backend-css` — custom properties and sparse selector overrides.
- `@tokenc/backend-tailwind` — Tailwind v4 runtime variables and `@theme` bindings.
- `@tokenc/backend-typescript` — nested object or flat symbol exports.
- `@tokenc/cli` — configuration, diagnostics, file output, queries, and watch mode.

## Supported token types

The first release fully validates `color`, `dimension`, `number`, `duration`, and `fontWeight`. It has typed extension slots and basic JSON-shape retention for `cubicBezier`, `strokeStyle`, `border`, `transition`, `shadow`, `gradient`, and `typography`.

Color values support hex/CSS strings, structured sRGB, and structured OKLCH. The core retains platform-neutral color data; each backend owns serialization policy.

## Development

```bash
pnpm check
pnpm lint
pnpm format:check
pnpm build
pnpm typecheck
pnpm test
```

The workspace uses [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) for linting and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) for deterministic formatting. Run `pnpm format` to apply formatting and `pnpm lint:fix` for safe automatic lint fixes.

The project is licensed under MIT.
