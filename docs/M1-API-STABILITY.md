# M1 Public API Stability Boundary

[简体中文](M1-API-STABILITY.zh-CN.md)

M1 replaces the pre-M1 mutable compiler surface directly. The project remains in `0.x`, so this is
a documented stability boundary rather than a promise of semantic-version compatibility across all
future minor releases.

## Supported entry points

Only package-manifest exports are public. For Core these are:

- `@tokenc/core`
- `@tokenc/core/diagnostic-v1.schema.json`
- `@tokenc/core/explain-trace-v1.schema.json`
- `@tokenc/core/snapshot-diff-v1.schema.json`
- `@tokenc/core/impact-report-v1.schema.json`

Deep imports into `src/`, generated chunks, or unlisted package paths are internal. `TokenGraph`,
`TokenResolver`, checker functions, Snapshot builders, cache objects, and mutable build state are not
public construction or consumption boundaries.

The stable M1 workflow is:

```ts
import { css } from "@tokenc/backend-css";
import { createCompilerSession, parseTokenId } from "@tokenc/core";

const tokenJson = JSON.stringify({
  spacing: { $type: "dimension", $value: { value: 16, unit: "px" } },
});
const session = createCompilerSession({
  config: {
    contexts: { theme: { default: "light", values: ["light", "dark"] } },
  },
});

const snapshot = await session.apply({
  documents: [
    {
      kind: "add",
      document: { identity: "tokens.json", content: tokenJson },
    },
  ],
});

if (snapshot.status === "valid") {
  const context = snapshot.query.context({ theme: "dark" });
  const trace = snapshot.query.explain(parseTokenId("spacing"), context);
  const emission = await snapshot.emit([css({ output: "dist/tokens.css" })]);
}

await session.close();
```

`compile()` remains the one-shot convenience wrapper around a temporary Session. Long-lived tools
use `CompilerSession`. Semantic reads use `snapshot.query`; backends consume immutable
`CompilationIR` through `prepare()` and emit only their accepted `BackendPlan`.

## Versioned machine contracts

Diagnostic values, `ExplainTraceV1`, `SnapshotDiffV1`, `ImpactReportV1`, and the CLI `ReportV1` use
`schemaVersion: "1"`. Core schemas ship as Core subpath exports; Report v1 ships from the CLI
package. Query edge and impact values also carry version `"1"`. Schema changes that reject a
previously valid v1 payload require a new schema version.

The repository commits SHA-256 snapshots of every public package declaration file and versioned JSON
Schema in `contracts/m1-public-contracts.json`. `vp run check:contracts` runs after package build in
CI and release automation. An intentional public change must update code, documentation, a
Changeset, and the contract snapshot together.

## Direct breaking replacements from 0.3

- Mutable `Compilation` and `CompilationResult` are replaced by immutable
  `CompilationSnapshot`.
- `IncrementalCompiler` is replaced by `CompilerSession`; no compatibility facade remains.
- Mutable Graph patching and direct Resolver consumption are internal. Use `snapshot.query`.
- Backends now implement capabilities plus `prepare(CompilationIR) → BackendPlan → emit(plan)`.
- Diagnostics use Diagnostic v1 fingerprints, locations, related information, and structured fixes.
- CLI JSON uses versioned Diagnostic, Query, and Trace shapes; the old shape is not dual-written.
- M2 `check` and `diff` output use the shared Report v1 envelope for text, JSON, and SARIF.

No deprecated aliases or migration window are provided for these pre-M1 APIs.
