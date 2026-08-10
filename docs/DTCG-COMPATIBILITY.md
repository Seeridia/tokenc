# DTCG 2025.10 compatibility

[简体中文](DTCG-COMPATIBILITY.zh-CN.md)

tokenc has an explicit strict `dtcg-2025.10` dialect and a backward-compatible `tokenc` dialect. Both normalize into the same typed token model before graph construction.

| Feature                                                 | Status                                 | Notes                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Format `$value`, `$type`, `$description`, `$extensions` | Full                                   | Includes inherited group types and structured diagnostics.                                                                 |
| `$deprecated`                                           | Full                                   | Boolean and string metadata are retained.                                                                                  |
| `$root` tokens                                          | Full                                   | Canonical IDs retain the explicit `$root` segment.                                                                         |
| Curly-brace token aliases                               | Full                                   | Type checking, cycles, suggestions, and source locations are supported.                                                    |
| Property-level JSON Pointer aliases                     | Not yet supported                      | Strict mode reports `DTCG_UNSUPPORTED_JSON_POINTER`.                                                                       |
| Group `$extends`                                        | Not yet supported                      | Strict mode reports `DTCG_UNSUPPORTED_GROUP_EXTENDS`.                                                                      |
| Color type                                              | Full for direct color values           | All 14 standard color spaces, `none`, alpha, component bounds, and optional hex fallback are preserved without conversion. |
| Dimension, duration, number, font family, font weight   | Full                                   | Values are normalized into typed core models.                                                                              |
| Composite token types                                   | Partial                                | Accepted as JSON-safe values; deep field-level validation is pending.                                                      |
| Resolver sets                                           | Full for inline and whole-file sources | Source order and last-source-wins behavior are preserved.                                                                  |
| Resolver modifiers and inputs                           | Full                                   | Defaults, case-insensitive input matching, input validation, and explicit order are supported.                             |
| Same-document Resolver references                       | Full for sets/modifiers                | Circular set references are diagnosed.                                                                                     |
| Resolver reference sibling overrides                    | Not yet supported                      | A stable diagnostic is emitted rather than ignoring local override keys.                                                   |
| External Resolver file references                       | Full for whole JSON files              | Relative local files are loaded by the compiler IO layer.                                                                  |
| External JSON Pointer / remote Resolver references      | Not yet supported                      | A stable diagnostic is emitted instead of silently misresolving.                                                           |
| Compatibility context extension                         | Supported                              | `org.token-compiler.contexts` is normalized to typed context overrides and uses deterministic dimension precedence.        |

## Dialects

Compatibility mode remains the v0.x default:

```ts
defineConfig({
  dialect: "tokenc",
  source: ["tokens/**/*.json"],
});
```

It accepts conveniences such as `"$value": "#0052D9"` and normalizes them to the same internal color model.

Strict mode is opt-in:

```ts
defineConfig({
  dialect: "dtcg-2025.10",
  source: ["tokens/**/*.json"],
});
```

Strict color values must use the DTCG structure. Diagnostics suggest compatibility mode when shorthand is encountered.

## Resolver configuration

```ts
defineConfig({
  dialect: "dtcg-2025.10",
  source: ["tokens/**/*.json"],
  resolver: {
    source: "tokens.resolver.json",
    input: { theme: "dark", density: "compact" },
  },
});
```

Resolver parsing is IO-independent. The high-level compiler loader resolves relative whole-file sources; `compileDocuments` accepts an already parsed resolver document for virtual or remote environments.

One compilation represents one DTCG Resolver input, matching the standard resolution process. Select another modifier context by compiling again with another `resolver.input` (or a CLI flag such as `--theme dark`). The compiler does not materialize the full modifier Cartesian product.
