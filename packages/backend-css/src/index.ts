import {
  contextKey,
  defaultContext,
  isColorValue,
  isUnitValue,
  parseContextKey,
  type ColorComponent,
  type ColorValue,
  type Compilation,
  type CompilationContext,
  type TokenBackend,
  type TokenExpression,
  type TokenId,
  type TokenLiteral,
  type TokenNode,
} from "@tokenc/core";

export interface CssBackendOptions {
  readonly output?: string;
  readonly selector?: string;
  readonly selectors?: Readonly<Record<string, string>>;
  readonly references?: "preserve" | "resolve";
  readonly name?: (token: TokenNode) => string;
}

function trimNumber(value: number): string {
  return Number(value.toFixed(5)).toString();
}

function byte(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0");
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
  if (value.colorSpace === "srgb" && value.components.every((entry) => typeof entry === "number"))
    return `#${value.components.map(byte).join("")}${value.alpha < 1 ? byte(value.alpha) : ""}`.toLowerCase();
  return `color(${value.colorSpace} ${components}${alpha})`;
}

function isJson(value: TokenLiteral): boolean {
  return (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value) ||
    Array.isArray(value) ||
    (typeof value === "object" && !("colorSpace" in value) && !("unit" in value))
  );
}

/** Convert a platform-neutral literal to a CSS value. */
export function cssValue(value: TokenLiteral): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (isColorValue(value)) return color(value);
  if (isUnitValue(value)) return `${trimNumber(value.value)}${value.unit}`;
  if (isJson(value)) return JSON.stringify(value);
  return JSON.stringify(value);
}

/** Default canonical ID to custom-property naming policy. */
export function defaultCssName(token: TokenNode): string {
  return `--${String(token.id)
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/_/gu, "-")
    .toLowerCase()}`;
}

function sameContext(left: CompilationContext, right: CompilationContext): boolean {
  return contextKey(left) === contextKey(right);
}

function renderExpression(
  compilation: Compilation,
  id: TokenId,
  context: CompilationContext,
  strategy: "preserve" | "resolve",
  naming: (token: TokenNode) => string,
): string | undefined {
  const resolved = compilation.resolveToken(id, context);
  if (!resolved) return undefined;
  const expression: TokenExpression = resolved.expression;
  if (strategy === "preserve" && expression.kind === "reference") {
    const target = compilation.getToken(expression.target);
    return target ? `var(${naming(target)})` : undefined;
  }
  return cssValue(resolved.value);
}

function block(selector: string, declarations: readonly [string, string][]): string {
  if (declarations.length === 0) return "";
  return `${selector} {\n${declarations.map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
}

/** Configure the CSS custom-properties backend. */
export function css(options: CssBackendOptions = {}): TokenBackend {
  const output = options.output ?? "dist/tokens.css";
  const naming = options.name ?? defaultCssName;
  const strategy = options.references ?? "preserve";
  return {
    name: "css",
    emit(compilation) {
      const defaults = defaultContext(compilation.contexts);
      const configured = Object.entries(options.selectors ?? {}).map(([key, selector]) => ({
        context: { ...defaults, ...parseContextKey(key) },
        selector,
      }));
      const configuredDefault = configured.find((entry) => sameContext(entry.context, defaults));
      const baseSelector = configuredDefault?.selector ?? options.selector ?? ":root";
      const baseValues = new Map<TokenId, string>();
      const baseDeclarations: [string, string][] = [];
      for (const token of compilation.tokens) {
        const rendered = renderExpression(compilation, token.id, defaults, strategy, naming);
        const source = compilation.getToken(token.id);
        if (rendered !== undefined && source) {
          baseValues.set(token.id, rendered);
          baseDeclarations.push([naming(source), rendered]);
        }
      }
      const blocks = [block(baseSelector, baseDeclarations)];
      const contexts =
        configured.length > 0
          ? configured.filter((entry) => entry !== configuredDefault)
          : compilation.availableContexts
              .filter((context) => !sameContext(context, defaults))
              .map((context) => ({ context, selector: `[data-context="${contextKey(context)}"]` }));
      for (const entry of contexts) {
        const declarations: [string, string][] = [];
        for (const token of compilation.tokens) {
          const rendered = renderExpression(compilation, token.id, entry.context, strategy, naming);
          const source = compilation.getToken(token.id);
          if (rendered !== undefined && source && rendered !== baseValues.get(token.id))
            declarations.push([naming(source), rendered]);
        }
        const renderedBlock = block(entry.selector, declarations);
        if (renderedBlock) blocks.push(renderedBlock);
      }
      return [{ path: output, content: `${blocks.filter(Boolean).join("\n\n")}\n` }];
    },
  };
}
