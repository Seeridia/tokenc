import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  checkTokenGraph,
  checkTokenGraphDetailed,
  CONTEXT_CYCLE_PROJECTION_LIMIT,
  suggestTokenIds,
} from "../src/checker.js";
import { compileDocuments } from "../src/compiler.js";
import { TokenGraph } from "../src/graph.js";
import type { ContextDefinition } from "../src/model.js";
import { parseTokenDocument } from "../src/parser.js";
import { parseTokenId } from "../src/token-id.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
const graph = (name: string) => new TokenGraph(parseTokenDocument(fixture(name), name).tokens);
const diagnostics = (name: string, contexts: ContextDefinition = {}) =>
  checkTokenGraph(graph(name), undefined, contexts);
const detailedCheck = (name: string, contexts: ContextDefinition = {}) =>
  checkTokenGraphDetailed(graph(name), undefined, contexts);

const themeContexts: ContextDefinition = {
  theme: { default: "light", values: ["light", "dark"] },
};

describe("type checker", () => {
  it("accepts same-type alias chains without recording cycle work", () => {
    expect(diagnostics("aliases/tokens.json")).toEqual([]);
    expect(detailedCheck("aliases/tokens.json").metrics).toEqual({
      candidateRegions: 0,
      relevantDimensions: 0,
      estimatedProjections: 0,
      estimateSaturated: false,
      enumeratedProjections: 0,
      earlyExits: 0,
      limitHits: 0,
    });
  });

  it("rejects cross-type references with related source", () => {
    const result = diagnostics("types/invalid.json");
    expect(result[0]).toMatchObject({
      code: "TOKEN_REFERENCE_TYPE_MISMATCH",
      related: [{ source: { file: "types/invalid.json" } }],
    });
  });

  it("suggests nearby unknown token IDs", () => {
    const result = diagnostics("invalid/unknown.json");
    expect(result[0]).toMatchObject({
      code: "TOKEN_UNKNOWN_REFERENCE",
      suggestions: ["color.blue.600", "color.blue.700"],
    });
  });

  it("reports cycle paths and source locations", () => {
    const result = diagnostics("cycles/tokens.json");
    expect(result[0]?.code).toBe("TOKEN_CIRCULAR_REFERENCE");
    expect(result[0]?.message).toContain("a\n    └── b\n        └── c\n            └── a");
    expect(result[0]?.source?.line).toBe(2);
    expect(detailedCheck("cycles/tokens.json").metrics).toEqual({
      candidateRegions: 1,
      relevantDimensions: 0,
      estimatedProjections: 0,
      estimateSaturated: false,
      enumeratedProjections: 0,
      earlyExits: 1,
      limitHits: 0,
    });
  });

  it("does not combine mutually exclusive context edges into a false cycle", async () => {
    const result = await compileDocuments(
      [
        {
          file: "contexts/mutually-exclusive-cycle.json",
          content: fixture("contexts/mutually-exclusive-cycle.json"),
        },
      ],
      { contexts: themeContexts },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.compilation.resolveToken(parseTokenId("a"), { theme: "light" })?.value).toBe(1);
    expect(result.compilation.resolveToken(parseTokenId("b"), { theme: "light" })?.value).toBe(1);
    expect(result.compilation.resolveToken(parseTokenId("a"), { theme: "dark" })?.value).toBe(2);
    expect(result.compilation.resolveToken(parseTokenId("b"), { theme: "dark" })?.value).toBe(2);
    const checked = detailedCheck("contexts/mutually-exclusive-cycle.json", themeContexts);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.metrics).toEqual({
      candidateRegions: 1,
      relevantDimensions: 1,
      estimatedProjections: 2,
      estimateSaturated: false,
      enumeratedProjections: 2,
      earlyExits: 0,
      limitHits: 0,
    });
  });

  it("checks the selected base or override dependency rather than their union", () => {
    expect(diagnostics("contexts/base-override-no-cycle.json", themeContexts)).toEqual([]);
  });

  it("honors selector specificity when projecting dependency edges", () => {
    expect(
      diagnostics("contexts/specificity-breaks-cycle.json", {
        ...themeContexts,
        brand: { default: "default", values: ["default", "enterprise"] },
      }),
    ).toEqual([]);
  });

  it("reports a cycle that is satisfiable only across multiple context dimensions", () => {
    const contexts = {
      ...themeContexts,
      brand: { default: "default", values: ["default", "enterprise"] },
    };
    const result = diagnostics("contexts/multidimension-cycle.json", contexts);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: "TOKEN_CIRCULAR_REFERENCE" });
    expect(result[0]?.message).toContain("a\n    └── b\n        └── a");
    expect(result[0]?.message).toContain("Active context: `brand=enterprise&theme=dark`");
    expect(detailedCheck("contexts/multidimension-cycle.json", contexts).metrics).toEqual({
      candidateRegions: 1,
      relevantDimensions: 2,
      estimatedProjections: 4,
      estimateSaturated: false,
      enumeratedProjections: 4,
      earlyExits: 0,
      limitHits: 0,
    });
  });

  it("fails deterministically before an excessive Context projection is enumerated", () => {
    const dimensionNames = Array.from({ length: 15 }, (_, index) => `dimension-${index}`);
    const contexts = Object.fromEntries(
      dimensionNames.map((name) => [name, { default: "off", values: ["off", "on"] }]),
    );
    const selector = dimensionNames.map((name) => `${name}=on`).join("&");
    const document = JSON.stringify({
      a: {
        $type: "number",
        $value: 1,
        $extensions: { "org.token-compiler.contexts": { [selector]: "{b}" } },
      },
      b: { $type: "number", $value: "{a}" },
    });
    const projectionGraph = new TokenGraph(
      parseTokenDocument(document, "projection-limit.json").tokens,
    );

    const result = checkTokenGraphDetailed(projectionGraph, undefined, contexts);

    expect(CONTEXT_CYCLE_PROJECTION_LIMIT).toBe(16_384);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "TOKEN_CONTEXT_PROJECTION_LIMIT",
      severity: "error",
      source: { file: "projection-limit.json", line: 1 },
    });
    expect(result.diagnostics[0]?.message).toBe(
      `Context-aware cycle analysis exceeded its limit of 16384 projections for the region rooted at \`a\` (2 tokens; 15 relevant dimensions: ${dimensionNames.map((name) => `${name}=2`).join(", ")}). Reduce the region's Context combinations before checking.`,
    );
    expect(result.metrics).toEqual({
      candidateRegions: 1,
      relevantDimensions: 15,
      estimatedProjections: 32_768,
      estimateSaturated: false,
      enumeratedProjections: 0,
      earlyExits: 0,
      limitHits: 1,
    });
    expect(checkTokenGraph(projectionGraph, undefined, contexts)).toEqual(result.diagnostics);
  });

  it("saturates an unrepresentable Context projection estimate", () => {
    const dimensionNames = Array.from({ length: 54 }, (_, index) => `dimension-${index}`);
    const contexts = Object.fromEntries(
      dimensionNames.map((name) => [name, { default: "off", values: ["off", "on"] }]),
    );
    const selector = dimensionNames.map((name) => `${name}=on`).join("&");
    const document = JSON.stringify({
      a: {
        $type: "number",
        $value: 1,
        $extensions: { "org.token-compiler.contexts": { [selector]: "{b}" } },
      },
      b: { $type: "number", $value: "{a}" },
    });
    const projectionGraph = new TokenGraph(
      parseTokenDocument(document, "projection-saturation.json").tokens,
    );

    expect(checkTokenGraphDetailed(projectionGraph, undefined, contexts).metrics).toEqual({
      candidateRegions: 1,
      relevantDimensions: 54,
      estimatedProjections: Number.MAX_SAFE_INTEGER,
      estimateSaturated: true,
      enumeratedProjections: 0,
      earlyExits: 0,
      limitHits: 1,
    });
  });

  it("ranks same-prefix suggestions first", () => {
    expect(
      suggestTokenIds(
        parseTokenId("color.blue.650"),
        ["space.650", "color.blue.600", "color.red.650"].map(parseTokenId),
        1,
      ),
    ).toEqual(["color.blue.600"]);
  });
});
