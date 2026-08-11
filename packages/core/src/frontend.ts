import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import { isTokenType, isValidTokenSegment } from "./dtcg/format.js";
import { parseJsonPointer, resolveJsonPointer } from "./dtcg/json-pointer.js";
import { parseTokenLiteral } from "./dtcg/value.js";
import {
  CONTEXT_EXTENSION,
  interpretContextEntries,
  interpretContextExtension,
} from "./extensions/context.js";
import type {
  CompilationContext,
  ContextOverride,
  Diagnostic,
  JsonPointerDependency,
  JsonValue,
  ParsedTokenDocument,
  SourceLocation,
  TokenExpression,
  TokenId,
  TokenInheritance,
  TokenLiteral,
  TokenNode,
  TokenType,
} from "./model.js";
import { parseTokenId, tokenIdFromSegments } from "./token-id.js";

export interface FrontendParseOptions {
  readonly origin?: SourceLocation;
}

interface RawExpression {
  readonly kind: "value" | "pointer";
  readonly value?: JsonValue;
  readonly reference?: string;
  readonly source: SourceLocation;
}

interface RawOverride {
  readonly selector: CompilationContext;
  readonly expression: RawExpression;
  readonly source: SourceLocation;
}

interface UnresolvedToken {
  readonly id: TokenId;
  readonly path: readonly string[];
  readonly group: UnresolvedGroup;
  readonly syntaxDocument: UnresolvedTokenDocument;
  readonly outputDocument: UnresolvedTokenDocument;
  readonly explicitType?: TokenType;
  readonly inheritedType?: TokenType;
  readonly expression: RawExpression;
  readonly description?: string;
  readonly deprecated?: boolean | string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly overrides: readonly RawOverride[];
  readonly source: SourceLocation;
  readonly inheritance?: TokenInheritance;
}

interface GroupExtension {
  readonly reference: string;
  readonly source: SourceLocation;
}

interface UnresolvedGroup {
  readonly path: readonly string[];
  readonly document: UnresolvedTokenDocument;
  readonly parent?: UnresolvedGroup;
  readonly explicitType?: TokenType;
  readonly extension?: GroupExtension;
  readonly source: SourceLocation;
  readonly tokens: UnresolvedToken[];
  readonly children: UnresolvedGroup[];
}

export interface UnresolvedTokenDocument {
  readonly source: string;
  readonly content: string;
  readonly rootValue: JsonValue;
  root?: UnresolvedGroup;
  readonly tokens: readonly UnresolvedToken[];
  readonly groups: readonly UnresolvedGroup[];
  readonly diagnostics: readonly Diagnostic[];
}

interface ParsedFrontendState {
  readonly syntax: UnresolvedTokenDocument;
  readonly batch: readonly UnresolvedTokenDocument[];
}

const parsedFrontendState = new WeakMap<ParsedTokenDocument, ParsedFrontendState>();

class Locator {
  readonly #starts: number[] = [0];
  readonly #content: string;
  readonly #file: string;
  readonly #origin: SourceLocation | undefined;

