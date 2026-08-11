import type { ColorComponent, ColorSpace, ColorValue, JsonValue, TokenLiteral } from "../model.js";

export const COLOR_SPACES: ReadonlySet<string> = new Set([
  "srgb",
  "srgb-linear",
  "display-p3",
  "a98-rgb",
  "prophoto-rgb",
  "rec2020",
  "xyz-d50",
  "xyz-d65",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "hsl",
  "hwb",
]);

function isColorSpace(value: string): value is ColorSpace {
  return COLOR_SPACES.has(value);
}

function colorComponent(value: JsonValue): value is ColorComponent {
  return typeof value === "number" || value === "none";
}

function triple(
  value: JsonValue | undefined,
): readonly [ColorComponent, ColorComponent, ColorComponent] | undefined {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(colorComponent)) return undefined;
  const [first, second, third] = value;
  if (first === undefined || second === undefined || third === undefined) return undefined;
  return [first, second, third];
}

function inRange(value: ColorComponent, minimum: number, maximum?: number): boolean {
  return value === "none" || (value >= minimum && (maximum === undefined || value <= maximum));
}

function hue(value: ColorComponent): boolean {
  return value === "none" || (value >= 0 && value < 360);
}

function validComponents(space: ColorSpace, values: readonly ColorComponent[]): boolean {
  const [first, second, third] = values;
  if (first === undefined || second === undefined || third === undefined) return false;
  if (
    [
      "srgb",
      "srgb-linear",
      "display-p3",
      "a98-rgb",
      "prophoto-rgb",
      "rec2020",
      "xyz-d50",
      "xyz-d65",
    ].includes(space)
  )
    return values.every((value) => inRange(value, 0, 1));
  if (space === "hsl" || space === "hwb")
    return hue(first) && inRange(second, 0, 100) && inRange(third, 0, 100);
  if (space === "lab") return inRange(first, 0, 100);
  if (space === "lch") return inRange(first, 0, 100) && inRange(second, 0) && hue(third);
  if (space === "oklab") return inRange(first, 0, 1);
  return inRange(first, 0, 1) && inRange(second, 0) && hue(third);
}

export type ColorParseError = "invalid" | "non-structured" | "unsupported-space";

export type ColorParseResult = { readonly value: ColorValue } | { readonly error: ColorParseError };

export function isColorValue(value: TokenLiteral): value is ColorValue {
  if (typeof value !== "object" || value === null || !("colorSpace" in value)) return false;
  return typeof value.colorSpace === "string" && COLOR_SPACES.has(value.colorSpace);
}

/** Validate and normalize a color without performing color-space conversion. */
export function parseColorValue(value: JsonValue): ColorParseResult {
  if (typeof value === "string") return { error: "non-structured" };
  if (value === null || Array.isArray(value) || typeof value !== "object")
    return { error: "invalid" };
  const rawSpace = value.colorSpace;
  if (typeof rawSpace !== "string" || !isColorSpace(rawSpace))
    return { error: "unsupported-space" };
  const space = rawSpace;
  const components = triple(value.components);
  const alpha = value.alpha === undefined ? 1 : value.alpha;
  const hex = value.hex;
  if (
    !components ||
    !validComponents(space, components) ||
    typeof alpha !== "number" ||
    alpha < 0 ||
    alpha > 1 ||
    (hex !== undefined && (typeof hex !== "string" || !/^#[0-9a-f]{6}$/iu.test(hex)))
  )
    return { error: "invalid" };
  return {
    value: {
      colorSpace: space,
      components,
      alpha,
      ...(typeof hex === "string" ? { hex } : {}),
    },
  };
}
