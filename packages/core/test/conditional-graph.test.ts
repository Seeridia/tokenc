import { describe, expect, it } from "vite-plus/test";

import { TokenGraph } from "../src/graph.js";
import { parseTokenDocument } from "../src/parser.js";
import { contextPredicateMatches, trueContextPredicate } from "../src/predicate.js";
import { parseTokenId } from "../src/token-id.js";

const contexts = {
  theme: { default: "light", values: ["light", "dark"] },
  brand: { default: "default", values: ["default", "enterprise"] },
  density: { default: "comfortable", values: ["comfortable", "compact"] },
};

function graphFrom(value: unknown): TokenGraph {
  const document = parseTokenDocument(JSON.stringify(value, undefined, 2), "conditional.json");
  expect(document.diagnostics).toEqual([]);
  return new TokenGraph(document.tokens, contexts);
}

describe("conditional dependency graph", () => {
  it("subtracts higher-ranked winner regions from raw selectors", () => {
    const graph = graphFrom({
      base: { $type: "number", $value: 0 },
      dark: { $type: "number", $value: 1 },
      enterprise: { $type: "number", $value: 2 },
      value: {
        $type: "number",
        $value: "{base}",
        $extensions: {
          "org.token-compiler.contexts": {
            "theme=dark": "{dark}",
            "theme=dark&brand=enterprise": "{enterprise}",
          },
        },
      },
    });
    const edges = graph.getOutgoingEdges(parseTokenId("value"));
    const base = edges.find((edge) => edge.to === "base")!;
    const dark = edges.find((edge) => edge.to === "dark")!;
    const enterprise = edges.find((edge) => edge.to === "enterprise")!;

    expect(contextPredicateMatches(base.condition, { theme: "light", brand: "enterprise" })).toBe(
      true,
    );
    expect(contextPredicateMatches(base.condition, { theme: "dark", brand: "default" })).toBe(
      false,
    );
    expect(contextPredicateMatches(dark.condition, { theme: "dark", brand: "default" })).toBe(true);
    expect(contextPredicateMatches(dark.condition, { theme: "dark", brand: "enterprise" })).toBe(
      false,
    );
    expect(
      contextPredicateMatches(enterprise.condition, { theme: "dark", brand: "enterprise" }),
    ).toBe(true);
  });

  it("preserves repeated occurrences to one target with field paths", () => {
    const graph = graphFrom({
      timing: { $type: "duration", $value: { value: 100, unit: "ms" } },
      motion: {
        $type: "transition",
        $value: {
          duration: "{timing}",
          delay: "{timing}",
          timingFunction: [0, 0, 1, 1],
        },
      },
    });
    expect(
      graph.getOutgoingEdges(parseTokenId("motion")).map((edge) => ({
        target: edge.to,
        kind: edge.occurrence.kind,
        fieldPath: edge.occurrence.fieldPath,
        sourceLine: edge.occurrence.source.line,
      })),
    ).toEqual([
      { target: "timing", kind: "composite-field", fieldPath: ["duration"], sourceLine: 12 },
      { target: "timing", kind: "composite-field", fieldPath: ["delay"], sourceLine: 13 },
    ]);
  });

  it("reports the exact satisfiable region and edge sources for a conditional cycle", () => {
    const graph = graphFrom({
      a: {
        $type: "number",
        $value: 1,
        $extensions: { "org.token-compiler.contexts": { "theme=dark": "{b}" } },
      },
      b: {
        $type: "number",
        $value: 2,
        $extensions: { "org.token-compiler.contexts": { "brand=enterprise": "{a}" } },
      },
    });
    const cycle = graph.detectConditionalCycles()[0]!;
    expect(cycle.witness).toEqual({
      theme: "dark",
      brand: "enterprise",
      density: "comfortable",
    });
    expect(cycle.edges.map((edge) => edge.occurrence.source.file)).toEqual([
      "conditional.json",
      "conditional.json",
    ]);
  });

  it("propagates only affected Context regions", () => {
    const graph = graphFrom({
      source: { $type: "number", $value: 1 },
      consumer: {
        $type: "number",
        $value: 0,
        $extensions: { "org.token-compiler.contexts": { "theme=dark": "{source}" } },
      },
    });
    const affected = graph.getAffected(
      new Map([[parseTokenId("source"), trueContextPredicate(graph.domain)]]),
    );
    const consumer = affected.get(parseTokenId("consumer"))!;
    expect(contextPredicateMatches(consumer, { theme: "dark" })).toBe(true);
    expect(contextPredicateMatches(consumer, { theme: "light" })).toBe(false);
  });
});
