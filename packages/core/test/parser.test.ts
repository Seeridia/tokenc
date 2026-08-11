import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { parseTokenDocument } from "../src/parser.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");

const srgb = (components: readonly [number, number, number], hex: string) => ({
  colorSpace: "srgb",
  components,
  alpha: 1,
  hex,
});

describe("DTCG parser", () => {
  it("parses typed literals and inherited group types", () => {
    const result = parseTokenDocument(fixture("basic/tokens.json"), "tokens.json");
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => [token.id, token.type])).toEqual([
      ["color.blue.600", "color"],
      ["spacing.400", "dimension"],
      ["opacity", "number"],
      ["motion", "duration"],
      ["weight", "fontWeight"],
    ]);
    expect(result.tokens[0]?.description).toBe("Brand blue");
  });

  it("retains source provenance", () => {
    const result = parseTokenDocument(fixture("basic/tokens.json"), "tokens/basic.json");
    const token = result.tokens[0];
    expect(token?.source).toMatchObject({ file: "tokens/basic.json", line: 5, column: 14 });
    expect(token?.value.kind).toBe("literal");
  });

  it("parses aliases into reference nodes", () => {
    const result = parseTokenDocument(fixture("aliases/tokens.json"), "aliases.json");
    expect(result.tokens[1]?.value).toMatchObject({ kind: "reference", target: "color.blue.600" });
    expect(result.tokens[2]?.dependencies).toEqual(["color.brand"]);
  });

  it("reports invalid JSON with a location", () => {
    const result = parseTokenDocument('{"color": {', "broken.json");
    expect(result.tokens).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "TOKEN_INVALID_JSON",
      source: { file: "broken.json", line: 1 },
    });
  });

  it("reports missing inherited type", () => {
    const result = parseTokenDocument('{"color":{"brand":{"$value":1}}}', "missing.json");
    expect(result.diagnostics[0]?.code).toBe("TOKEN_MISSING_TYPE");
  });

  it("validates literal values", () => {
    const result = parseTokenDocument('{"space":{"$type":"dimension","$value":16}}', "value.json");
    expect(result.diagnostics[0]?.code).toBe("TOKEN_INVALID_VALUE");
  });

  it("parses sRGB and OKLCH into explicit color models", () => {
    const result = parseTokenDocument(
      JSON.stringify({
        a: { $type: "color", $value: srgb([0, 82 / 255, 217 / 255], "#0052D9") },
        b: {
          $type: "color",
          $value: { colorSpace: "oklch", components: [0.62, 0.2, 250], alpha: 1 },
        },
      }),
      "colors.json",
    );
    expect(result.tokens[0]?.value).toMatchObject({
      kind: "literal",
      value: { colorSpace: "srgb" },
    });
    expect(result.tokens[1]?.value).toMatchObject({
      kind: "literal",
      value: { colorSpace: "oklch" },
    });
  });

  it("parses context overrides without merging dictionaries", () => {
    const result = parseTokenDocument(
      JSON.stringify({
        page: {
          $type: "color",
          $value: srgb([1, 1, 1], "#ffffff"),
          $extensions: {
            "org.token-compiler.contexts": {
              "theme=dark": { $value: srgb([17 / 255, 17 / 255, 17 / 255], "#111111") },
            },
          },
        },
      }),
      "themes.json",
    );
    expect(result.tokens[0]?.overrides[0]).toMatchObject({
      selector: { theme: "dark" },
      expression: { kind: "literal" },
    });
  });

  it("diagnoses malformed tokenc context extension data", () => {
    const result = parseTokenDocument(
      JSON.stringify({
        value: {
          $type: "number",
          $value: 1,
          $extensions: { "org.token-compiler.contexts": "dark" },
        },
      }),
      "invalid-context-extension.json",
    );
    expect(result.diagnostics[0]?.code).toBe("TOKEN_INVALID_CONTEXT_EXTENSION");
  });
});