  constructor(content: string, file: string, origin?: SourceLocation) {
    this.#content = content;
    this.#file = file;
    this.#origin = origin;
    for (let index = 0; index < content.length; index += 1)
      if (content.charCodeAt(index) === 10) this.#starts.push(index + 1);
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

function properties(node: Node | undefined): readonly Node[] {
  return node?.type === "object"
    ? (node.children ?? []).filter((child) => child.type === "property")
    : [];
}

function propertyName(property: Node): string {
  const key = property.children?.[0];
  return typeof key?.value === "string" ? key.value : "";
}

function propertyValue(property: Node | undefined): Node | undefined {
  return property?.children?.[1];
}

function findProperty(node: Node | undefined, name: string): Node | undefined {
  return properties(node).find((property) => propertyName(property) === name);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}

function jsonValue(node: Node | undefined): JsonValue | undefined {
  if (!node) return undefined;
  const value: unknown = getNodeValue(node);
  return isJsonValue(value) ? value : undefined;
}

function expressionFromValue(node: Node, locator: Locator): RawExpression | undefined {
  const value = jsonValue(node);
  return value === undefined
    ? undefined
    : { kind: "value", value, source: locator.at(node.offset, node.length) };
}

function expressionFromPointer(node: Node, locator: Locator): RawExpression | undefined {
  return typeof node.value === "string"
    ? {
        kind: "pointer",
        reference: node.value,
        source: locator.at(node.offset, node.length),
      }
    : undefined;
}

function readOverrides(
  tokenNode: Node,
  extensions: Readonly<Record<string, JsonValue>> | undefined,
  locator: Locator,
  diagnostics: Diagnostic[],
): RawOverride[] {
  const extensionsNode = propertyValue(findProperty(tokenNode, "$extensions"));
  const contextsNode = propertyValue(findProperty(extensionsNode, CONTEXT_EXTENSION));
  const contextProperties = properties(contextsNode);
  const rawEntries = contextProperties.flatMap((property) => {
    const value = jsonValue(propertyValue(property));
    return value === undefined ? [] : [{ key: propertyName(property), value }];
  });
  const interpreted =
    contextsNode?.type === "object"
      ? interpretContextEntries(rawEntries)
      : interpretContextExtension(extensions);
  const result: RawOverride[] = [];
  for (const issue of interpreted.issues) {
    const property = issue.index === undefined ? undefined : contextProperties[issue.index];
    diagnostics.push({
      code: issue.code,
      severity: "error",
      message: issue.message,
      source: locator.at(
        property?.offset ?? contextsNode?.offset ?? tokenNode.offset,
        property?.length ?? contextsNode?.length ?? tokenNode.length,
      ),
    });
  }
  for (const entry of interpreted.entries) {
    const overrideProperty = contextProperties[entry.index];
    const rawValueNode = propertyValue(overrideProperty);
    const source = rawValueNode
      ? locator.at(rawValueNode.offset, rawValueNode.length)
      : locator.at(tokenNode.offset, tokenNode.length);
    result.push({
      selector: entry.selector,
      expression: { kind: "value", value: entry.value, source },
      source,
    });
  }
  return result;
}

function metadata(
  node: Node,
  locator: Locator,
  diagnostics: Diagnostic[],
): {
  readonly description?: string;
  readonly deprecated?: boolean | string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
} {
  const descriptionProperty = findProperty(node, "$description");
  const description = propertyValue(descriptionProperty)?.value;
  if (descriptionProperty && typeof description !== "string")
    diagnostics.push({
      code: "DTCG_INVALID_DESCRIPTION",
      severity: "error",
      message: "DTCG `$description` must be a string",
      source: locator.at(descriptionProperty.offset, descriptionProperty.length),
    });
  const extensionsProperty = findProperty(node, "$extensions");
  const extensionsNode = propertyValue(extensionsProperty);
  if (extensionsProperty && extensionsNode?.type !== "object")
    diagnostics.push({
      code: "DTCG_INVALID_EXTENSIONS",
      severity: "error",
      message: "DTCG `$extensions` must be an object",
      source: locator.at(extensionsProperty.offset, extensionsProperty.length),
    });
  const deprecatedProperty = findProperty(node, "$deprecated");
  const deprecated = propertyValue(deprecatedProperty)?.value;
  if (deprecatedProperty && typeof deprecated !== "boolean" && typeof deprecated !== "string")
    diagnostics.push({
      code: "DTCG_INVALID_DEPRECATED",
      severity: "error",
      message: "DTCG `$deprecated` must be a boolean or string",
      source: locator.at(deprecatedProperty.offset, deprecatedProperty.length),
    });
  const rawExtensions = jsonValue(extensionsNode);
  const extensions =
    rawExtensions !== null && !Array.isArray(rawExtensions) && typeof rawExtensions === "object"
      ? rawExtensions
      : undefined;
  return {
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof deprecated === "boolean" || typeof deprecated === "string" ? { deprecated } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

function explicitType(
  node: Node,
  locator: Locator,
  diagnostics: Diagnostic[],
): TokenType | undefined {
  const typeProperty = findProperty(node, "$type");
  if (!typeProperty) return undefined;
  const value = propertyValue(typeProperty)?.value;
  if (typeof value === "string" && isTokenType(value)) return value;
  diagnostics.push({
    code: "TOKEN_INVALID_TYPE",
    severity: "error",
    message: `Unknown token type \`${String(value)}\``,
    source: locator.at(typeProperty.offset, typeProperty.length),
  });
  return undefined;
}

/** Parse syntax and provenance without requiring final token types to be known. */
export function parseUnresolvedTokenDocument(
  content: string,
  source: string,
  options: FrontendParseOptions = {},
): UnresolvedTokenDocument {
  const locator = new Locator(content, source, options.origin);
  const parseErrors: ParseError[] = [];
  const rootNode = parseTree(content, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  const diagnostics: Diagnostic[] = parseErrors.map((error) => ({
    code: "TOKEN_INVALID_JSON",
    severity: "error",
    message: printParseErrorCode(error.error),
    source: locator.at(error.offset, error.length),
  }));
  const emptyLocation = locator.at(0, Math.max(1, content.length));
  if (!rootNode || rootNode.type !== "object" || parseErrors.length > 0) {
    const empty: UnresolvedTokenDocument = {
      source,
      content,
      rootValue: {},
      tokens: [],
      groups: [],
      diagnostics,
    };
    empty.root = {
      path: [],
      document: empty,
      source: emptyLocation,
      tokens: [],
      children: [],
    };
    return empty;
  }
  const rootValue = jsonValue(rootNode);
  if (rootValue === undefined || rootValue === null || Array.isArray(rootValue)) {
    diagnostics.push({
      code: "TOKEN_INVALID_JSON",
      severity: "error",
      message: "A DTCG token document must contain a root object",
      source: emptyLocation,
    });
  }

  const tokens: UnresolvedToken[] = [];
  const groups: UnresolvedGroup[] = [];
  let document: UnresolvedTokenDocument;

  const visitGroup = (
    node: Node,
    path: readonly string[],
    parent: UnresolvedGroup | undefined,
    inheritedType: TokenType | undefined,
  ): UnresolvedGroup => {
    const ownType = explicitType(node, locator, diagnostics);
    const effectiveLocalType = ownType ?? inheritedType;
    metadata(node, locator, diagnostics);
    const extendsProperty = findProperty(node, "$extends");
    const extendsValue = propertyValue(extendsProperty);
    let extension: GroupExtension | undefined;
    if (extendsProperty) {
      if (typeof extendsValue?.value === "string")
        extension = {
          reference: extendsValue.value,
          source: locator.at(extendsValue.offset, extendsValue.length),
        };
      else
        diagnostics.push({
          code: "DTCG_INVALID_GROUP_EXTENDS",
          severity: "error",
          message: "DTCG group `$extends` must be a reference string",
          source: locator.at(extendsProperty.offset, extendsProperty.length),
        });
    }
    const group: UnresolvedGroup = {
      path,
      document,
      ...(parent ? { parent } : {}),
      ...(ownType ? { explicitType: ownType } : {}),
      ...(extension ? { extension } : {}),
      source: locator.at(node.offset, node.length),
      tokens: [],
      children: [],
    };
    groups.push(group);

    const rootProperty = findProperty(node, "$root");
    const rootTokenNode = propertyValue(rootProperty);
    const children = [
      ...(rootTokenNode ? [{ name: "$root", node: rootTokenNode, property: rootProperty }] : []),
      ...properties(node)
        .filter((property) => !propertyName(property).startsWith("$"))
        .map((property) => ({
          name: propertyName(property),
          node: propertyValue(property),
          property,
        })),
    ];
    for (const childEntry of children) {
      const child = childEntry.node;
      const childPath = [...path, childEntry.name];
      if (!isValidTokenSegment(childEntry.name)) {
        diagnostics.push({
          code: "DTCG_INVALID_TOKEN_NAME",
          severity: "error",
          message: `Invalid token path segment \`${childEntry.name}\``,
          source: locator.at(
            childEntry.property?.offset ?? node.offset,
            childEntry.property?.length ?? 1,
          ),
        });
        continue;
      }
      if (child?.type !== "object") {
        diagnostics.push({
          code: "DTCG_INVALID_GROUP_MEMBER",
          severity: "error",
          message: `DTCG group member \`${childEntry.name}\` must be an object`,
          source: locator.at(child?.offset ?? node.offset, child?.length ?? 1),
        });
        continue;
      }
      const valueProperty = findProperty(child, "$value");
      const referenceProperty = findProperty(child, "$ref");
      if (valueProperty || referenceProperty) {
        const childProperties = properties(child).filter(
          (property) => !propertyName(property).startsWith("$"),
        );
        if (childProperties.length > 0) {
          diagnostics.push({
            code: "DTCG_INVALID_TOKEN_STRUCTURE",
            severity: "error",
            message: "A DTCG object cannot be both a token and a group",
            source: locator.at(child.offset, child.length),
            related: childProperties.map((property) => ({
              message: `Child \`${propertyName(property)}\` makes this object a group`,
              source: locator.at(property.offset, property.length),
            })),
          });
          continue;
        }
        if (valueProperty && referenceProperty) {
          diagnostics.push({
            code: "DTCG_INVALID_TOKEN_STRUCTURE",
            severity: "error",
            message: "A DTCG token cannot define both `$value` and `$ref`",
            source: locator.at(child.offset, child.length),
          });
          continue;
        }
        const tokenType = explicitType(child, locator, diagnostics);
        const tokenMetadata = metadata(child, locator, diagnostics);
        const valueNode = propertyValue(valueProperty);
        const referenceNode = propertyValue(referenceProperty);
        const expression = referenceNode
          ? expressionFromPointer(referenceNode, locator)
          : valueNode
            ? expressionFromValue(valueNode, locator)
            : undefined;
        if (!expression) {
          diagnostics.push({
            code: referenceNode ? "DTCG_INVALID_JSON_POINTER" : "TOKEN_INVALID_VALUE",
            severity: "error",
            message: referenceNode
              ? "DTCG `$ref` must be a JSON Pointer string"
              : "Invalid token value",
            source: locator.at(child.offset, child.length),
          });
          continue;
        }
        const allowed = new Set([
          "$value",
          "$ref",
          "$type",
          "$description",
          "$extensions",
          "$deprecated",
        ]);
        for (const property of properties(child)) {
          const name = propertyName(property);
          if (name.startsWith("$") && !allowed.has(name))
            diagnostics.push({
              code: "DTCG_INVALID_TOKEN_PROPERTY",
              severity: "error",
              message: `Unknown DTCG token property \`${name}\``,
              source: locator.at(property.offset, property.length),
            });
        }
        const token: UnresolvedToken = {
          id: tokenIdFromSegments(childPath),
          path: childPath,
          group,
          syntaxDocument: document,
          outputDocument: document,
          ...(tokenType ? { explicitType: tokenType } : {}),
          ...(effectiveLocalType ? { inheritedType: effectiveLocalType } : {}),
          expression,
          ...tokenMetadata,
          overrides: readOverrides(child, tokenMetadata.extensions, locator, diagnostics),
          source: locator.at(child.offset, child.length),
        };
        group.tokens.push(token);
        tokens.push(token);
      } else {
        group.children.push(visitGroup(child, childPath, group, effectiveLocalType));
      }
    }

    const allowed = new Set([
      "$type",
      "$description",
      "$extensions",
      "$extends",
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
    return group;
  };

  document = {
    source,
    content,
    rootValue: rootValue ?? {},
    tokens,
    groups,
    diagnostics,
  };
  const root = visitGroup(rootNode, [], undefined, undefined);
  document.root = root;
  return document;
}

function groupId(group: UnresolvedGroup): string {
  return group.path.join(".");
}

function relativePath(path: readonly string[], parent: readonly string[]): readonly string[] {
  return path.slice(parent.length);
}

function pathKey(path: readonly string[]): string {
  return path.join("\0");
}

interface EffectiveMember {
  readonly path: readonly string[];
  readonly token: UnresolvedToken;
}

interface PointerAnalysisBase {
  readonly target: UnresolvedToken;
  readonly pointer: string;
  readonly source: SourceLocation;
}

type PointerAnalysis =
  | (PointerAnalysisBase & { readonly kind: "whole" })
  | (PointerAnalysisBase & {
      readonly kind: "property";
      readonly path: readonly string[];
    });

function curlyTarget(expression: RawExpression): TokenId | undefined {
  if (expression.kind !== "value" || typeof expression.value !== "string") return undefined;
  const match = /^\{([^{}]+)\}$/u.exec(expression.value);
  if (!match?.[1]) return undefined;
  try {
    return parseTokenId(match[1]);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function rawPointer(expression: RawExpression): string | undefined {
  if (expression.kind === "pointer") return expression.reference;
  if (
    expression.kind === "value" &&
    expression.value !== null &&
    !Array.isArray(expression.value) &&
    typeof expression.value === "object" &&
    Object.keys(expression.value).length === 1 &&
    typeof expression.value.$ref === "string"
  )
    return expression.value.$ref;
  return undefined;
}

function pointerDiagnostic(
  error: { readonly code: string; readonly message: string },
  reference: string,
  source: SourceLocation,
): Diagnostic {
  const code =
    error.code === "invalid-array-index"
      ? "DTCG_JSON_POINTER_INVALID_ARRAY_INDEX"
      : error.code === "property-not-found"
        ? "DTCG_JSON_POINTER_NOT_FOUND"
        : "DTCG_INVALID_JSON_POINTER";
  return {
    code,
    severity: "error",
    message: `${error.message}: \`${reference}\``,
    source,
  };
}

/** Link all already-loaded documents without performing filesystem IO. */
export function linkTokenDocuments(
  documents: readonly UnresolvedTokenDocument[],
): readonly ParsedTokenDocument[] {
  if (documents.length === 0) return [];
  const diagnosticsByDocument = new Map(
    documents.map((document) => [document, [...document.diagnostics]]),
  );
  const addDiagnostic = (document: UnresolvedTokenDocument, diagnostic: Diagnostic): void => {
    diagnosticsByDocument.get(document)?.push(diagnostic);
  };
  const groupWinners = new Map<string, UnresolvedGroup>();
  for (const document of documents)
    for (const group of document.groups)
      if (group.path.length > 0) groupWinners.set(groupId(group), group);
  const groupsByRawPath = new Map<UnresolvedTokenDocument, Map<string, UnresolvedGroup>>();
  for (const document of documents)
    groupsByRawPath.set(
      document,
      new Map(document.groups.map((group) => [pathKey(group.path), group])),
    );
  const extensionTargetCache = new Map<UnresolvedGroup, UnresolvedGroup | null>();
  const extensionTarget = (group: UnresolvedGroup): UnresolvedGroup | undefined => {
    if (!group.extension) return undefined;
    const cached = extensionTargetCache.get(group);
    if (cached !== undefined) return cached ?? undefined;
    const curly = /^\{([^{}]+)\}$/u.exec(group.extension.reference)?.[1];
    let target: UnresolvedGroup | undefined;
    if (curly) target = groupWinners.get(curly);
    else {
      const parsed = parseJsonPointer(group.extension.reference);
      if (!parsed.ok) {
        addDiagnostic(
          group.document,
          pointerDiagnostic(parsed.error, group.extension.reference, group.extension.source),
        );
      } else if (parsed.reference.documentUri) {
        addDiagnostic(group.document, {
          code: "DTCG_UNSUPPORTED_EXTERNAL_JSON_POINTER",
          severity: "error",
          message: `External JSON Pointer references are not supported: \`${group.extension.reference}\``,
          source: group.extension.source,
        });
      } else {
        const resolved = resolveJsonPointer(group.document.rootValue, parsed.reference.pointer);
        if (!resolved.ok)
          addDiagnostic(
            group.document,
            pointerDiagnostic(resolved.error, group.extension.reference, group.extension.source),
          );
        else
          target = groupsByRawPath
            .get(group.document)
            ?.get(pathKey(parsed.reference.pointer.tokens));
      }
    }
    if (!target)
      addDiagnostic(group.document, {
        code: "DTCG_GROUP_EXTENDS_INVALID_TARGET",
        severity: "error",
        message: `Group \`${groupId(group)}\` extends a missing or non-group target \`${group.extension.reference}\``,
        source: group.extension.source,
      });
    extensionTargetCache.set(group, target ?? null);
    return target;
  };

  const groupTypeCache = new Map<UnresolvedGroup, TokenType | undefined>();
  const effectiveGroupType = (
    group: UnresolvedGroup,
    active: ReadonlySet<UnresolvedGroup> = new Set(),
  ): TokenType | undefined => {
    if (groupTypeCache.has(group)) return groupTypeCache.get(group);
    if (group.explicitType) {
      groupTypeCache.set(group, group.explicitType);
      return group.explicitType;
    }
    if (active.has(group))
      return group.parent ? effectiveGroupType(group.parent, active) : undefined;
    const nextActive = new Set(active).add(group);
    const type =
      (extensionTarget(group)
        ? effectiveGroupType(extensionTarget(group)!, nextActive)
        : undefined) ?? (group.parent ? effectiveGroupType(group.parent, nextActive) : undefined);
    groupTypeCache.set(group, type);
    return type;
  };

  const effectiveCache = new Map<UnresolvedGroup, readonly EffectiveMember[]>();
  const descendantCache = new Map<UnresolvedGroup, readonly UnresolvedGroup[]>();
  const localDescendants = (group: UnresolvedGroup): readonly UnresolvedGroup[] => {
    const cached = descendantCache.get(group);
    if (cached) return cached;
    const result = [group, ...group.children.flatMap(localDescendants)];
    descendantCache.set(group, result);
    return result;
  };
  const activeGroups: UnresolvedGroup[] = [];
  const reportedCycles = new Set<string>();
  const effectiveMembers = (group: UnresolvedGroup): readonly EffectiveMember[] => {
    const cached = effectiveCache.get(group);
    if (cached) return cached;
    const cycleIndex = activeGroups.indexOf(group);
    if (cycleIndex !== -1) {
      const cycle = [...activeGroups.slice(cycleIndex), group];
      const signature = cycle.map(groupId).join("\0");
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature);
        const extension = activeGroups.at(-1)?.extension;
        addDiagnostic(group.document, {
          code: "DTCG_GROUP_EXTENDS_CYCLE",
          severity: "error",
          message: `Circular group extension: ${cycle.map(groupId).join(" → ")}`,
          source: extension?.source ?? group.source,
          related: cycle.slice(0, -1).map((entry) => ({
            message: `Group \`${groupId(entry)}\` participates in this extension cycle`,
            source: entry.source,
          })),
        });
      }
      return [];
    }
    activeGroups.push(group);
    const members = new Map<string, EffectiveMember>();
    const base = extensionTarget(group);
    if (base) {
      for (const member of effectiveMembers(base)) {
        const targetPath = [...group.path, ...member.path];
        const closestLocalType = localDescendants(group)
          .filter(
            (candidate) =>
              candidate.explicitType &&
              targetPath.length > candidate.path.length &&
              candidate.path.every((segment, index) => targetPath[index] === segment),
          )
          .toSorted((left, right) => right.path.length - left.path.length)[0]?.explicitType;
        const inheritedType =
          closestLocalType ?? member.token.inheritedType ?? effectiveGroupType(group);
        const id = tokenIdFromSegments(targetPath);
        const inheritance: TokenInheritance = {
          token: member.token.id,
          group: groupId(base),
          source: member.token.source,
          extendsSource: group.extension?.source ?? group.source,
        };
        const token: UnresolvedToken = {
          ...member.token,
          id,
          path: targetPath,
          outputDocument: group.document,
          group,
          ...(inheritedType ? { inheritedType } : {}),
          inheritance,
        };
        members.set(pathKey(member.path), { path: member.path, token });
      }
    }
    const overlay = (member: EffectiveMember): void => {
      const key = pathKey(member.path);
      for (const existing of members.keys())
        if (existing === key || existing.startsWith(`${key}\0`)) members.delete(existing);
      members.set(key, member);
    };
    for (const token of group.tokens)
      overlay({ path: relativePath(token.path, group.path), token });
    for (const child of group.children) {
      const prefix = relativePath(child.path, group.path);
      members.delete(pathKey(prefix));
      for (const member of effectiveMembers(child)) {
        const combined = [...prefix, ...member.path];
        members.set(pathKey(combined), { path: combined, token: member.token });
      }
    }
    activeGroups.pop();
    const result = [...members.values()];
    effectiveCache.set(group, result);
    return result;
  };

  const materializedByDocument = new Map<UnresolvedTokenDocument, readonly UnresolvedToken[]>();
  for (const document of documents) {
    let materialized = (document.root ? effectiveMembers(document.root) : []).map(
      (member) => member.token,
    );
    const localTokens = new Map<TokenId, UnresolvedToken[]>();
    for (const token of document.tokens) {
      const owners = localTokens.get(token.id) ?? [];
      owners.push(token);
      localTokens.set(token.id, owners);
    }
    const duplicateIds = new Set(
      [...localTokens].filter(([, tokens]) => tokens.length > 1).map(([id]) => id),
    );
    if (duplicateIds.size > 0) {
      materialized = materialized.filter((token) => !duplicateIds.has(token.id));
      materialized.push(...document.tokens.filter((token) => duplicateIds.has(token.id)));
    }
    materialized.sort(
      (left, right) =>
        (left.inheritance?.extendsSource.offset ?? left.source.offset) -
        (right.inheritance?.extendsSource.offset ?? right.source.offset),
    );
    materializedByDocument.set(document, materialized);
  }
  const allTokens = documents.flatMap((document) => materializedByDocument.get(document) ?? []);
  const tokenWinners = new Map<TokenId, UnresolvedToken>();
  for (const token of allTokens) tokenWinners.set(token.id, token);
  const syntaxTokensByPath = new Map<UnresolvedTokenDocument, Map<string, UnresolvedToken>>();
  for (const document of documents)
    syntaxTokensByPath.set(
      document,
      new Map(document.tokens.map((token) => [pathKey(token.path), token])),
    );

  const analyzePointer = (
    reference: string,
    owner: UnresolvedToken,
    source: SourceLocation,
    report = true,
  ): PointerAnalysis | undefined => {
    const parsed = parseJsonPointer(reference);
    if (!parsed.ok) {
      if (report)
        addDiagnostic(owner.outputDocument, pointerDiagnostic(parsed.error, reference, source));
      return undefined;
    }
    if (parsed.reference.documentUri) {
      if (report)
        addDiagnostic(owner.outputDocument, {
          code: "DTCG_UNSUPPORTED_EXTERNAL_JSON_POINTER",
          severity: "error",
          message: `External JSON Pointer references are not supported: \`${reference}\``,
          source,
        });
      return undefined;
    }
    const segments = parsed.reference.pointer.tokens;
    let target: UnresolvedToken | undefined;
    let valueBoundary = -1;
    for (let length = segments.length; length > 0; length -= 1) {
      const candidate = syntaxTokensByPath
        .get(owner.syntaxDocument)
        ?.get(pathKey(segments.slice(0, length)));
      if (!candidate) continue;
      target = tokenWinners.get(candidate.id) ?? candidate;
      valueBoundary = length;
      break;
    }
    if (!target) {
      if (report) {
        const resolved = resolveJsonPointer(
          owner.syntaxDocument.rootValue,
          parsed.reference.pointer,
        );
        addDiagnostic(
          owner.outputDocument,
          resolved.ok
            ? {
                code: "DTCG_JSON_POINTER_INVALID_TARGET",
                severity: "error",
                message: `JSON Pointer does not resolve inside a token: \`${reference}\``,
                source,
              }
            : pointerDiagnostic(resolved.error, reference, source),
        );
      }
      return undefined;
    }
    const remainder = segments.slice(valueBoundary);
    if (remainder.length === 0 || (remainder.length === 1 && remainder[0] === "$value"))
      return { kind: "whole", target, pointer: reference, source };
    if (remainder[0] !== "$value") {
      if (report)
        addDiagnostic(owner.outputDocument, {
          code: "DTCG_JSON_POINTER_INVALID_TARGET",
          severity: "error",
          message: `JSON Pointer must target a token, its \`$value\`, or a component below \`$value\`: \`${reference}\``,
          source,
        });
      return undefined;
    }
    return {
      kind: "property",
      target,
      path: remainder.slice(1),
      pointer: reference,
      source,
    };
  };

  const typeCache = new Map<UnresolvedToken, TokenType | undefined>();
  const typeCycleTokens = new Set<UnresolvedToken>();
  const inferenceTarget = (token: UnresolvedToken): UnresolvedToken | undefined => {
    const curly = curlyTarget(token.expression);
    if (curly) return tokenWinners.get(curly);
    const pointer = rawPointer(token.expression);
    if (!pointer) return undefined;
    const analyzed = analyzePointer(pointer, token, token.expression.source, false);
    return analyzed?.kind === "whole" ? analyzed.target : undefined;
  };
  const inferType = (start: UnresolvedToken): TokenType | undefined => {
    if (typeCache.has(start)) return typeCache.get(start);
    const path: UnresolvedToken[] = [];
    const positions = new Map<UnresolvedToken, number>();
    let current = start;
    let resolved: TokenType | undefined;
    while (true) {
      if (typeCache.has(current)) {
        resolved = typeCache.get(current);
        break;
      }
      if (current.explicitType) {
        resolved = current.explicitType;
        typeCache.set(current, resolved);
        break;
      }
      const cycleIndex = positions.get(current);
      if (cycleIndex !== undefined) {
        for (const member of path.slice(cycleIndex)) typeCycleTokens.add(member);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      const referenceTarget = inferenceTarget(current);
      if (!referenceTarget) break;
      current = referenceTarget;
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const member = path[index];
      if (!member) continue;
      resolved = resolved ?? member.inheritedType ?? effectiveGroupType(member.group);
      typeCache.set(member, resolved);
    }
    return typeCache.get(start);
  };
  for (const token of allTokens) inferType(token);

  const reportedTypeCycles = new Set<UnresolvedToken>();
  for (const token of allTokens) {
    if (inferType(token)) continue;
    if (typeCycleTokens.has(token)) {
      if (reportedTypeCycles.has(token)) continue;
      const cycle: UnresolvedToken[] = [];
      const seen = new Set<UnresolvedToken>();
      let current: UnresolvedToken | undefined = token;
      while (current && !seen.has(current)) {
        seen.add(current);
        cycle.push(current);
        current = inferenceTarget(current);
      }
      for (const member of cycle) reportedTypeCycles.add(member);
      addDiagnostic(token.outputDocument, {
        code: "TOKEN_CANNOT_INFER_TYPE",
        severity: "error",
        message: `Unable to determine a type for reference cycle: ${cycle.map((member) => member.id).join(" → ")}`,
        source: token.source,
        related: cycle.slice(1).map((member) => ({
          message: `\`${member.id}\` also has no explicit, referenced, or inherited type`,
          source: member.source,
        })),
      });
      addDiagnostic(token.outputDocument, {
        code: "TOKEN_CIRCULAR_REFERENCE",
        severity: "error",
        message: `Circular token reference detected: ${[...cycle.map((member) => member.id), token.id].join(" → ")}`,
        source: token.source,
      });
      continue;
    }
    const target = curlyTarget(token.expression);
    const pointer = rawPointer(token.expression);
    if (pointer) analyzePointer(pointer, token, token.expression.source);
    const relatedSource = target ? tokenWinners.get(target)?.source : undefined;
    addDiagnostic(token.outputDocument, {
      code: target || pointer ? "TOKEN_CANNOT_INFER_TYPE" : "TOKEN_MISSING_TYPE",
      severity: "error",
      message: target
        ? `Unable to determine the type of \`${token.id}\`; referenced token \`${target}\` does not provide a type`
        : pointer
          ? `Unable to determine the type of \`${token.id}\` from JSON Pointer \`${pointer}\``
          : `Token \`${token.id}\` has no $type and cannot inherit or infer one`,
      source: token.source,
      ...(target
        ? {
            related: [
              {
                message: tokenWinners.has(target)
                  ? "The referenced token's type could not be determined"
                  : "The referenced token does not exist",
                ...(relatedSource ? { source: relatedSource } : {}),
              },
            ],
          }
        : {}),
    });
  }

  interface ResolvedRawValue {
    readonly value: unknown;
    readonly references: readonly JsonPointerDependency[];
    readonly dependencies: readonly TokenId[];
  }
  const literalCache = new Map<UnresolvedToken, TokenLiteral | undefined>();
  const literalActive = new Set<UnresolvedToken>();
  const literalStack: UnresolvedToken[] = [];
  const reportedLiteralCycles = new Set<string>();
  const resolveLiteral = (token: UnresolvedToken): TokenLiteral | undefined => {
    if (literalCache.has(token)) return literalCache.get(token);
    const type = inferType(token);
    if (!type) return undefined;
    if (literalActive.has(token)) {
      const cycleIndex = literalStack.indexOf(token);
      const cycle = [...literalStack.slice(Math.max(0, cycleIndex)), token];
      const signature = cycle
        .slice(0, -1)
        .map((member) => String(member.id))
        .toSorted()
        .join("\0");
      if (!reportedLiteralCycles.has(signature)) {
        reportedLiteralCycles.add(signature);
        addDiagnostic(token.outputDocument, {
          code: "TOKEN_CIRCULAR_REFERENCE",
          severity: "error",
          message: `Circular nested token reference detected: ${cycle.map((member) => member.id).join(" → ")}`,
          source: token.expression.source,
          related: cycle.slice(1, -1).map((member) => ({
            message: `\`${member.id}\` participates in this nested reference cycle`,
            source: member.expression.source,
          })),
        });
      }
      return undefined;
    }
    literalActive.add(token);
    literalStack.push(token);
    const curly = curlyTarget(token.expression);
    const pointer = rawPointer(token.expression);
    let raw: ResolvedRawValue | undefined;
    if (curly) {
      const target = tokenWinners.get(curly);
      const value = target ? resolveLiteral(target) : undefined;
      if (value !== undefined) raw = { value, references: [], dependencies: [curly] };
    } else if (pointer) {
      const analyzed = analyzePointer(pointer, token, token.expression.source);
      if (analyzed?.kind === "whole") {
        const value = resolveLiteral(analyzed.target);
        if (value !== undefined)
          raw = { value, references: [], dependencies: [analyzed.target.id] };
      } else if (analyzed?.kind === "property") {
        const nested = resolvePointerProperty(analyzed, token, token.expression.source);
        if (nested)
          raw = {
            ...nested,
            references: [
              { pointer, target: analyzed.target.id, source: token.expression.source },
              ...nested.references,
            ],
            dependencies: [analyzed.target.id, ...nested.dependencies],
          };
      }
    } else if (token.expression.value !== undefined)
      raw = resolveNested(token.expression.value, token, token.expression.source);
    literalStack.pop();
    literalActive.delete(token);
    if (!raw) {
      literalCache.set(token, undefined);
      return undefined;
    }
    const parsed = parseTokenLiteral(type, raw.value);
    if (!parsed.ok) {
      addDiagnostic(token.outputDocument, {
        code: parsed.error.code,
        severity: "error",
        message: parsed.error.message,
        source: token.expression.source,
      });
      literalCache.set(token, undefined);
      return undefined;
    }
    literalCache.set(token, parsed.value);
    return parsed.value;
  };

  function resolveNested(
    value: JsonValue,
    owner: UnresolvedToken,
    source: SourceLocation,
  ): ResolvedRawValue | undefined {
    if (typeof value === "string") {
      const match = /^\{([^{}]+)\}$/u.exec(value);
      if (match?.[1]) {
        let targetId: TokenId;
        try {
          targetId = parseTokenId(match[1]);
        } catch {
          addDiagnostic(owner.outputDocument, {
            code: "TOKEN_INVALID_REFERENCE",
            severity: "error",
            message: `Invalid token reference \`${value}\``,
            source,
          });
          return undefined;
        }
        const target = tokenWinners.get(targetId);
        if (!target) {
          addDiagnostic(owner.outputDocument, {
            code: "TOKEN_UNKNOWN_REFERENCE",
            severity: "error",
            message: `Unknown token \`${targetId}\` in nested value`,
            source,
          });
          return undefined;
        }
        const resolved = resolveLiteral(target);
        if (resolved === undefined) return undefined;
        return { value: resolved, references: [], dependencies: [targetId] };
      }
      return { value, references: [], dependencies: [] };
    }
    if (value === null || typeof value === "number" || typeof value === "boolean")
      return { value, references: [], dependencies: [] };
    if (Array.isArray(value)) {
      const items = value.map((item) => resolveNested(item, owner, source));
      if (items.some((item) => item === undefined)) return undefined;
      const resolved = items.filter((item): item is ResolvedRawValue => item !== undefined);
      return {
        value: resolved.map((item) => item.value),
        references: resolved.flatMap((item) => item.references),
        dependencies: resolved.flatMap((item) => item.dependencies),
      };
    }
    if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
      const analyzed = analyzePointer(value.$ref, owner, source);
      if (!analyzed) return undefined;
      if (analyzed.kind === "whole") {
        const resolved = resolveLiteral(analyzed.target);
        return resolved === undefined
          ? undefined
          : {
              value: resolved,
              references: [{ pointer: value.$ref, target: analyzed.target.id, source }],
              dependencies: [analyzed.target.id],
            };
      }
      const nested = resolvePointerProperty(analyzed, owner, source);
      return nested
        ? {
            value: nested.value,
            references: [
              { pointer: value.$ref, target: analyzed.target.id, source },
              ...nested.references,
            ],
            dependencies: [analyzed.target.id, ...nested.dependencies],
          }
        : undefined;
    }
    const entries = Object.entries(value).map(
      ([key, item]) => [key, resolveNested(item, owner, source)] as const,
    );
    if (entries.some(([, item]) => item === undefined)) return undefined;
    const object: Record<string, unknown> = {};
    const references: JsonPointerDependency[] = [];
    const dependencies: TokenId[] = [];
    for (const [key, item] of entries) {
      if (!item) continue;
      object[key] = item.value;
      references.push(...item.references);
      dependencies.push(...item.dependencies);
    }
    return { value: object, references, dependencies };
  }

  function resolvePointerProperty(
    analyzed: Extract<PointerAnalysis, { readonly kind: "property" }>,
    owner: UnresolvedToken,
    source: SourceLocation,
  ): ResolvedRawValue | undefined {
    const targetValue = resolveLiteral(analyzed.target);
    if (targetValue === undefined) return undefined;
    const resolved = resolveJsonPointer(targetValue, {
      source: analyzed.pointer,
      tokens: analyzed.path,
    });
    if (!resolved.ok) {
      addDiagnostic(
        owner.outputDocument,
        pointerDiagnostic(resolved.error, analyzed.pointer, source),
      );
      return undefined;
    }
    if (!isJsonValue(resolved.value)) {
      addDiagnostic(owner.outputDocument, {
        code: "DTCG_JSON_POINTER_INVALID_TARGET",
        severity: "error",
        message: `JSON Pointer target is not a JSON value: \`${analyzed.pointer}\``,
        source,
      });
      return undefined;
    }
    return resolveNested(resolved.value, owner, source);
  }

  const buildExpression = (
    raw: RawExpression,
    owner: UnresolvedToken,
    type: TokenType,
  ):
    | {
        readonly expression: TokenExpression;
        readonly references: readonly JsonPointerDependency[];
        readonly dependencies: readonly TokenId[];
      }
    | undefined => {
    const curly = curlyTarget(raw);
    if (curly)
      return {
        expression: { kind: "reference", target: curly, source: raw.source },
        references: [],
        dependencies: [curly],
      };
    const pointer = rawPointer(raw);
    if (pointer) {
      const analyzed = analyzePointer(pointer, owner, raw.source);
      if (!analyzed) return undefined;
      if (analyzed.kind === "whole")
        return {
          expression: {
            kind: "reference",
            target: analyzed.target.id,
            pointer,
            source: raw.source,
          },
          references: [{ pointer, target: analyzed.target.id, source: raw.source }],
          dependencies: [analyzed.target.id],
        };
      const nested = resolvePointerProperty(analyzed, owner, raw.source);
      if (!nested) return undefined;
      const parsed = parseTokenLiteral(type, nested.value);
      if (!parsed.ok) {
        addDiagnostic(owner.outputDocument, {
          code: parsed.error.code,
          severity: "error",
          message: parsed.error.message,
          source: raw.source,
        });
        return undefined;
      }
      return {
        expression: {
          kind: "json-pointer-reference",
          pointer,
          target: analyzed.target.id,
          value: parsed.value,
          source: raw.source,
        },
        references: [
          { pointer, target: analyzed.target.id, source: raw.source },
          ...nested.references,
        ],
        dependencies: [analyzed.target.id, ...nested.dependencies],
      };
    }
    if (raw.value === undefined) return undefined;
    const nested = resolveNested(raw.value, owner, raw.source);
    if (!nested) return undefined;
    const parsed = parseTokenLiteral(type, nested.value);
    if (!parsed.ok) {
      addDiagnostic(owner.outputDocument, {
        code: parsed.error.code,
        severity: "error",
        message: parsed.error.message,
        source: raw.source,
      });
      return undefined;
    }
    return {
      expression: { kind: "literal", value: parsed.value },
      references: nested.references,
      dependencies: nested.dependencies,
    };
  };

  const parsedByDocument = new Map<UnresolvedTokenDocument, TokenNode[]>();
  for (const document of documents) parsedByDocument.set(document, []);
  for (const token of allTokens) {
    const type = inferType(token);
    if (!type) continue;
    const base = buildExpression(token.expression, token, type);
    if (!base) continue;
    const overrides: ContextOverride[] = [];
    const references: JsonPointerDependency[] = [...base.references];
    const dependencies: TokenId[] = [...base.dependencies];
    for (const override of token.overrides) {
      const built = buildExpression(override.expression, token, type);
      if (!built) continue;
      overrides.push({
        selector: override.selector,
        expression: built.expression,
        source: override.source,
        origin: "extension-context",
      });
      references.push(...built.references);
      dependencies.push(...built.dependencies);
    }
    if (token.inheritance) dependencies.push(token.inheritance.token);
    const node: TokenNode = {
      kind: "token",
      id: token.id,
      type,
      value: base.expression,
      overrides,
      source: token.source,
      dependencies: [...new Set(dependencies)],
      ...(token.description ? { description: token.description } : {}),
      ...(token.deprecated !== undefined ? { deprecated: token.deprecated } : {}),
      ...(token.extensions ? { extensions: token.extensions } : {}),
      ...(references.length > 0 ? { propertyReferences: references } : {}),
      ...(token.inheritance ? { inheritance: token.inheritance } : {}),
    };
    parsedByDocument.get(token.outputDocument)?.push(node);
  }

  const batch = [...documents];
  return documents.map((document) => {
    const parsed: ParsedTokenDocument = {
      source: document.source,
      content: document.content,
      tokens: parsedByDocument.get(document) ?? [],
      diagnostics: diagnosticsByDocument.get(document) ?? [],
    };
    parsedFrontendState.set(parsed, { syntax: document, batch });
    return parsed;
  });
}

/** Re-link separately parsed frontend documents while keeping unresolved state internal. */
export function relinkParsedTokenDocuments(
  documents: readonly ParsedTokenDocument[],
): readonly ParsedTokenDocument[] {
  if (documents.length === 0) return documents;
  const states = documents.map((document) => parsedFrontendState.get(document));
  if (states.some((state) => state === undefined)) return documents;
  const linkedStates = states.filter((state): state is ParsedFrontendState => state !== undefined);
  const existingBatch = linkedStates[0]?.batch;
  if (
    existingBatch &&
    existingBatch.length === documents.length &&
    linkedStates.every(
      (state, index) => state.batch === existingBatch && state.syntax === existingBatch[index],
    )
  )
    return documents;
  return linkTokenDocuments(linkedStates.map((state) => state.syntax));
}
