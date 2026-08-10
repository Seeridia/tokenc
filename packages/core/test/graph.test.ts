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

  it("computes a forward dependency closure", () => {
    const closure = graphFrom("aliases/tokens.json").getDependencyClosure([
      parseTokenId("color.button"),
    ]);
    expect([...closure]).toEqual(["color.button", "color.brand", "color.blue.600"]);
  });

  it("separates direct and indirect impact", () => {
    const impact = graphFrom("aliases/tokens.json").analyzeImpact([parseTokenId("color.blue.600")]);
    expect(impact.directlyAffected).toEqual(["color.brand"]);
    expect(impact.indirectlyAffected).toEqual(["color.button"]);
  });

  it("patches changed alias edges in both directions", () => {
    const document = parseTokenDocument(
      '{"a":{"$type":"number","$value":1},"b":{"$type":"number","$value":2},"alias":{"$type":"number","$value":"{a}"},"consumer":{"$type":"number","$value":"{alias}"}}',
      "patch.json",
    );
    const graph = new TokenGraph(document.tokens);
    const replacement = parseTokenDocument(
      '{"alias":{"$type":"number","$value":"{b}"}}',
      "replacement.json",
    ).tokens[0]!;
    const delta = graph.patch({ changed: [replacement] });
    expect(graph.getDependents(parseTokenId("a"))).toEqual([]);
    expect(graph.getDependents(parseTokenId("b"))).toEqual(["alias"]);
    expect(graph.getDependencies(parseTokenId("alias"))).toEqual(["b"]);
    expect([...delta.affected]).toEqual(["alias", "consumer"]);
    expect(delta).toMatchObject({ touchedNodes: 1, touchedEdges: 2 });
  });

  it("handles unknown references becoming valid and valid references becoming unknown", () => {
    const alias = parseTokenDocument(
      '{"alias":{"$type":"number","$value":"{target}"}}',
      "alias.json",
    ).tokens[0]!;
    const target = parseTokenDocument('{"target":{"$type":"number","$value":1}}', "target.json")
      .tokens[0]!;
    const graph = new TokenGraph([alias]);
    expect(graph.getDependents(parseTokenId("target"))).toEqual(["alias"]);
    graph.patch({ added: [target] });
    expect(graph.hasToken(parseTokenId("target"))).toBe(true);
    expect([...graph.patch({ removed: [parseTokenId("target")] }).affected]).toEqual([
      "target",
      "alias",
    ]);
    expect(graph.getDependents(parseTokenId("target"))).toEqual(["alias"]);
  });

  it("detects cycles created by a patch and recovers when the edge is removed", () => {
    const tokens = parseTokenDocument(
      '{"a":{"$type":"number","$value":"{b}"},"b":{"$type":"number","$value":1}}',
      "cycle-patch.json",
    ).tokens;
    const graph = new TokenGraph(tokens);
    const cyclic = parseTokenDocument('{"b":{"$type":"number","$value":"{a}"}}', "cyclic.json")
      .tokens[0]!;
    graph.patch({ changed: [cyclic] });
    expect(graph.detectCycles()).toEqual([["a", "b", "a"]]);
    const literal = parseTokenDocument('{"b":{"$type":"number","$value":2}}', "literal.json")
      .tokens[0]!;
    graph.patch({ changed: [literal] });
    expect(graph.detectCycles()).toEqual([]);
  });

  it("orders a large alias chain without recursive depth sorting", () => {
    const tokens = Array.from({ length: 5_000 }, (_, index) => {
      const value = index === 0 ? 0 : `{token${index - 1}}`;
      return `"token${index}":{"$type":"number","$value":${JSON.stringify(value)}}`;
    });
    const graph = new TokenGraph(parseTokenDocument(`{${tokens.join(",")}}`, "large.json").tokens);
    const order = graph.topologicalSort();
    expect(order).toHaveLength(5_000);
    expect(order[0]).toBe("token0");
    expect(order.at(-1)).toBe("token4999");
  });
});
