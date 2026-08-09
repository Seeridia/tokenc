import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import type {
  ColorValue,
  CompilationContext,
  ContextOverride,
  Diagnostic,
  DurationValue,
  FontWeightValue,
  JsonValue,
  ParsedTokenDocument,
  SourceLocation,
  TokenExpression,
  TokenLiteral,
  TokenNode,
  TokenType,
} from "./model.js";
import { parseTokenId, tokenIdFromSegments } from "./token-id.js";

const TOKEN_TYPES: ReadonlySet<string> = new Set([
  "color",
  "dimension",
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
]);

class Locator {
  readonly #starts: number[] = [0];
  readonly #content: string;
  readonly #file: string;

  constructor(content: string, file: string) {
    this.#content = content;
    this.#file = file;
    for (let i = 0; i < content.length; i += 1) {
      if (content.charCodeAt(i) === 10) this.#starts.push(i + 1);
    }
  }

  at(offset: number, length = 1): SourceLocation {
    let low = 0;
    let high = this.#starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.#starts[middle] ?? 0) <= offset) low = middle;
      else high = middle;
    }
    const lineStart = this.#starts[low] ?? 0;
    const lineEnd = this.#content.indexOf("\n", lineStart);
    const excerpt = this.#content
      .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      .replace(/\r$/u, "");
    return {
      file: this.#file,
      line: low + 1,
      column: offset - lineStart + 1,
      offset,
      length: Math.max(1, length),
      excerpt,
    };
  }
}

function properties(node: Node): readonly Node[] {
  return node.type === "object"
    ? (node.children ?? []).filter((child) => child.type === "property")
    : [];
}

function propertyName(property: Node): string {
  const key = property.children?.[0];
  return typeof key?.value === "string" ? key.value : "";
}

function propertyValue(property: Node): Node | undefined {
  return property.children?.[1];
}

function findProperty(node: Node, name: string): Node | undefined {
  return properties(node).find((property) => propertyName(property) === name);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function jsonValue(node: Node): JsonValue | undefined {
  const value: unknown = getNodeValue(node);
  return isJsonValue(value) ? value : undefined;
}

function parseHex(input: string): ColorValue | undefined {
  const value = input.slice(1);
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value)) return undefined;
  const expanded =
    value.length <= 4
      ? value
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : value;
  const component = (start: number): number =>
    Number.parseInt(expanded.slice(start, start + 2), 16) / 255;
  const components: readonly [number, number, number] = [component(0), component(2), component(4)];
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return { colorSpace: "srgb", components, alpha, original: input };
}

function numericTriple(
  value: JsonValue | undefined,
): readonly [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [first, second, third] = value;
  if (typeof first !== "number" || typeof second !== "number" || typeof third !== "number")
    return undefined;
  return [first, second, third];
}

function isNamedFontWeight(value: string): value is NamedFontWeight {
  return FONT_WEIGHTS.has(value);
}

function isTokenType(value: string): value is TokenType {
  return TOKEN_TYPES.has(value);
}

