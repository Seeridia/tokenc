import type { DimensionValue, DurationValue, TokenLiteral, TokenType } from "../model.js";

export const TOKEN_TYPES: ReadonlySet<string> = new Set([
  "color",
  "dimension",
  "fontFamily",
  "number",
  "duration",
  "fontWeight",
  "cubicBezier",
  "strokeStyle",
  "border",
  "transition",
  "shadow",
  "gradient",
  "typography",
]);

const DTCG_NAME = /^[^${}.][^{}.]*$/u;

export function isTokenType(value: string): value is TokenType {
  return TOKEN_TYPES.has(value);
}

export function isValidTokenSegment(segment: string): boolean {
  return segment === "$root" || DTCG_NAME.test(segment);
}

export function isUnitValue(value: TokenLiteral): value is DimensionValue | DurationValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "unit" in value &&
    "value" in value &&
    typeof value.value === "number"
  );
}
