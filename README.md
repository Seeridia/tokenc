# tokenc

![tokenc — A typed, graph-based compiler for DTCG Design Tokens](docs/assets/cover.png)

[English](README.md) | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/%40tokenc%2Fcore.svg?label=npm)](https://www.npmjs.com/package/@tokenc/core)
[![CI](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/%40tokenc%2Fcore.svg)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/Seeridia/tokenc)](LICENSE)

> A typed, graph-based compiler for DTCG Design Tokens.

`tokenc` compiles DTCG Design Tokens as a typed program,
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

`tokenc` consumes DTCG 2025.10 token documents. See the
[feature-support matrix](docs/DTCG-SUPPORT.md) for implemented and not-yet-supported standard
features.

```bash
npm install --save-dev @tokenc/cli @tokenc/core @tokenc/backend-css
```

Create `tokens/tokens.json`:

```json
{
  "color": {
    "$type": "color",
    "blue": {
      "600": {
        "$value": {
          "colorSpace": "srgb",
          "components": [0, 0.3215686275, 0.8509803922],
          "alpha": 1,
          "hex": "#0052D9"
        }
      }
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
tokens. The [Resolver example](examples/dtcg-resolver) demonstrates structured DTCG colors, sets,
modifiers, and explicit resolution order.

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
DTCG 2025.10
    ↓
Parser
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

The DTCG 2025.10 Resolver Module is a first-class input: sets and modifiers are composed in explicit
`resolutionOrder`, then aliases are checked on the resulting graph. The non-standard tokenc
extension `org.token-compiler.contexts` represents runtime context-dependent values within one
compilation; it is distinct from Resolver source composition, isolated from standard DTCG parsing,
and normalizes to deterministic typed context overrides.

Non-DTCG formats are outside the compiler language. Convert legacy token files to DTCG before
compilation; an importer or migrator should emit DTCG rather than bypassing the DTCG parser.

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

| Level           | Types                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| Fully validated | `color`, `dimension`, `fontFamily`, `number`, `duration`, `fontWeight`                   |
| Fully validated | `cubicBezier`, `strokeStyle`, `border`, `transition`, `shadow`, `gradient`, `typography` |

DTCG colors preserve all 14 standard color spaces, `none` components, alpha, and the optional hex
fallback. String color shorthand is not compiler input. Platform conversion remains a backend
responsibility. Composite values are validated against their DTCG field shapes and numeric ranges.

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
- [Product strategy and roadmap](docs/ROADMAP.md) · [中文](docs/ROADMAP.zh-CN.md)
- [DTCG 2025.10 support](docs/DTCG-SUPPORT.md) · [中文](docs/DTCG-SUPPORT.zh-CN.md)
- [Compiler benchmarks](benchmarks/README.md)
- [Contributing](CONTRIBUTING.md)
- [Releasing](docs/RELEASING.md)

## License

[MIT](LICENSE)
