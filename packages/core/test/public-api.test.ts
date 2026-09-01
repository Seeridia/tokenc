import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import * as core from "../src/index.js";

describe("M1 public API boundary", () => {
  it("exports Snapshot Diff v1 without exposing mutable compiler internals", () => {
    expect(core.compareSnapshots).toBeTypeOf("function");
    expect(core.serializeSnapshotDiff).toBeTypeOf("function");
    expect(core.buildImpactReport).toBeTypeOf("function");
    expect(core.serializeImpactReport).toBeTypeOf("function");
    expect(core.evaluateSnapshotPolicy).toBeTypeOf("function");
    expect(core.serializePolicyEvaluation).toBeTypeOf("function");
    expect(core.planResolverPermutations).toBeTypeOf("function");
    expect(core.compileResolverPermutations).toBeTypeOf("function");
    expect(core.compareResolverPermutations).toBeTypeOf("function");
  });

  it("does not export mutable Graph, Resolver, checker, or builder bypasses", () => {
    expect(core).not.toHaveProperty("TokenGraph");
    expect(core).not.toHaveProperty("TokenResolver");
    expect(core).not.toHaveProperty("checkTokenGraph");
    expect(core).not.toHaveProperty("CompilationSnapshotBuilder");
    expect(core).not.toHaveProperty("compileDocumentsInternal");
  });

  it("publishes versioned machine schemas as explicit subpaths", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({
      exports: {
        "./breaking-policy-v1.schema.json": "./schema/breaking-policy-v1.schema.json",
        "./diagnostic-v1.schema.json": "./schema/diagnostic-v1.schema.json",
        "./editor-symbol-v1.schema.json": "./schema/editor-symbol-v1.schema.json",
        "./explain-trace-v1.schema.json": "./schema/explain-trace-v1.schema.json",
        "./impact-report-v1.schema.json": "./schema/impact-report-v1.schema.json",
        "./snapshot-diff-v1.schema.json": "./schema/snapshot-diff-v1.schema.json",
      },
    });
  });
});
