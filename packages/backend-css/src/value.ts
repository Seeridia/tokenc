import {
  isColorValue,
  isUnitValue,
  type BorderValue,
  type ColorComponent,
  type ColorValue,
  type CubicBezierValue,
  type FontFamilyValue,
  type FontWeightValue,
  type ShadowTokenValue,
  type ShadowValue,
  type StrokeStyleValue,
  type TokenLiteral,
  type TokenType,
  type TokenValueMap,
  type TransitionValue,
  type TypographyValue,
} from "@tokenc/core";

export interface CssValueSerialization {
  /** `.` is the token's primary custom property; other keys are lossless sub-properties. */
  readonly values: Readonly<Record<string, string>>;
}

export interface UnsupportedCssValue {
  readonly reason: string;
}

export type CssSerializationResult =
  | { readonly ok: true; readonly serialization: CssValueSerialization }
  | { readonly ok: false; readonly unsupported: UnsupportedCssValue };

const FONT_WEIGHTS: Readonly<Record<Exclude<FontWeightValue, number>, number>> = {
  thin: 100,
  hairline: 100,
  "extra-light": 200,
  "ultra-light": 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  "semi-bold": 600,
  "demi-bold": 600,
  bold: 700,
  "extra-bold": 800,
  "ultra-bold": 800,
  black: 900,
  heavy: 900,
  "extra-black": 950,
  "ultra-black": 950,
};

const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "caption",
  "cursive",
  "emoji",
  "fangsong",
  "fantasy",
  "icon",
  "math",
  "menu",
  "message-box",
  "monospace",
  "sans-serif",
  "serif",
  "small-caption",
  "status-bar",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

function trimNumber(value: number): string {
  return String(value);
}

function byte(value: number): string | undefined {
  const scaled = value * 255;
  return Number.isInteger(scaled) ? scaled.toString(16).padStart(2, "0") : undefined;
}

function component(value: ColorComponent): string {
  return value === "none" ? value : trimNumber(value);
}

function percentage(value: ColorComponent): string {
  return value === "none" ? value : `${trimNumber(value)}%`;
}

function colorComponents(value: ColorValue): string {
  const [first, second, third] = value.components;
  if (value.colorSpace === "hsl" || value.colorSpace === "hwb")
    return [component(first), percentage(second), percentage(third)].join(" ");
  if (value.colorSpace === "lab" || value.colorSpace === "lch")
    return [percentage(first), component(second), component(third)].join(" ");
  return value.components.map(component).join(" ");
}

function color(value: ColorValue): string {
  const components = colorComponents(value);
  const alpha = value.alpha < 1 ? ` / ${trimNumber(value.alpha)}` : "";
  if (["hsl", "hwb", "lab", "lch", "oklab", "oklch"].includes(value.colorSpace))
    return `${value.colorSpace}(${components}${alpha})`;
  if (value.colorSpace === "srgb" && value.components.every((entry) => typeof entry === "number")) {
    const bytes = value.components.map(byte);
    const alphaByte = value.alpha < 1 ? byte(value.alpha) : "";
    if (bytes.every((entry) => entry !== undefined) && alphaByte !== undefined)
      return `#${bytes.join("")}${alphaByte}`.toLowerCase();
  }
  return `color(${value.colorSpace} ${components}${alpha})`;
}

function unit(value: { readonly value: number; readonly unit: string }): string {
  return `${trimNumber(value.value)}${value.unit}`;
}

function cssString(value: string): string | undefined {
  let escaped = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    if (character === '"') escaped += '\\"';
    else if (character === "\\") escaped += "\\\\";
    else if (codePoint <= 0x1f || codePoint === 0x7f)
      escaped += `\\${codePoint.toString(16).toUpperCase()} `;
    else escaped += character;
  }
  return `${escaped}"`;
}

function fontFamily(value: FontFamilyValue): string | undefined {
  const families = typeof value === "string" ? [value] : value;
  const serializedFamilies = families.map((family) =>
    GENERIC_FONT_FAMILIES.has(family.toLowerCase()) ? family : cssString(family),
  );
  return serializedFamilies.some((family) => family === undefined)
    ? undefined
    : serializedFamilies.join(", ");
}

function fontWeight(value: FontWeightValue): string {
  return String(typeof value === "number" ? value : FONT_WEIGHTS[value]);
}

function cubicBezier(value: CubicBezierValue): string {
  return `cubic-bezier(${value.map(trimNumber).join(", ")})`;
}

