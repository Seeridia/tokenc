# DTCG 2025.10 support

[简体中文](DTCG-SUPPORT.zh-CN.md)

DTCG 2025.10 is tokenc's only compiler source language. The table below records the implemented
surface honestly; it is not a claim of full DTCG conformance.

| Feature                                                 | Status                                | Notes                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Format `$value`, `$type`, `$description`, `$extensions` | Supported                             | Includes inherited group types and structured diagnostics.                                                                 |
| `$deprecated`                                           | Supported                             | Boolean and string metadata are retained.                                                                                  |
| `$root` tokens                                          | Supported                             | Canonical IDs retain the explicit `$root` segment.                                                                         |
| Curly-brace token aliases                               | Supported                             | Type checking, cycles, suggestions, and source locations are supported.                                                    |
| Property-level JSON Pointer aliases                     | Not yet supported                     | Reports `DTCG_UNSUPPORTED_JSON_POINTER`.                                                                                   |
| Group `$extends`                                        | Not yet supported                     | Reports `DTCG_UNSUPPORTED_GROUP_EXTENDS`.                                                                                  |
| Color type                                              | Supported for direct values           | All 14 standard color spaces, `none`, alpha, component bounds, and optional hex fallback are preserved without conversion. |
| Dimension, duration, number, font family, font weight   | Supported                             | Values are normalized into typed core models.                                                                              |
| Composite token types                                   | Partial                               | Accepted as JSON-safe values; deep field-level validation is pending.                                                      |
| Resolver sets                                           | Supported for inline and file sources | Source order and last-source-wins behavior are preserved.                                                                  |
| Resolver modifiers and inputs                           | Supported                             | Defaults, case-insensitive input matching, input validation, and explicit order are supported.                             |
| Same-document Resolver references                       | Supported for sets and modifiers      | Circular set references are diagnosed.                                                                                     |
| Resolver reference sibling overrides                    | Not yet supported                     | A stable diagnostic is emitted rather than ignoring local override keys.                                                   |
| External Resolver file references                       | Supported for whole local JSON files  | Relative local files are loaded by the compiler IO layer.                                                                  |
| External JSON Pointer / remote Resolver references      | Not yet supported                     | A stable diagnostic is emitted instead of silently misresolving.                                                           |
| `org.token-compiler.contexts` extension                 | Supported                             | Represents runtime context-dependent values within one compilation.                                                        |

## One source language

Configuration does not select a language:

```ts
defineConfig({
  source: ["tokens/**/*.json"],
});
```

`parseTokenDocument(content, source)` always parses DTCG. A string color such as
`"$value": "#0052D9"` is rejected with `DTCG_INVALID_COLOR`; colors must use the structured DTCG
representation.

## Resolver configuration

```ts
defineConfig({
  source: ["tokens/**/*.json"],
  resolver: {
    source: "tokens.resolver.json",
    input: { theme: "dark", density: "compact" },
  },
});
```

Resolver parsing is IO-independent. The high-level compiler loader resolves relative whole-file
sources; `compileDocuments` accepts an already parsed Resolver document for virtual environments.
One compilation represents one Resolver input and does not materialize the modifier Cartesian
product.

## Resolver and runtime contexts

DTCG Resolver and `org.token-compiler.contexts` solve different problems:

- Resolver composes token sources for a selected Resolver input before graph construction.
- The namespaced DTCG extension selects runtime context-dependent values within one compilation.

The extension does not replace a standard DTCG capability. Both paths produce typed, deterministic
compiler semantics.

