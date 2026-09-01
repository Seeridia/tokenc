# Terrazzo coexistence

[简体中文](TERRAZZO.zh-CN.md)

tokenc does not replace or embed Terrazzo. The supported integration is a one-way, immutable handoff
of an already-bundled standard DTCG 2025.10 JSON document.

```text
Terrazzo sources ──> Terrazzo loading/plugins/transforms/modes ──> bundled DTCG JSON
                                                                      │
                         ┌────────────────────────────────────────────┴──────┐
                         ▼                                                   ▼
              existing Terrazzo generation                       tokenc adapter
                                                                  │ DocumentLoader
                                                                  ▼
                                                           CompilerSession
                                                                  │
                                            check / diff / impact / Snapshot queries
```

## Ownership boundary

Terrazzo continues to own:

- discovery and loading of its source formats;
- plugin execution, transforms, aliases, modes, and platform-specific preprocessing;
- its templates, generated files, and write lifecycle;
- conversion of any non-standard input into a complete DTCG JSON bundle.

tokenc owns only the semantics visible in that final bundle:

- DTCG token/group parsing, types, references, metadata, and source diagnostics;
- immutable Snapshot and query behavior;
- read-only Backend preflight through `check`;
- semantic `diff`, policy evaluation, `impact`, and Report v1 rendering.

The boundary is intentionally lossy. tokenc cannot infer a transform, mode, plugin decision, or
source provenance that Terrazzo did not materialize in the bundle. Matching generated CSS or other
Terrazzo output is not claimed.

## Produce and consume the bundle

Keep the existing Terrazzo build responsible for producing a deterministic standard DTCG JSON file.
The exact Terrazzo command is project-owned because it depends on installed plugins and configuration.
After that step, pass the file contents to the example adapter:

```ts
import { readFile } from "node:fs/promises";

import { compileTerrazzoBundle } from "./examples/terrazzo-adapter/src/index.js";

const identity = "/workspace/generated/tokens.bundle.json";
const result = await compileTerrazzoBundle({
  identity,
  content: await readFile(identity, "utf8"),
});

if (result.snapshot.status !== "valid") throw new Error("Bundled DTCG is invalid");
```

The host reads the file. The adapter gives Core an in-memory `DocumentLoader`; Core receives no
filesystem or network capability from this path. External document requests are rejected so an
apparently bundled input cannot silently fetch missing semantics.

The example is a private workspace and is not a published compatibility package. Copy and own the
small boundary in the integrating repository if programmatic ingestion is needed. For ordinary CI,
point a normal `tokenc.config.ts` at the generated bundle and use the commands from [CI.md](CI.md).

## Extension classification

`classifyTerrazzoBundleExtensions()` reports every `$extensions` namespace and JSON Pointer in
stable order:

| Classification             | Meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `tokenc-interpreted`       | `org.token-compiler.contexts`; tokenc applies its documented runtime-Context semantics.    |
| `preserved-unsupported`    | The data is retained as metadata, but tokenc assigns it no semantic or transform behavior. |
| report status `invalid`    | The input is invalid JSON or an `$extensions` value is not an object.                      |
| report status `compatible` | No unsupported extension namespace was found.                                              |

Unknown extension data is not dropped and is not automatically an error. It is nevertheless marked
unsupported because a successful compile proves only the standard DTCG semantics in `$value`,
`$type`, references, and standard metadata. If an extension controls the intended value, mode, or
transform, materialize that effect during the Terrazzo bundle step before invoking tokenc.

## Failure and immutability

Each `compileTerrazzoBundle()` call owns a fresh Session and closes it after publication. A malformed
bundle returns an invalid immutable Snapshot; it cannot mutate a Snapshot returned by an earlier
call. Extension classification is a separate read-only projection and cannot alter compiler input or
Core semantics.

Use `snapshot.status`, canonical Core diagnostics, and the extension report together:

- invalid Snapshot: fail the checking step;
- valid Snapshot plus `invalid` extension report: fail because the handoff is malformed;
- valid Snapshot plus `unsupported` report: require an explicit project decision about whether the
  preserved metadata affects semantics;
- valid Snapshot plus `compatible` report: tokenc can evaluate the represented DTCG semantics.

## CI alongside existing generation

Run the two systems as separate consumers of the same materialized bundle:

```bash
vp run terrazzo-build
vp exec tokenc check --config tokenc.config.ts --format text
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json
```

Do not make tokenc write into Terrazzo's output directory. Keeping generation and checking separate
prevents one tool's failure or cleanup policy from changing the other's artifacts.