function strokeStyle(value: StrokeStyleValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function border(value: BorderValue): string | undefined {
  const style = strokeStyle(value.style);
  return style ? `${unit(value.width)} ${style} ${color(value.color)}` : undefined;
}

function transition(value: TransitionValue): string {
  return `${unit(value.duration)} ${cubicBezier(value.timingFunction)} ${unit(value.delay)}`;
}

function shadowLayer(value: ShadowValue): string {
  return [
    value.inset ? "inset" : undefined,
    unit(value.offsetX),
    unit(value.offsetY),
    unit(value.blur),
    unit(value.spread),
    color(value.color),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function shadow(value: ShadowTokenValue): string {
  return (Array.isArray(value) ? value : [value]).map(shadowLayer).join(", ");
}

function typography(value: TypographyValue): Readonly<Record<string, string>> | undefined {
  const family = fontFamily(value.fontFamily);
  if (family === undefined) return undefined;
  return {
    "font-family": family,
    "font-size": unit(value.fontSize),
    "font-weight": fontWeight(value.fontWeight),
    "letter-spacing": unit(value.letterSpacing),
    "line-height": trimNumber(value.lineHeight),
  };
}

function serialized(values: Readonly<Record<string, string>>): CssSerializationResult {
  return { ok: true, serialization: { values } };
}

function unsupported(reason: string): CssSerializationResult {
  return { ok: false, unsupported: { reason } };
}

const CSS_SERIALIZERS: {
  readonly [Type in TokenType]: (value: TokenValueMap[Type]) => CssSerializationResult;
} = {
  number: (value) => serialized({ ".": trimNumber(value) }),
  color: (value) => serialized({ ".": color(value) }),
  dimension: (value) => serialized({ ".": unit(value) }),
  duration: (value) => serialized({ ".": unit(value) }),
  fontFamily: (value) => {
    const valueString = fontFamily(value);
    return valueString === undefined
      ? unsupported(
          "font-family strings containing null or lone surrogate code units are not losslessly representable in CSS",
        )
      : serialized({ ".": valueString });
  },
  fontWeight: (value) => serialized({ ".": fontWeight(value) }),
  cubicBezier: (value) => serialized({ ".": cubicBezier(value) }),
  strokeStyle: (value) => {
    const valueString = strokeStyle(value);
    return valueString
      ? serialized({ ".": valueString })
      : {
          ok: false,
          unsupported: {
            reason:
              "custom strokeStyle dash arrays and line caps have no lossless single CSS value",
          },
        };
  },
  border: (value) => {
    if (value.width.value < 0) return unsupported("CSS border widths cannot be negative");
    const valueString = border(value);
    return valueString
      ? serialized({ ".": valueString })
      : unsupported(
          "a border using a custom strokeStyle cannot be represented as a CSS border shorthand",
        );
  },
  transition: (value) =>
    value.duration.value < 0
      ? unsupported("CSS transition durations cannot be negative")
      : serialized({ ".": transition(value) }),
  shadow: (value) => {
    const layers = Array.isArray(value) ? value : [value];
    return layers.some((layer) => layer.blur.value < 0)
      ? unsupported("CSS shadow blur radii cannot be negative")
      : serialized({ ".": shadow(value) });
  },
  gradient: () =>
    unsupported(
      "DTCG gradients define color stops but no CSS gradient function or geometry; choose an explicit platform transform",
    ),
  typography: (value) => {
    if (value.fontSize.value < 0 || value.lineHeight < 0)
      return unsupported("CSS font sizes and line heights cannot be negative");
    const values = typography(value);
    return values === undefined
      ? unsupported(
          "font-family strings containing null or lone surrogate code units are not losslessly representable in CSS",
        )
      : serialized(values);
  },
};

/** Serialize a normalized DTCG value into one CSS value or lossless CSS sub-values. */
export function serializeCssTokenValue<Type extends TokenType>(
  type: Type,
  value: TokenValueMap[Type],
): CssSerializationResult {
  return CSS_SERIALIZERS[type](value);
}

/** Convert a scalar platform-neutral literal to a CSS value. Composite values require a type. */
export function cssValue(value: TokenLiteral): string | undefined {
  if (typeof value === "number") return trimNumber(value);
  if (typeof value === "string") return value;
  if (isColorValue(value)) return color(value);
  if (isUnitValue(value)) return unit(value);
  return undefined;
}
