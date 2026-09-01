import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { TokenGraph } from "../src/graph.js";
import { parseTokenDocument } from "../src/parser.js";
import { trueContextPredicate } from "../src/predicate.js";
import { parseTokenId } from "../src/token-id.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
const graphFrom = (name: string): TokenGraph =>
  new TokenGraph(parseTokenDocument(fixture(name), name).tokens);

describe("TokenGraph", () => {
  it("indexes forward and reverse dependency occurrences", () => {
    const graph = graphFrom("aliases/tokens.json");
    expect(graph.getOutgoingEdges(parseTokenId("color.brand")).map((edge) => edge.to)).toEqual([
      "color.blue.600",
    ]);
    expect(graph.getIncomingEdges(parseTokenId("color.blue.600")).map((edge) => edge.from)).toEqual(
      ["color.brand"],
    );
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
    expect(
      graphFrom("cycles/tokens.json")
        .detectConditionalCycles()
        .map((cycle) => [cycle.edges[0]?.from].concat(cycle.edges.map((edge) => edge.to))),
    ).toEqual([["a", "b", "c", "a"]]);
  });

  it("computes affected nodes from reverse edges", () => {
    const graph = graphFrom("aliases/tokens.json");
    const affected = graph.getAffected(
      new Map([[parseTokenId("color.blue.600"), trueContextPredicate(graph.domain)]]),
    );
    expect([...affected.keys()]).toEqual(["color.blue.600", "color.brand", "color.button"]);
  });

  it("computes a forward dependency closure", () => {
    const graph = graphFrom("aliases/tokens.json");
    const closure = graph.getDependencyClosure(
      new Map([[parseTokenId("color.button"), trueContextPredicate(graph.domain)]]),
    );
    expect([...closure.keys()]).toEqual(["color.button", "color.brand", "color.blue.600"]);
  });

  it("retains the condition and source on every edge", () => {
    const graph = graphFrom("aliases/tokens.json");
    const edge = graph.getOutgoingEdges(parseTokenId("color.brand"))[0];
    expect(edge).toMatchObject({
      from: "color.brand",
      to: "color.blue.600",
      occurrence: { kind: "alias", source: { file: "aliases/tokens.json" } },
    });
    expect(edge?.condition.key).toBe("[{}]");
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