function parseColor(value: JsonValue): ColorValue | undefined {
  if (typeof value === "string") {
    if (value.startsWith("#")) return parseHex(value);
    return value.trim() ? { colorSpace: "css", value } : undefined;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const space = value.colorSpace;
  const components = numericTriple(value.components);
  const alpha = value.alpha === undefined ? 1 : value.alpha;
  if ((space !== "srgb" && space !== "oklch") || !components || typeof alpha !== "number")
    return undefined;
  return { colorSpace: space, components, alpha };
}

function parseLiteral(type: TokenType, value: JsonValue): TokenLiteral | undefined {
  if (type === "color") return parseColor(value);
  if (type === "number") return typeof value === "number" ? value : undefined;
  if (type === "dimension") {
    if (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      typeof value.value === "number" &&
      (value.unit === "px" || value.unit === "rem")
    ) {
      return { value: value.value, unit: value.unit };
    }
    return undefined;
  }
  if (type === "duration") {
    if (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      typeof value.value === "number" &&
      (value.unit === "ms" || value.unit === "s")
    ) {
      return { value: value.value, unit: value.unit } satisfies DurationValue;
    }
    return undefined;
  }
  if (type === "fontWeight") {
    if (typeof value === "number" && value >= 1 && value <= 1000) return value;
    if (typeof value === "string" && isNamedFontWeight(value)) return value;
    return undefined;
  }
  return value;
}

function parseContextSelector(input: string): CompilationContext | undefined {
  const context: Record<string, string> = {};
  for (const clause of input.split("&")) {
    const [rawName, rawValue, ...rest] = clause.split("=");
    const name = rawName?.trim();
    const value = rawValue?.trim();
    if (!name || !value || rest.length > 0) return undefined;
    context[name] = value;
  }
  return context;
}

function parseExpression(
  valueNode: Node,
  type: TokenType,
  locator: Locator,
  diagnostics: Diagnostic[],
): TokenExpression | undefined {
  const source = locator.at(valueNode.offset, valueNode.length);
  const value = jsonValue(valueNode);
  if (typeof value === "string") {
    const match = /^\{([^{}]+)\}$/u.exec(value);
    if (match?.[1]) {
      try {
        return { kind: "reference", target: parseTokenId(match[1]), source };
      } catch {
        diagnostics.push({
          code: "TOKEN_INVALID_REFERENCE",
          severity: "error",
          message: `Invalid token reference \`${value}\``,
          source,
        });
        return undefined;
      }
    }
  }
  if (value === undefined) {
    diagnostics.push({
      code: "TOKEN_INVALID_VALUE",
      severity: "error",
      message: `Invalid ${type} token value`,
      source,
    });
    return undefined;
  }
  const literal = parseLiteral(type, value);
  if (literal === undefined) {
    diagnostics.push({
      code: "TOKEN_INVALID_VALUE",
      severity: "error",
      message: `Invalid ${type} token value`,
      source,
    });
    return undefined;
  }
  return { kind: "literal", value: literal };
}

function readOverrides(
  tokenNode: Node,
  type: TokenType,
  locator: Locator,
  diagnostics: Diagnostic[],
): ContextOverride[] {
  const extensionsNode = propertyValue(
    findProperty(tokenNode, "$extensions") ?? { type: "null", offset: 0, length: 0 },
  );
  if (!extensionsNode || extensionsNode.type !== "object") return [];
  const contextsNode = propertyValue(
    findProperty(extensionsNode, "org.token-compiler.contexts") ?? {
      type: "null",
      offset: 0,
      length: 0,
    },
  );
  if (!contextsNode || contextsNode.type !== "object") return [];
  const result: ContextOverride[] = [];
  for (const overrideProperty of properties(contextsNode)) {
    const selector = parseContextSelector(propertyName(overrideProperty));
    const rawValueNode = propertyValue(overrideProperty);
    if (!selector || !rawValueNode) {
      diagnostics.push({
        code: "TOKEN_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Invalid context selector \`${propertyName(overrideProperty)}\``,
        source: locator.at(overrideProperty.offset, overrideProperty.length),
      });
      continue;
    }
    const wrappedValue =
      rawValueNode.type === "object"
        ? propertyValue(
            findProperty(rawValueNode, "$value") ?? { type: "null", offset: 0, length: 0 },
          )
        : undefined;
    const expression = parseExpression(wrappedValue ?? rawValueNode, type, locator, diagnostics);
    if (expression)
      result.push({
        selector,
        expression,
        source: locator.at(rawValueNode.offset, rawValueNode.length),
      });
  }
  return result;
}

/** Parse one DTCG JSON document without performing file-system IO. */
export function parseTokenDocument(content: string, source: string): ParsedTokenDocument {
  const locator = new Locator(content, source);
  const parseErrors: ParseError[] = [];
  const root = parseTree(content, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  const diagnostics: Diagnostic[] = parseErrors.map((error) => ({
    code: "TOKEN_INVALID_JSON",
    severity: "error",
    message: printParseErrorCode(error.error),
    source: locator.at(error.offset, error.length),
  }));
  if (!root || root.type !== "object" || parseErrors.length > 0)
    return { source, content, tokens: [], diagnostics };

  const tokens: TokenNode[] = [];
  const visit = (node: Node, path: readonly string[], inheritedType?: TokenType): void => {
    const ownTypeProperty = findProperty(node, "$type");
    const ownTypeValue = ownTypeProperty ? propertyValue(ownTypeProperty)?.value : undefined;
    let type = inheritedType;
    if (ownTypeProperty) {
      if (typeof ownTypeValue === "string" && isTokenType(ownTypeValue)) type = ownTypeValue;
      else
        diagnostics.push({
          code: "TOKEN_INVALID_TYPE",
          severity: "error",
          message: `Unknown token type \`${String(ownTypeValue)}\``,
          source: locator.at(ownTypeProperty.offset, ownTypeProperty.length),
        });
    }

    const valueProperty = findProperty(node, "$value");
    if (valueProperty) {
      const valueNode = propertyValue(valueProperty);
      if (path.length === 0 || !type || !valueNode) {
        diagnostics.push({
          code: type ? "TOKEN_INVALID_ID" : "TOKEN_MISSING_TYPE",
          severity: "error",
          message: type
            ? "A token must have a non-empty path"
            : `Token \`${path.join(".")}\` has no $type and cannot inherit one`,
          source: locator.at(node.offset, node.length),
        });
        return;
      }
      const expression = parseExpression(valueNode, type, locator, diagnostics);
      if (!expression) return;
      const id = tokenIdFromSegments(path);
      const descriptionProperty = findProperty(node, "$description");
      const descriptionValue = descriptionProperty
        ? propertyValue(descriptionProperty)?.value
        : undefined;
      const extensionsProperty = findProperty(node, "$extensions");
      const extensionsNode = extensionsProperty ? propertyValue(extensionsProperty) : undefined;
      const extensionsValue = extensionsNode ? jsonValue(extensionsNode) : undefined;
      const overrides = readOverrides(node, type, locator, diagnostics);
      const dependencies = [expression, ...overrides.map((override) => override.expression)]
        .filter(
          (candidate): candidate is Extract<TokenExpression, { kind: "reference" }> =>
            candidate.kind === "reference",
        )
        .map((reference) => reference.target);
      const token: TokenNode = {
        kind: "token",
        id,
        type,
        value: expression,
        overrides,
        source: locator.at(node.offset, node.length),
        dependencies: [...new Set(dependencies)],
        ...(typeof descriptionValue === "string" ? { description: descriptionValue } : {}),
        ...(extensionsValue &&
        !Array.isArray(extensionsValue) &&
        typeof extensionsValue === "object"
          ? { extensions: extensionsValue }
          : {}),
      };
      tokens.push(token);
      return;
    }

    for (const property of properties(node)) {
      const name = propertyName(property);
      const child = propertyValue(property);
      if (!name.startsWith("$") && child?.type === "object") visit(child, [...path, name], type);
    }
  };
  visit(root, []);
  return { source, content, tokens, diagnostics };
}
