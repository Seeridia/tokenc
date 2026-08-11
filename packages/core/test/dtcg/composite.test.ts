import { describe, expect, it } from "vite-plus/test";

import type { JsonValue, TokenType } from "../../src/model.js";
import { parseTokenDocument } from "../../src/parser.js";

const red = { colorSpace: "srgb", components: [1, 0, 0] };
const px = (value: number) => ({ value, unit: "px" });
const ms = (value: number) => ({ value, unit: "ms" });

function parse(type: TokenType, value: JsonValue) {
  return parseTokenDocument(
    JSON.stringify({ token: { $type: type, $value: value } }),
    `/tokens/${type}.json`,
  );
}

const validValues: readonly [TokenType, JsonValue][] = [
  ["cubicBezier", [0.25, -2, 0.75, 3]],
  ["strokeStyle", "solid"],
  ["strokeStyle", { dashArray: [px(1), px(2)], lineCap: "round" }],
  ["border", { color: red, width: px(1), style: "dashed" }],
  ["transition", { duration: ms(200), delay: ms(0), timingFunction: [0, 0, 1, 1] }],
  [
    "shadow",
    { color: red, offsetX: px(0), offsetY: px(2), blur: px(4), spread: px(0), inset: true },
  ],
  [
    "shadow",
    [
      { color: red, offsetX: px(0), offsetY: px(2), blur: px(4), spread: px(0) },
      { color: red, offsetX: px(0), offsetY: px(4), blur: px(8), spread: px(0) },
    ],
  ],
  [
    "gradient",
    [
      { color: red, position: 0 },
      { color: red, position: 1 },
    ],
  ],
  [
    "typography",
    {
      fontFamily: ["Inter", "sans-serif"],
      fontSize: px(16),
      fontWeight: "extra-black",
      letterSpacing: px(0),
      lineHeight: 1.5,
    },
  ],
];

const invalidValues: readonly [TokenType, JsonValue][] = [
  ["cubicBezier", [0, 1]],
  ["cubicBezier", ["0", 0, 1, 1]],
  ["cubicBezier", [-0.1, 0, 1, 1]],
  ["cubicBezier", [0, 0, 1.1, 1]],
  ["strokeStyle", { dashArray: [], lineCap: "round" }],
  ["strokeStyle", { dashArray: [px(1)], lineCap: "flat" }],
  ["strokeStyle", { dashArray: [px(1)], lineCap: "round", extra: true }],
  ["border", { color: red, width: px(1) }],
  ["border", { color: red, width: 1, style: "solid" }],
  ["border", { color: red, width: px(1), style: "solid", extra: true }],
  ["transition", { duration: ms(200), delay: ms(0) }],
  ["transition", { duration: ms(200), delay: ms(0), timingFunction: [2, 0, 1, 1] }],
  ["shadow", []],
  ["shadow", { color: red, offsetX: px(0), offsetY: px(2), blur: px(4) }],
  ["shadow", { color: red, offsetX: px(0), offsetY: px(2), blur: px(4), spread: 0 }],
  ["gradient", []],
  ["gradient", [{ color: red, position: -0.1 }]],
  ["gradient", [{ color: red, position: 1.1 }]],
  [
    "typography",
    {
      fontFamily: "Inter",
      fontSize: px(16),
      fontWeight: "bold",
      letterSpacing: px(0),
    },
  ],
  [
    "typography",
    {
      fontFamily: "Inter",
      fontSize: px(16),
      fontWeight: "bold",
      letterSpacing: px(0),
      lineHeight: "1.5",
    },
  ],
];

describe("DTCG composite token validation", () => {
  it.each(validValues)("accepts a valid %s value", (type, value) => {
    const parsed = parse(type, value);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens[0]).toMatchObject({ type, value: { kind: "literal" } });
  });

  it.each(invalidValues)("rejects a malformed %s value", (type, value) => {
    const parsed = parse(type, value);
    expect(parsed.tokens).toEqual([]);
    expect(parsed.diagnostics[0]?.code).toBe(
      type === "cubicBezier" ? "DTCG_INVALID_CUBIC_BEZIER" : "DTCG_INVALID_COMPOSITE_VALUE",
    );
  });
});
