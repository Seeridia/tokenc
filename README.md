# tokenc

![tokenc — A DTCG-native, typed, graph-based Design Token compiler](docs/assets/cover.png)

[English](README.md) | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/%40tokenc%2Fcore.svg?label=npm)](https://www.npmjs.com/package/@tokenc/core)
[![CI](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/%40tokenc%2Fcore.svg)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/Seeridia/tokenc)](LICENSE)

> A DTCG-native, typed, graph-based Design Token compiler.

Compile design tokens as a typed program—not a merged JSON dictionary. `tokenc` parses DTCG,
checks references and types, evaluates contexts lazily, and emits CSS, Tailwind CSS, or TypeScript
through independent backends.

## Why tokenc

Traditional token pipelines often grow into `JSON → deep merge → transforms → templates`.
`tokenc` uses a compiler model instead:

- **DTCG-native** — `$value`, `$type`, `$description`, `$extensions`, and group type inheritance are
  the source language.
- **Typed** — token values and references are checked before output is emitted.
- **Graph-based** — references become dependency edges, enabling cycle detection, impact analysis,
  `explain`, and `usages`.
- **Context-aware** — theme, brand, density, platform, and custom dimensions are evaluated lazily;
  no Cartesian-product dictionaries are generated.
- **Incremental** — changed files are reparsed and reverse edges identify affected tokens.
- **Backend-driven** — each target decides whether references are preserved, resolved, or emitted as
  symbols.
- **Diagnostic-first** — errors retain codes, source locations, related locations, and suggestions.

## Quick start

Requires Node.js 22.13 or newer.

```bash
npm install --save-dev @tokenc/cli @tokenc/core @tokenc/backend-css
```

Create `tokens/tokens.json`:

```json
{
  "color": {
    "$type": "color",
    "blue": {
      "600": { "$value": "#0052D9" }
    },
    "brand": {
      "default": { "$value": "{color.blue.600}" }
    }
  }
}
```

Create `tokenc.config.ts`:

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

Compile:

```bash
npx tokenc build
```

```css
:root {
  --color-blue-600: #0052d9;
  --color-brand-default: var(--color-blue-600);
}
```

See the [basic example](examples/basic) for CSS, Tailwind CSS, TypeScript, aliases, and component
tokens.

## CLI

| Command                         | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `tokenc build`                  | Validate, compile, and write configured outputs. |
| `tokenc check`                  | Validate without writing files.                  |
| `tokenc check --json`           | Emit machine-readable diagnostics.               |
| `tokenc dev`                    | Watch files and compile incrementally.           |
| `tokenc explain <token>`        | Trace a token to its literal value.              |
| `tokenc usages <token>`         | List direct and indirect dependents.             |
| `tokenc graph [token]`          | Print a dependency graph.                        |
| `tokenc graph --format mermaid` | Emit Mermaid graph syntax.                       |

Compilation errors never produce partial output artifacts.

## Compiler model

```text
DTCG JSON
    ↓
Typed AST + source provenance
    ↓
Token dependency graph
    ↓
Context resolver + type checker
    ↓
Compiler IR
    ↓
CSS / Tailwind CSS / TypeScript backends
```

References are graph edges, not strings replaced during formatting. The same graph powers alias
resolution, cycle diagnostics, topological output, incremental invalidation, impact analysis, and
the query commands.

Reference resolution is backend policy:

```ts
import { css } from "@tokenc/backend-css";
import { typescript } from "@tokenc/backend-typescript";

css({ references: "preserve" });
typescript({ references: "symbol" });
```

Contexts are sparse inputs to evaluation. A token can provide overrides through the namespaced
`org.token-compiler.contexts` extension; only matching overrides are evaluated and only changed CSS
declarations are repeated.

See [Architecture](docs/ARCHITECTURE.md) for the data model, context semantics, incremental
invalidation, and backend contracts.

## Programmatic API

```ts
import { compile, parseTokenId } from "@tokenc/core";

const result = await compile({
  source: ["tokens/**/*.json"],
});

if (result.success) {
  const impact = result.graph.analyzeImpact([parseTokenId("color.blue.600")]);
  console.log(impact.directlyAffected, impact.indirectlyAffected);
}
```

For virtual or remote inputs, use `parseTokenDocument(content, source)` and
`compileDocuments(inputs)`. Parsing is independent of filesystem IO.

## Packages

| Package                                                                                  | Role                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`@tokenc/core`](https://www.npmjs.com/package/@tokenc/core)                             | Parser, types, graph, resolver, checker, and IR.     |
| [`@tokenc/cli`](https://www.npmjs.com/package/@tokenc/cli)                               | Build, check, watch, diagnostics, and graph queries. |
| [`@tokenc/backend-css`](https://www.npmjs.com/package/@tokenc/backend-css)               | CSS Custom Properties and context selectors.         |
| [`@tokenc/backend-tailwind`](https://www.npmjs.com/package/@tokenc/backend-tailwind)     | Tailwind CSS v4 `@theme` variables.                  |
| [`@tokenc/backend-typescript`](https://www.npmjs.com/package/@tokenc/backend-typescript) | Object and flat TypeScript exports.                  |

## Token support

| Level                 | Types                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Fully validated       | `color`, `dimension`, `number`, `duration`, `fontWeight`                                 |
| Basic composite model | `cubicBezier`, `strokeStyle`, `border`, `transition`, `shadow`, `gradient`, `typography` |

Colors support CSS strings, structured sRGB, and structured OKLCH. Platform conversion remains a
backend responsibility. Composite types will receive deeper field-level validation in future
releases.

## Development

The repository uses [Vite+](https://viteplus.dev/) for runtime and package management, checks,
tests, packaging, and monorepo tasks.

```bash
vp install
vp check
vp run -r build
vp test --run
```

This is a library monorepo: packages are built with `vp pack`, orchestrated by `vp run -r build`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [中文](docs/ARCHITECTURE.zh-CN.md)
- [Contributing](CONTRIBUTING.md)
- [Releasing](docs/RELEASING.md)

## License

[MIT](LICENSE)
