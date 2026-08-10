import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { compileDocuments } from "../../src/compiler.js";
import {
  parseResolverDocument,
  resolveResolverDocument,
  resolverSourceFiles,
} from "../../src/dtcg/resolver-document.js";
import { parseTokenId } from "../../src/token-id.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/dtcg/resolver/${name}`, import.meta.url));
const fixture = (name: string): string => readFileSync(fixturePath(name), "utf8");
const colorToken = (components: readonly number[]): string =>
  JSON.stringify({
    color: {
      brand: {
        $type: "color",
        $value: { colorSpace: "srgb", components },
      },
    },
  });

describe("DTCG 2025.10 resolver documents", () => {
  it("parses sets, modifiers, order, and source provenance", () => {
    const result = parseResolverDocument(
      fixture("valid.resolver.json"),
      fixturePath("valid.resolver.json"),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.document).toMatchObject({ version: "2025.10", name: "Application tokens" });
    expect(result.document?.sets.get("foundation")?.sources).toHaveLength(2);
    expect(result.document?.modifiers.get("theme")?.source).toMatchObject({ line: 24 });
    expect(result.document?.resolutionOrder.map((item) => item.name)).toEqual([
      "foundation",
      "theme",
    ]);
  });

  it("resolves an input to an ordered source stream", () => {
    const source = fixturePath("valid.resolver.json");
    const parsed = parseResolverDocument(fixture("valid.resolver.json"), source);
    const resolution = resolveResolverDocument(
      parsed.document!,
      [
        { file: `${dirname(source)}/foundation.json`, content: "{}" },
        { file: `${dirname(source)}/themes/light.json`, content: "{}" },
        { file: `${dirname(source)}/themes/dark.json`, content: "{}" },
      ],
      { theme: "dark" },
    );
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.context).toEqual({ theme: "dark" });
    expect(resolution.steps).toMatchObject([
      { kind: "set", name: "foundation" },
      { kind: "modifier", name: "theme", context: "dark" },
    ]);
    expect(resolution.sources.map((item) => item.file)).toEqual([
      `${dirname(source)}/foundation.json`,
      expect.stringContaining("valid.resolver.json#sets/foundation/sources/1"),
      `${dirname(source)}/foundation.json`,
      expect.stringContaining("valid.resolver.json#sets/foundation/sources/1"),
      `${dirname(source)}/themes/dark.json`,
    ]);
  });

  it("collects external files for the IO layer", () => {
    const source = fixturePath("valid.resolver.json");
    const parsed = parseResolverDocument(fixture("valid.resolver.json"), source);
    expect(resolverSourceFiles(parsed.document!)).toEqual([
      `${dirname(source)}/foundation.json`,
      `${dirname(source)}/themes/light.json`,
      `${dirname(source)}/themes/dark.json`,
    ]);
  });

  it("rejects an invalid explicit input instead of falling back to a default", () => {
    const source = fixturePath("valid.resolver.json");
    const parsed = parseResolverDocument(fixture("valid.resolver.json"), source);
    if (!parsed.document) throw new Error("Expected a valid resolver document");
    const resolution = resolveResolverDocument(parsed.document, [], { theme: "blue" });
    expect(resolution.diagnostics[0]).toMatchObject({
      code: "DTCG_INVALID_RESOLVER_INPUT",
      suggestions: ["light", "dark"],
    });
  });

  it("accepts inputs for inline modifiers", () => {
    const parsed = parseResolverDocument(
      JSON.stringify({
        version: "2025.10",
        resolutionOrder: [
          {
            type: "modifier",
            name: "density",
            contexts: { comfortable: [], compact: [] },
          },
        ],
      }),
      "/tokens/inline.resolver.json",
    );
    if (!parsed.document) throw new Error("Expected a valid resolver document");
    const resolution = resolveResolverDocument(parsed.document, [], { density: "compact" });
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.context).toEqual({ density: "compact" });
  });

  it("diagnoses reference sibling overrides instead of ignoring them", () => {
    const parsed = parseResolverDocument(
      JSON.stringify({
        version: "2025.10",
        sets: { base: { sources: [] } },
        resolutionOrder: [{ $ref: "#/sets/base", description: "override" }],
      }),
      "/tokens/override.resolver.json",
    );
    expect(parsed.diagnostics[0]?.code).toBe("DTCG_UNSUPPORTED_RESOLVER_REFERENCE_OVERRIDE");
  });

  it("emits stable diagnostics for invalid documents", () => {
    const result = parseResolverDocument(
      fixture("invalid.resolver.json"),
      fixturePath("invalid.resolver.json"),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "DTCG_INVALID_RESOLVER_VERSION",
      "DTCG_INVALID_RESOLVER_MODIFIER",
      "DTCG_INVALID_RESOLVER_DEFAULT",
      "DTCG_UNKNOWN_SET",
    ]);
  });

  it("compiles the selected resolution with last-source-wins semantics", async () => {
    const source = fixturePath("valid.resolver.json");
    const parsed = parseResolverDocument(fixture("valid.resolver.json"), source);
    if (!parsed.document) throw new Error("Expected a valid resolver document");
    const result = await compileDocuments(
      [
        { file: `${dirname(source)}/foundation.json`, content: colorToken([0, 0, 0]) },
        { file: `${dirname(source)}/themes/light.json`, content: colorToken([1, 1, 1]) },
        { file: `${dirname(source)}/themes/dark.json`, content: colorToken([0.1, 0.1, 0.1]) },
      ],
      { resolver: parsed.document, resolverInput: { theme: "dark" } },
    );
    expect(result.success).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.compilation.tokens).toHaveLength(1);
    expect(result.compilation.tokens[0]?.value).toMatchObject({
      colorSpace: "srgb",
      components: [0.1, 0.1, 0.1],
    });
    expect(result.compilation.resolution?.steps[1]).toMatchObject({
      kind: "modifier",
      name: "theme",
      context: "dark",
    });
  });

  it("preserves resolver source coordinates for inline token definitions", async () => {
    const content = `{
  "version": "2025.10",
  "resolutionOrder": [
    {
      "type": "set",
      "name": "inline",
      "sources": [
        {
          "value": { "$type": "number", "$value": 42 }
        }
      ]
    }
  ]
}`;
    const parsed = parseResolverDocument(content, "/tokens/inline.resolver.json");
    if (!parsed.document) throw new Error("Expected a valid resolver document");
    const result = await compileDocuments([], { resolver: parsed.document });
    expect(result.graph.getToken(parseTokenId("value"))?.source).toMatchObject({
      file: "/tokens/inline.resolver.json",
      line: 9,
    });
  });
});
