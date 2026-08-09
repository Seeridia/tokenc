import {
  tokenIdSegments,
  type ColorValue,
  type Compilation,
  type TokenBackend,
  type TokenId,
  type TokenLiteral,
} from "@tokenc/core";

export interface TypeScriptBackendOptions {
  readonly output?: string;
  readonly mode?: "flat" | "object";
  readonly references?: "symbol" | "resolve";
}

function upperFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function byte(value: number): string {
  return Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");
}

/** Convert a canonical token ID to a safe camelCase binding name. */
export function tokenIdentifier(id: TokenId): string {
  const parts = String(id)
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean);
  const name = parts
    .map((part, index) => (index === 0 ? part : upperFirst(part)))
    .join("")
    .replace(/^[^a-zA-Z_$]/u, "token$&");
  return name || "token";
}

function colorString(value: ColorValue): string {
  if (value.colorSpace === "css") return value.value;
  if (value.colorSpace === "oklch") {
    const [l, c, h] = value.components;
    return `oklch(${l} ${c} ${h}${value.alpha < 1 ? ` / ${value.alpha}` : ""})`;
  }
  if (value.original) return value.original;
  return `#${value.components.map(byte).join("")}${value.alpha < 1 ? byte(value.alpha) : ""}`;
}

function isColor(value: TokenLiteral): value is ColorValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "colorSpace" in value &&
    (value.colorSpace === "srgb" || value.colorSpace === "oklch" || value.colorSpace === "css")
  );
}

function isUnitValue(value: TokenLiteral): value is Extract<TokenLiteral, { unit: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "unit" in value &&
    "value" in value &&
    typeof value.value === "number"
  );
}

function jsLiteral(value: TokenLiteral): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (isColor(value)) return JSON.stringify(colorString(value));
  if (isUnitValue(value)) return JSON.stringify(`${value.value}${value.unit}`);
  return JSON.stringify(value, null, 2);
}

function tokenExpression(
  compilation: Compilation,
  id: TokenId,
  strategy: "symbol" | "resolve",
  internalPrefix = "",
): string {
  const resolved = compilation.resolveToken(id);
  if (!resolved) return "undefined";
  if (strategy === "symbol" && resolved.expression.kind === "reference")
    return `${internalPrefix}${tokenIdentifier(resolved.expression.target)}`;
  return jsLiteral(resolved.value);
}

interface TreeNode {
  value?: string;
  readonly children: Map<string, TreeNode>;
}

function objectLiteral(root: TreeNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  const entries = [...root.children.entries()].map(
    ([key, child]) =>
      `${childIndent}${JSON.stringify(key)}: ${child.value ?? objectLiteral(child, depth + 1)}`,
  );
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

/** Configure a TypeScript constants backend. */
export function typescript(options: TypeScriptBackendOptions = {}): TokenBackend {
  const output = options.output ?? "dist/tokens.ts";
  const mode = options.mode ?? "object";
  const strategy = options.references ?? (mode === "flat" ? "symbol" : "resolve");
  return {
    name: "typescript",
    emit(compilation) {
      if (mode === "flat") {
        const declarations = compilation.tokens.map(
          (token) =>
            `export const ${tokenIdentifier(token.id)} = ${tokenExpression(compilation, token.id, strategy)};`,
        );
        return [{ path: output, content: `${declarations.join("\n")}\n` }];
      }
      const internals =
        strategy === "symbol"
          ? compilation.tokens
              .map(
                (token) =>
                  `const _${tokenIdentifier(token.id)} = ${tokenExpression(compilation, token.id, strategy, "_")};`,
              )
              .join("\n")
          : "";
      const root: TreeNode = { children: new Map() };
      for (const token of compilation.tokens) {
        let current = root;
        const segments = tokenIdSegments(token.id);
        for (const [index, segment] of segments.entries()) {
          const child = current.children.get(segment) ?? { children: new Map<string, TreeNode>() };
          current.children.set(segment, child);
          current = child;
          if (index === segments.length - 1)
            current.value =
              strategy === "symbol"
                ? `_${tokenIdentifier(token.id)}`
                : tokenExpression(compilation, token.id, "resolve");
        }
      }
      const content = `${internals ? `${internals}\n\n` : ""}export const tokens = ${objectLiteral(root)} as const;\n`;
      return [{ path: output, content }];
    },
  };
}
