import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

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
    expect(resolved?.value).toMatchObject({ colorSpace: "srgb", hex: "#0052D9" });
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
      hex: "#111111",
    });
    expect(
      resolver.resolve(parseTokenId("color.page"), { theme: "dark", brand: "enterprise" })?.value,
    ).toMatchObject({ hex: "#003cab" });
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

  it("returns a structured context and alias resolution trace", () => {
    const graph = new TokenGraph(
      parseTokenDocument(fixture("themes/tokens.json"), "themes.json").tokens,
    );
    const resolver = new TokenResolver(graph, {
      theme: { default: "light", values: ["light", "dark"] },
      brand: { default: "default", values: ["default", "enterprise"] },
    });
    const trace = resolver.trace(parseTokenId("color.page"), {
      theme: "dark",
      brand: "enterprise",
    });
    expect(trace).toMatchObject({
      schemaVersion: "1",
      token: "color.page",
      context: { theme: "dark", brand: "enterprise" },
      steps: [
        {
          token: "color.page",
          selection: "base",
          expression: { kind: "reference", target: "color.base" },
        },
        {
          token: "color.base",
          selection: "override",
          selector: { theme: "dark", brand: "enterprise" },
        },
      ],
      finalValue: { colorSpace: "srgb", hex: "#003cab" },
    });
  });

  it("resolves a 10k alias chain without call-stack recursion", () => {
    const content = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 10_000 }, (_, index) => [
          `token${index}`,
          { $type: "number", $value: index === 0 ? 1 : `{token${index - 1}}` },
        ]),
      ),
    );
    const resolver = new TokenResolver(
      new TokenGraph(parseTokenDocument(content, "deep.json").tokens),
    );
    expect(resolver.resolve(parseTokenId("token9999"))?.value).toBe(1);
    expect(resolver.computations).toBe(10_000);
  });
});
