import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { parseTokenDocument } from "../../src/parser.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/dtcg/color/${name}`, import.meta.url)), "utf8");

describe("DTCG 2025.10 colors", () => {
  it("accepts and preserves structured colors without conversion", () => {
    const result = parseTokenDocument(fixture("valid-structured.json"), "colors.json");
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens[0]?.value).toMatchObject({
      kind: "literal",
      value: {
        colorSpace: "display-p3",
        components: [0.1, 0.4, 0.9],
        alpha: 0.8,
        hex: "#1966e5",
      },
    });
  });

  it("rejects string shorthand with a DTCG diagnostic", () => {
    const result = parseTokenDocument(fixture("invalid-shorthand.json"), "shorthand.json");
    expect(result.diagnostics[0]).toMatchObject({
      code: "DTCG_INVALID_COLOR",
      message: expect.stringContaining("structured DTCG color value"),
      source: { document: "shorthand.json", range: { line: 4 } },
    });
    expect(result.diagnostics[0]?.fixes).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it("validates component ranges before backend emission", () => {
    const result = parseTokenDocument(fixture("invalid-components.json"), "components.json");
    expect(result.diagnostics[0]?.code).toBe("DTCG_INVALID_COLOR");
  });

  it("represents every standard 2025.10 color space", () => {
    const values = {
      srgb: [0, 0, 0],
      "srgb-linear": [0, 0, 0],
      "display-p3": [0, 0, 0],
      "a98-rgb": [0, 0, 0],
      "prophoto-rgb": [0, 0, 0],
      rec2020: [0, 0, 0],
      "xyz-d50": [0, 0, 0],
      "xyz-d65": [0, 0, 0],
      lab: [50, 0, 0],
      lch: [50, 20, 120],
      oklab: [0.5, 0, 0],
      oklch: [0.5, 0.2, 120],
      hsl: [120, 50, 50],
      hwb: [120, 20, 30],
    };
    const result = parseTokenDocument(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(values).map(([space, components]) => [
            space,
            { $type: "color", $value: { colorSpace: space, components } },
          ]),
        ),
      ),
      "spaces.json",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens).toHaveLength(14);
    expect(
      result.tokens.map((token) =>
        token.value.kind === "literal" &&
        typeof token.value.value === "object" &&
        token.value.value !== null &&
        "colorSpace" in token.value.value
          ? token.value.value.colorSpace
          : undefined,
      ),
    ).toEqual(Object.keys(values));
  });

  it("preserves none components, alpha, and the optional hex fallback", () => {
    const result = parseTokenDocument(
      JSON.stringify({
        transparent: {
          $type: "color",
          $value: {
            colorSpace: "srgb",
            components: ["none", 0.25, 0.5],
            alpha: 0,
            hex: "#004080",
          },
        },
      }),
      "none.json",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens[0]?.value).toMatchObject({
      kind: "literal",
      value: { components: ["none", 0.25, 0.5], alpha: 0, hex: "#004080" },
    });
  });
});
