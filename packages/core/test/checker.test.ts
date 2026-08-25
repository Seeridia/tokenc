import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  checkTokenGraph,
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
const diagnostics = (name: string, contexts: ContextDefinition = {}) =>
  checkTokenGraph(
    new TokenGraph(parseTokenDocument(fixture(name), name).tokens),
    undefined,
    contexts,
  );

const themeContexts: ContextDefinition = {
  theme: { default: "light", values: ["light", "dark"] },
};

describe("type checker", () => {
  it("accepts same-type alias chains", () =>
    expect(diagnostics("aliases/tokens.json")).toEqual([]));

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
    const result = diagnostics("contexts/multidimension-cycle.json", {
      ...themeContexts,
      brand: { default: "default", values: ["default", "enterprise"] },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: "TOKEN_CIRCULAR_REFERENCE" });
    expect(result[0]?.message).toContain("a\n    └── b\n        └── a");
    expect(result[0]?.message).toContain("Active context: `brand=enterprise&theme=dark`");
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
    const graph = new TokenGraph(parseTokenDocument(document, "projection-limit.json").tokens);

    const result = checkTokenGraph(graph, undefined, contexts);

    expect(CONTEXT_CYCLE_PROJECTION_LIMIT).toBe(16_384);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "TOKEN_CONTEXT_PROJECTION_LIMIT",
      severity: "error",
      source: { file: "projection-limit.json", line: 1 },
    });
    expect(result[0]?.message).toBe(
      `Context-aware cycle analysis exceeded its limit of 16384 projections for the region rooted at \`a\` (2 tokens; 15 relevant dimensions: ${dimensionNames.map((name) => `${name}=2`).join(", ")}). Reduce the region's Context combinations before checking.`,
    );
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
