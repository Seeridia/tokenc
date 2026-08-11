import type {
  BorderValue,
  CubicBezierValue,
  DimensionValue,
  DurationValue,
  FontFamilyValue,
  FontWeightValue,
  GradientStopValue,
  JsonValue,
  ShadowValue,
  StrokeStyleValue,
  TokenLiteral,
  TokenType,
  TransitionValue,
  TypographyValue,
} from "../model.js";
import { parseColorValue } from "./color.js";

type NamedFontWeight = Exclude<FontWeightValue, number>;

const FONT_WEIGHTS: ReadonlySet<string> = new Set([
  "thin",
  "hairline",
  "extra-light",
  "ultra-light",
  "light",
  "normal",
  "regular",
  "book",
  "medium",
  "semi-bold",
  "demi-bold",
  "bold",
  "extra-bold",
  "ultra-bold",
  "black",
  "heavy",
  "extra-black",
  "ultra-black",
]);

const STROKE_KEYWORDS: ReadonlySet<string> = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "outset",
  "inset",
]);

export interface TokenValueError {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

export type TokenValueResult =
  | { readonly ok: true; readonly value: TokenLiteral }
  | { readonly ok: false; readonly error: TokenValueError };

function invalid(
  type: TokenType,
  detail?: string,
  path?: readonly (string | number)[],
): TokenValueResult {
  const composite = new Set<TokenType>([
    "cubicBezier",
    "strokeStyle",
    "border",
    "transition",
    "shadow",
    "gradient",
    "typography",
  ]);
  return {
    ok: false,
    error: {
      code:
        type === "cubicBezier"
          ? "DTCG_INVALID_CUBIC_BEZIER"
          : composite.has(type)
            ? "DTCG_INVALID_COMPOSITE_VALUE"
            : "TOKEN_INVALID_VALUE",
      message: detail ? `Invalid ${type} token value: ${detail}` : `Invalid ${type} token value`,
      ...(path ? { path } : {}),
    },
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function dimension(value: unknown): DimensionValue | undefined {
  return isObject(value) &&
    hasExactKeys(value, ["value", "unit"]) &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    (value.unit === "px" || value.unit === "rem")
    ? { value: value.value, unit: value.unit }
    : undefined;
}

function duration(value: unknown): DurationValue | undefined {
  return isObject(value) &&
    hasExactKeys(value, ["value", "unit"]) &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    (value.unit === "ms" || value.unit === "s")
    ? { value: value.value, unit: value.unit }
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function fontFamily(value: unknown): FontFamilyValue | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
    ? value
    : undefined;
}

function isNamedFontWeight(value: string): value is NamedFontWeight {
  return FONT_WEIGHTS.has(value);
}

function fontWeight(value: unknown): FontWeightValue | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1000)
    return value;
  return typeof value === "string" && isNamedFontWeight(value) ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cubicBezier(value: unknown): CubicBezierValue | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)) return undefined;
  const [x1, y1, x2, y2] = value;
  return x1 !== undefined &&
    y1 !== undefined &&
    x2 !== undefined &&
    y2 !== undefined &&
    x1 >= 0 &&
    x1 <= 1 &&
    x2 >= 0 &&
    x2 <= 1
    ? [x1, y1, x2, y2]
    : undefined;
}

function isStrokeKeyword(value: string): value is Extract<StrokeStyleValue, string> {
  return STROKE_KEYWORDS.has(value);
}

function isLineCap(value: unknown): value is "round" | "butt" | "square" {
  return value === "round" || value === "butt" || value === "square";
}

function strokeStyle(value: unknown): StrokeStyleValue | undefined {
  if (typeof value === "string") return isStrokeKeyword(value) ? value : undefined;
  if (!isObject(value) || !hasExactKeys(value, ["dashArray", "lineCap"])) return undefined;
  if (!Array.isArray(value.dashArray) || value.dashArray.length === 0 || !isLineCap(value.lineCap))
    return undefined;
  const dashArray = value.dashArray.map(dimension);
  if (dashArray.some((entry) => entry === undefined)) return undefined;
  return {
    dashArray: dashArray.filter((entry): entry is DimensionValue => entry !== undefined),
    lineCap: value.lineCap,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}

function color(value: unknown) {
  if (!isJsonValue(value)) return undefined;
  const parsed = parseColorValue(value);
  return "value" in parsed ? parsed.value : undefined;
}

function border(value: unknown): BorderValue | undefined {
  if (!isObject(value) || !hasExactKeys(value, ["color", "width", "style"])) return undefined;
  const parsedColor = color(value.color);
  const width = dimension(value.width);
  const style = strokeStyle(value.style);
  return parsedColor && width && style ? { color: parsedColor, width, style } : undefined;
}

function transition(value: unknown): TransitionValue | undefined {
  if (!isObject(value) || !hasExactKeys(value, ["duration", "delay", "timingFunction"]))
    return undefined;
  const parsedDuration = duration(value.duration);
  const delay = duration(value.delay);
  const timingFunction = cubicBezier(value.timingFunction);
  return parsedDuration && delay && timingFunction
    ? { duration: parsedDuration, delay, timingFunction }
    : undefined;
}

function shadowItem(value: unknown): ShadowValue | undefined {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["color", "offsetX", "offsetY", "blur", "spread"], ["inset"])
  )
    return undefined;
  const parsedColor = color(value.color);
  const offsetX = dimension(value.offsetX);
  const offsetY = dimension(value.offsetY);
  const blur = dimension(value.blur);
  const spread = dimension(value.spread);
  if (!parsedColor || !offsetX || !offsetY || !blur || !spread) return undefined;
  if (value.inset !== undefined && typeof value.inset !== "boolean") return undefined;
  return {
    color: parsedColor,
    offsetX,
    offsetY,
    blur,
    spread,
    ...(typeof value.inset === "boolean" ? { inset: value.inset } : {}),
  };
}

