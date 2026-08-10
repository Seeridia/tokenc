import {
  contextKey,
  defaultContext,
  isColorValue,
  isUnitValue,
  type ColorComponent,
  type ColorValue,
  type Compilation,
  type CompilationContext,
  type TokenBackend,
  type TokenId,
  type TokenLiteral,
  type TokenNode,
} from "@tokenc/core";

export interface TailwindBackendOptions {
  readonly output?: string;
  readonly references?: "preserve" | "resolve";
  readonly selectors?: Readonly<Record<string, string>>;
}

function runtimeName(id: TokenId): string {
  return `--token-${String(id)
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .toLowerCase()}`;
}

function trim(value: number): string {
  return Number(value.toFixed(5)).toString();
}

function byte(value: number): string {
  return Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");
}

function component(value: ColorComponent): string {
  return value === "none" ? value : trim(value);
}

function percentage(value: ColorComponent): string {
  return value === "none" ? value : `${trim(value)}%`;
}

function colorComponents(value: Exclude<ColorValue, { colorSpace: "css" }>): string {
  const [first, second, third] = value.components;
  if (value.colorSpace === "hsl" || value.colorSpace === "hwb")
    return [component(first), percentage(second), percentage(third)].join(" ");
  if (value.colorSpace === "lab" || value.colorSpace === "lch")
    return [percentage(first), component(second), component(third)].join(" ");
  return value.components.map(component).join(" ");
}

function literal(value: TokenLiteral): string {
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (isUnitValue(value)) return `${trim(value.value)}${value.unit}`;
  if (isColorValue(value)) {
    const color: ColorValue = value;
    if (color.colorSpace === "css") return color.value;
    if (color.original) return color.original.toLowerCase();
    const components = colorComponents(color);
    const alpha = color.alpha < 1 ? ` / ${trim(color.alpha)}` : "";
    if (["hsl", "hwb", "lab", "lch", "oklab", "oklch"].includes(color.colorSpace))
      return `${color.colorSpace}(${components}${alpha})`;
    if (color.colorSpace === "srgb" && color.components.every((entry) => typeof entry === "number"))
      return `#${color.components.map(byte).join("")}${color.alpha < 1 ? byte(color.alpha) : ""}`;
    return `color(${color.colorSpace} ${components}${alpha})`;
  }
  return JSON.stringify(value);
}

function themeName(token: TokenNode): string | undefined {
  const segments = String(token.id).split(".");
  if (token.type === "color")
    return `--color-${(segments[0] === "color" ? segments.slice(1) : segments).join("-")}`;
  if (token.type === "dimension") {
    if (segments[0] === "radius" || segments.includes("radius"))
      return `--radius-${(segments[0] === "radius" ? segments.slice(1) : segments).join("-")}`;
    return `--spacing-${(segments[0] === "spacing" ? segments.slice(1) : segments).join("-")}`;
  }
  if (token.type === "fontWeight")
    return `--font-weight-${(segments[0] === "fontWeight" ? segments.slice(1) : segments).join("-")}`;
  if (token.type === "shadow")
    return `--shadow-${(segments[0] === "shadow" ? segments.slice(1) : segments).join("-")}`;
  return undefined;
}

function defaultSelector(context: CompilationContext, defaults: CompilationContext): string {
  return (
    Object.entries(context)
      .filter(([name, value]) => defaults[name] !== value)
      .map(([name, value]) => `[data-${name}="${value}"]`)
      .join("") || ":root"
  );
}

function render(
  compilation: Compilation,
  id: TokenId,
  context: CompilationContext,
  strategy: "preserve" | "resolve",
): string | undefined {
  const resolved = compilation.resolveToken(id, context);
  if (!resolved) return undefined;
  if (strategy === "preserve" && resolved.expression.kind === "reference")
    return `var(${runtimeName(resolved.expression.target)})`;
  return literal(resolved.value);
}

function cssBlock(selector: string, declarations: readonly string[]): string {
  return declarations.length
    ? `${selector} {\n${declarations.map((line) => `  ${line}`).join("\n")}\n}`
    : "";
}

/** Configure the Tailwind v4 CSS-first backend. */
export function tailwind(options: TailwindBackendOptions = {}): TokenBackend {
  const output = options.output ?? "dist/tailwind.css";
  const strategy = options.references ?? "preserve";
  return {
    name: "tailwind",
    emit(compilation) {
      const defaults = defaultContext(compilation.contexts);
      const base = new Map<TokenId, string>();
      const rootLines: string[] = [];
      for (const token of compilation.tokens) {
        const value = render(compilation, token.id, defaults, strategy);
        if (value !== undefined) {
          base.set(token.id, value);
          rootLines.push(`${runtimeName(token.id)}: ${value};`);
        }
      }
      const blocks = [cssBlock(":root", rootLines)];
      for (const context of compilation.availableContexts) {
        if (contextKey(context) === contextKey(defaults)) continue;
        const lines: string[] = [];
        for (const token of compilation.tokens) {
          const value = render(compilation, token.id, context, strategy);
          if (value !== undefined && value !== base.get(token.id))
            lines.push(`${runtimeName(token.id)}: ${value};`);
        }
        const explicit = options.selectors?.[contextKey(context)];
        const renderedBlock = cssBlock(explicit ?? defaultSelector(context, defaults), lines);
        if (renderedBlock) blocks.push(renderedBlock);
      }
      const themeLines = compilation.tokens.flatMap((token) => {
        const source = compilation.getToken(token.id);
        const name = source ? themeName(source) : undefined;
        return name ? [`${name}: var(${runtimeName(token.id)});`] : [];
      });
      blocks.push(`@theme {\n${themeLines.map((line) => `  ${line}`).join("\n")}\n}`);
      return [{ path: output, content: `${blocks.filter(Boolean).join("\n\n")}\n` }];
    },
  };
}
