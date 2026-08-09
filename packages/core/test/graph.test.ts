import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { TokenGraph } from "../src/graph.js";
import { parseTokenDocument } from "../src/parser.js";
import { parseTokenId } from "../src/token-id.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
const graphFrom = (name: string): TokenGraph =>
  new TokenGraph(parseTokenDocument(fixture(name), name).tokens);

describe("TokenGraph", () => {
  it("indexes forward and reverse dependencies", () => {
    const graph = graphFrom("aliases/tokens.json");
    expect(graph.getDependencies(parseTokenId("color.brand"))).toEqual(["color.blue.600"]);
    expect(graph.getDependents(parseTokenId("color.blue.600"))).toEqual(["color.brand"]);
    expect(graph.hasToken(parseTokenId("color.button"))).toBe(true);
  });

  it("sorts dependencies before consumers", () => {
    const order = graphFrom("aliases/tokens.json").topologicalSort();
    expect(order.indexOf(parseTokenId("color.blue.600"))).toBeLessThan(
      order.indexOf(parseTokenId("color.brand")),
    );
    expect(order.indexOf(parseTokenId("color.brand"))).toBeLessThan(
      order.indexOf(parseTokenId("color.button")),
    );
  });

  it("detects and reports a closed cycle path", () => {
    expect(graphFrom("cycles/tokens.json").detectCycles()).toEqual([["a", "b", "c", "a"]]);
  });

  it("computes affected nodes from reverse edges", () => {
    const affected = graphFrom("aliases/tokens.json").getAffectedTokens([
      parseTokenId("color.blue.600"),
    ]);
    expect([...affected]).toEqual(["color.blue.600", "color.brand", "color.button"]);
  });

  it("separates direct and indirect impact", () => {
    const impact = graphFrom("aliases/tokens.json").analyzeImpact([parseTokenId("color.blue.600")]);
    expect(impact.directlyAffected).toEqual(["color.brand"]);
    expect(impact.indirectlyAffected).toEqual(["color.button"]);
  });
});