function shadow(value: unknown): ShadowValue | readonly ShadowValue[] | undefined {
  if (!Array.isArray(value)) return shadowItem(value);
  if (value.length === 0) return undefined;
  const items = value.map(shadowItem);
  return items.some((item) => item === undefined)
    ? undefined
    : items.filter((item): item is ShadowValue => item !== undefined);
}

function gradient(value: unknown): readonly GradientStopValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const stops = value.map((stop): GradientStopValue | undefined => {
    if (!isObject(stop) || !hasExactKeys(stop, ["color", "position"])) return undefined;
    const parsedColor = color(stop.color);
    return parsedColor &&
      typeof stop.position === "number" &&
      Number.isFinite(stop.position) &&
      stop.position >= 0 &&
      stop.position <= 1
      ? { color: parsedColor, position: stop.position }
      : undefined;
  });
  return stops.some((stop) => stop === undefined)
    ? undefined
    : stops.filter((stop): stop is GradientStopValue => stop !== undefined);
}

function typography(value: unknown): TypographyValue | undefined {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight"])
  )
    return undefined;
  const family = fontFamily(value.fontFamily);
  const size = dimension(value.fontSize);
  const weight = fontWeight(value.fontWeight);
  const spacing = dimension(value.letterSpacing);
  return family &&
    size &&
    weight !== undefined &&
    spacing &&
    typeof value.lineHeight === "number" &&
    Number.isFinite(value.lineHeight)
    ? {
        fontFamily: family,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: spacing,
        lineHeight: value.lineHeight,
      }
    : undefined;
}

/** Validate and normalize one fully linked DTCG token literal. */
export function parseTokenLiteral(type: TokenType, value: unknown): TokenValueResult {
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value)
      ? { ok: true, value }
      : invalid(type);
  if (type === "fontFamily") {
    const parsed = fontFamily(value);
    return parsed ? { ok: true, value: parsed } : invalid(type);
  }
  if (type === "dimension") {
    const parsed = dimension(value);
    return parsed ? { ok: true, value: parsed } : invalid(type);
  }
  if (type === "duration") {
    const parsed = duration(value);
    return parsed ? { ok: true, value: parsed } : invalid(type);
  }
  if (type === "fontWeight") {
    const parsed = fontWeight(value);
    return parsed !== undefined ? { ok: true, value: parsed } : invalid(type);
  }
  if (type === "color") {
    if (!isJsonValue(value)) return invalid(type);
    const parsed = parseColorValue(value);
    if ("value" in parsed) return { ok: true, value: parsed.value };
    return {
      ok: false,
      error: {
        code:
          parsed.error === "unsupported-space"
            ? "DTCG_UNSUPPORTED_COLOR_SPACE"
            : "DTCG_INVALID_COLOR",
        message:
          parsed.error === "non-structured"
            ? `Expected a structured DTCG color value with \`colorSpace\` and \`components\`; optional fields are \`alpha\` and \`hex\`. Received ${JSON.stringify(value)}`
            : parsed.error === "unsupported-space"
              ? "Unsupported DTCG color space"
              : "Invalid DTCG color value",
      },
    };
  }
  const parsed =
    type === "cubicBezier"
      ? cubicBezier(value)
      : type === "strokeStyle"
        ? strokeStyle(value)
        : type === "border"
          ? border(value)
          : type === "transition"
            ? transition(value)
            : type === "shadow"
              ? shadow(value)
              : type === "gradient"
                ? gradient(value)
                : typography(value);
  return parsed === undefined ? invalid(type) : { ok: true, value: parsed };
}
