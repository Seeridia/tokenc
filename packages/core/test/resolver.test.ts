import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TokenGraph } from "../src/graph.js";
import { parseTokenDocument } from "../src/parser.js";
import { TokenResolver } from "../src/resolver.js";
import { parseTokenId } from "../src/token-id.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");

describe("TokenResolver", () => {
  it("resolves an alias chain lazily", () => {
    const graph = new TokenGraph(
      parseTokenDocument(fixture("aliases/tokens.json"), "aliases.json").tokens,
    );
    const resolver = new TokenResolver(graph);
    const resolved = resolver.resolve(parseTokenId("color.button"));
    expect(resolved?.value).toMatchObject({ colorSpace: "srgb", original: "#0052D9" });
    expect(resolver.computations).toBe(3);
    resolver.resolve(parseTokenId("color.button"));
    expect(resolver.computations).toBe(3);
  });

  it("resolves aliases in the requested context", () => {
    const graph = new TokenGraph(
      parseTokenDocument(fixture("themes/tokens.json"), "themes.json").tokens,
    );
    const resolver = new TokenResolver(graph, {
      theme: { default: "light", values: ["light", "dark"] },
      brand: { default: "default", values: ["default", "enterprise"] },
    });
    expect(resolver.resolve(parseTokenId("color.page"), { theme: "dark" })?.value).toMatchObject({
      original: "#111111",
    });
    expect(
      resolver.resolve(parseTokenId("color.page"), { theme: "dark", brand: "enterprise" })?.value,
    ).toMatchObject({ original: "#003cab" });
  });

  it("invalidates only selected cached graph nodes", () => {
    const graph = new TokenGraph(
      parseTokenDocument(fixture("aliases/tokens.json"), "aliases.json").tokens,
    );
    const resolver = new TokenResolver(graph);
    resolver.resolve(parseTokenId("color.button"));
    resolver.invalidate(new Set([parseTokenId("color.button")]));
    resolver.resolve(parseTokenId("color.button"));
    expect(resolver.computations).toBe(4);
  });
});
