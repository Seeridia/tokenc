import { describe, expect, it } from "vite-plus/test";

import { BENCHMARK_CASES, benchmarkCase, fixtureSha256 } from "../fixtures.js";

describe("benchmark fixtures", () => {
  it("hashes logical fixture content deterministically", () => {
    const first = fixtureSha256([
      { path: "b.tokens.json", content: "two" },
      { path: "a.tokens.json", content: "one" },
    ]);
    const second = fixtureSha256([
      { path: "./a.tokens.json", content: "one" },
      { path: "b.tokens.json", content: "two" },
    ]);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(fixtureSha256([{ path: "a.tokens.json", content: "changed" }])).not.toBe(first);
  });

  it("rejects absolute, parent-relative, and duplicate fixture paths", () => {
    expect(() => fixtureSha256([{ path: "/private/tokens.json", content: "{}" }])).toThrow(
      "relative path",
    );
    expect(() => fixtureSha256([{ path: "../tokens.json", content: "{}" }])).toThrow(
      "relative path",
    );
    expect(() =>
      fixtureSha256([
        { path: "tokens.json", content: "{}" },
        { path: "./tokens.json", content: "{}" },
      ]),
    ).toThrow("duplicate path");
  });

  it("covers every required benchmark class with unique stable metadata", () => {
    expect(new Set(BENCHMARK_CASES.map((definition) => definition.id)).size).toBe(
      BENCHMARK_CASES.length,
    );
    expect(new Set(BENCHMARK_CASES.map((definition) => definition.group))).toEqual(
      new Set([
        "small",
        "wide",
        "deep",
        "fan-out",
        "sparse-context",
        "multidimensional-context",
        "override-heavy",
        "incremental",
        "representative",
        "dtcg-examples",
      ]),
    );
    expect(
      BENCHMARK_CASES.filter((definition) => definition.group === "multidimensional-context").map(
        (definition) => definition.fixture.parameters?.dimensions,
      ),
    ).toEqual([8, 10, 12, 14, 15]);
    expect(
      BENCHMARK_CASES.filter((definition) => definition.group === "dtcg-examples"),
    ).toHaveLength(7);
    expect(BENCHMARK_CASES.every((definition) => definition.fixture.files > 0)).toBe(true);
    expect(BENCHMARK_CASES.every((definition) => definition.fixture.bytes > 0)).toBe(true);
    expect(
      BENCHMARK_CASES.every((definition) =>
        /^sha256:[a-f0-9]{64}$/u.test(definition.fixture.sha256),
      ),
    ).toBe(true);
  });

  it("labels the representative project synthetic and exercises CSS emit", async () => {
    const definition = benchmarkCase("synthetic/representative/cold/css");
    expect(definition).toMatchObject({
      group: "representative",
      fixture: { kind: "synthetic" },
      operation: { outputTarget: "css" },
      expected: { success: true, tokens: 2_000, outputFiles: 1 },
    });
    const invocation = await definition!.createInvocation();
    const measured = await invocation.run();
    expect(measured.result).toMatchObject({
      success: true,
      stats: { tokens: 2_000, references: 1_400 },
    });
    expect(measured.result.outputs).toHaveLength(1);
    await expect(invocation.run()).rejects.toThrow("already run");
  });

  it("creates an initialized incremental invocation for each point-edit sample", async () => {
    const definition = benchmarkCase("synthetic/incremental/point-edit/10000+12")!;
    const first = await (await definition.createInvocation()).run();
    const second = await (await definition.createInvocation()).run();
    expect(first.incremental).toEqual({
      changedTokens: 1,
      affectedTokens: 12,
      recomputedTokens: 12,
      graphTouchedNodes: 1,
      graphTouchedEdges: 0,
    });
    expect(second.incremental).toEqual(first.incremental);
    expect(first.result.stats).toMatchObject({ tokens: 10_012, references: 11 });
  });

  it("pins all dtcg-examples resolvers and records expected diagnostics", async () => {
    const definition = benchmarkCase("ecosystem/dtcg-examples/shopify-polaris/default")!;
    expect(definition.fixture.package).toEqual({
      name: "dtcg-examples",
      version: "1.1.3",
      license: "MIT",
    });
    expect(definition.expected).toMatchObject({ success: true, tokens: 67, diagnostics: {} });
    const measured = await (await definition.createInvocation()).run();
    expect(measured.result.success).toBe(true);
    expect(measured.result.stats.tokens).toBe(67);

    const adobe = benchmarkCase("ecosystem/dtcg-examples/adobe-spectrum/default")!;
    expect(adobe.expected.success).toBe(false);
    expect(adobe.expected.diagnostics).toMatchObject({ TOKEN_CANNOT_INFER_TYPE: 111 });
  });
});
