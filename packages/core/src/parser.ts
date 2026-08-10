import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import { parseColorValue } from "./dtcg/color.js";
import { isTokenType, isValidTokenSegment } from "./dtcg/format.js";
import type {
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
  readonly #origin: SourceLocation | undefined;

  constructor(content: string, file: string, origin?: SourceLocation) {
    this.#content = content;
    this.#file = file;
    this.#origin = origin;
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
    const excerpt =
      low === 0 && this.#origin?.excerpt
        ? this.#origin.excerpt
        : this.#content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).replace(/\r$/u, "");
    return {
      file: this.#origin?.file ?? this.#file,
      line: low + (this.#origin?.line ?? 1),
      column: offset - lineStart + 1 + (low === 0 ? (this.#origin?.column ?? 1) - 1 : 0),
      offset: offset + (this.#origin?.offset ?? 0),
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

function isNamedFontWeight(value: string): value is NamedFontWeight {
  return FONT_WEIGHTS.has(value);
}

function parseLiteral(type: TokenType, value: JsonValue): TokenLiteral | undefined {
  if (type === "number") return typeof value === "number" ? value : undefined;
  if (type === "fontFamily") {
    if (typeof value === "string" && value.trim()) return value;
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((family) => typeof family === "string" && family.trim())
    )
      return value;
    return undefined;
  }
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
  if (type === "color") {
    const parsed = parseColorValue(value);
    if ("value" in parsed) return { kind: "literal", value: parsed.value };
    diagnostics.push({
      code:
        parsed.error === "unsupported-space"
          ? "DTCG_UNSUPPORTED_COLOR_SPACE"
          : "DTCG_INVALID_COLOR",
      severity: "error",
      message:
        parsed.error === "non-structured"
          ? `Expected a structured DTCG color value with \`colorSpace\` and \`components\`; optional fields are \`alpha\` and \`hex\`. Received ${JSON.stringify(value)}`
          : parsed.error === "unsupported-space"
            ? "Unsupported DTCG color space"
            : "Invalid DTCG color value",
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
        origin: "extension-context",
      });
  }
  return result;
}

export interface ParseTokenDocumentOptions {
  readonly origin?: SourceLocation;
}

/** Parse one DTCG JSON document without performing file-system IO. */
export function parseTokenDocument(
  content: string,
  source: string,
  options: ParseTokenDocumentOptions = {},
): ParsedTokenDocument {
  const locator = new Locator(content, source, options.origin);
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

    const descriptionProperty = findProperty(node, "$description");
    if (descriptionProperty && typeof propertyValue(descriptionProperty)?.value !== "string")
      diagnostics.push({
        code: "DTCG_INVALID_DESCRIPTION",
        severity: "error",
        message: "DTCG `$description` must be a string",
        source: locator.at(descriptionProperty.offset, descriptionProperty.length),
      });
    const extensionsProperty = findProperty(node, "$extensions");
    if (extensionsProperty && propertyValue(extensionsProperty)?.type !== "object")
      diagnostics.push({
        code: "DTCG_INVALID_EXTENSIONS",
        severity: "error",
        message: "DTCG `$extensions` must be an object",
        source: locator.at(extensionsProperty.offset, extensionsProperty.length),
      });
    const deprecatedProperty = findProperty(node, "$deprecated");
    const deprecatedValue = deprecatedProperty
      ? propertyValue(deprecatedProperty)?.value
      : undefined;
    if (
      deprecatedProperty &&
      typeof deprecatedValue !== "boolean" &&
      typeof deprecatedValue !== "string"
    )
      diagnostics.push({
        code: "DTCG_INVALID_DEPRECATED",
        severity: "error",
        message: "DTCG `$deprecated` must be a boolean or string",
        source: locator.at(deprecatedProperty.offset, deprecatedProperty.length),
      });

    const valueProperty = findProperty(node, "$value");
    if (valueProperty) {
      const valueNode = propertyValue(valueProperty);
      const childProperties = properties(node).filter(
        (property) => !propertyName(property).startsWith("$"),
      );
      if (childProperties.length > 0) {
        diagnostics.push({
          code: "DTCG_INVALID_TOKEN_STRUCTURE",
          severity: "error",
          message: "A DTCG object cannot be both a token and a group",
          source: locator.at(node.offset, node.length),
          related: childProperties.map((property) => ({
            message: `Child \`${propertyName(property)}\` makes this object a group`,
            source: locator.at(property.offset, property.length),
          })),
        });
        return;
      }
      const allowed = new Set(["$value", "$type", "$description", "$extensions", "$deprecated"]);
      for (const property of properties(node)) {
        const name = propertyName(property);
        if (name.startsWith("$") && !allowed.has(name))
          diagnostics.push({
            code: name === "$ref" ? "DTCG_UNSUPPORTED_JSON_POINTER" : "DTCG_INVALID_TOKEN_PROPERTY",
            severity: "error",
            message:
              name === "$ref"
                ? "Property-level JSON Pointer references are not supported in this release"
                : `Unknown DTCG token property \`${name}\``,
            source: locator.at(property.offset, property.length),
          });
      }
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
      const invalidSegment = path.find((segment) => !isValidTokenSegment(segment));
      if (invalidSegment) {
        diagnostics.push({
          code: "DTCG_INVALID_TOKEN_NAME",
          severity: "error",
          message: `Invalid token path segment \`${invalidSegment}\``,
          source: locator.at(node.offset, node.length),
        });
        return;
      }
      const expression = parseExpression(valueNode, type, locator, diagnostics);
      if (!expression) return;
      const id = tokenIdFromSegments(path);
      const descriptionValue = descriptionProperty
        ? propertyValue(descriptionProperty)?.value
        : undefined;
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
        ...(typeof deprecatedValue === "boolean" || typeof deprecatedValue === "string"
          ? { deprecated: deprecatedValue }
          : {}),
        ...(extensionsValue &&
        !Array.isArray(extensionsValue) &&
        typeof extensionsValue === "object"
          ? { extensions: extensionsValue }
          : {}),
      };
      tokens.push(token);
      return;
    }

    const rootProperty = findProperty(node, "$root");
    const rootToken = rootProperty ? propertyValue(rootProperty) : undefined;
    if (rootToken) visit(rootToken, [...path, "$root"], type);
    const tokenReference = findProperty(node, "$ref");
    if (tokenReference)
      diagnostics.push({
        code: "DTCG_UNSUPPORTED_JSON_POINTER",
        severity: "error",
        message: "Property-level JSON Pointer references are not supported in this release",
        source: locator.at(tokenReference.offset, tokenReference.length),
      });
    const unsupportedExtends = findProperty(node, "$extends");
    if (unsupportedExtends)
      diagnostics.push({
        code: "DTCG_UNSUPPORTED_GROUP_EXTENDS",
        severity: "error",
        message: "DTCG group `$extends` is not supported in this release",
        source: locator.at(unsupportedExtends.offset, unsupportedExtends.length),
      });
    const allowed = new Set([
      "$type",
      "$description",
      "$extensions",
      "$extends",
      "$ref",
      "$deprecated",
      "$root",
    ]);
    for (const property of properties(node)) {
      const name = propertyName(property);
      if (name.startsWith("$") && !allowed.has(name))
        diagnostics.push({
          code: "DTCG_INVALID_GROUP_PROPERTY",
          severity: "error",
          message: `Unknown DTCG group property \`${name}\``,
          source: locator.at(property.offset, property.length),
        });
    }

    for (const property of properties(node)) {
      const name = propertyName(property);
      const child = propertyValue(property);
      if (!name.startsWith("$") && child?.type === "object") {
        if (!isValidTokenSegment(name)) {
          diagnostics.push({
            code: "DTCG_INVALID_TOKEN_NAME",
            severity: "error",
            message: `Invalid token path segment \`${name}\``,
            source: locator.at(property.offset, property.length),
          });
        } else visit(child, [...path, name], type);
      }
    }
  };
  visit(root, []);
  return { source, content, tokens, diagnostics };
}
