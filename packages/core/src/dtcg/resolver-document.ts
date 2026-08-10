import { dirname, isAbsolute, resolve } from "node:path";

import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import type { TokenSourceInput } from "../loader.js";
import type {
  CompilationContext,
  ContextDefinition,
  Diagnostic,
  JsonValue,
  SourceLocation,
} from "../model.js";

export interface ResolverReferenceSource {
  readonly kind: "reference";
  readonly ref: string;
  readonly source: SourceLocation;
}

export interface ResolverInlineSource {
  readonly kind: "inline";
  readonly file: string;
  readonly content: string;
  readonly value: Readonly<Record<string, JsonValue>>;
  readonly source: SourceLocation;
}

export type ResolutionSource = ResolverReferenceSource | ResolverInlineSource;

export interface TokenSet {
  readonly kind: "set";
  readonly name: string;
  readonly description?: string;
  readonly sources: readonly ResolutionSource[];
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly source: SourceLocation;
}

export interface ResolverModifier {
  readonly kind: "modifier";
  readonly name: string;
  readonly description?: string;
  readonly contexts: Readonly<Record<string, readonly ResolutionSource[]>>;
  readonly default?: string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly source: SourceLocation;
}

export type ResolutionOrderItem = TokenSet | ResolverModifier;

export interface ResolverDocument {
  readonly source: string;
  readonly content: string;
  readonly version: "2025.10";
  readonly name?: string;
  readonly description?: string;
  readonly sets: ReadonlyMap<string, TokenSet>;
  readonly modifiers: ReadonlyMap<string, ResolverModifier>;
  readonly resolutionOrder: readonly ResolutionOrderItem[];
}

export interface ParsedResolverDocument {
  readonly document?: ResolverDocument;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResolverResolutionStep {
  readonly kind: "set" | "modifier";
  readonly name: string;
  readonly context?: string;
  readonly sources: readonly SourceLocation[];
  readonly source: SourceLocation;
}

export interface ResolverResolution {
  readonly sources: readonly TokenSourceInput[];
  readonly context: CompilationContext;
  readonly contexts: ContextDefinition;
  readonly steps: readonly ResolverResolutionStep[];
  readonly diagnostics: readonly Diagnostic[];
}

class Locator {
  readonly #starts: number[] = [0];

  constructor(
    readonly content: string,
    readonly file: string,
  ) {
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
    const lineEnd = this.content.indexOf("\n", lineStart);
    return {
      file: this.file,
      line: low + 1,
      column: offset - lineStart + 1,
      offset,
      length: Math.max(1, length),
      excerpt: this.content
        .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
        .replace(/\r$/u, ""),
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
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function objectValue(node: Node | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (node?.type !== "object") return undefined;
  const value: unknown = getNodeValue(node);
  return isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === "object"
    ? value
    : undefined;
}

function optionalString(node: Node | undefined, name: string): string | undefined {
  const value = propertyValue(findProperty(node, name))?.value;
  return typeof value === "string" ? value : undefined;
}

function extensions(node: Node | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return objectValue(propertyValue(findProperty(node, "$extensions")));
}

function parseSources(
  node: Node | undefined,
  locator: Locator,
  diagnostics: Diagnostic[],
  pointer: string,
  owner: "set" | "modifier",
): ResolutionSource[] {
  if (node?.type !== "array") {
    diagnostics.push({
      code: "DTCG_INVALID_RESOLVER_DOCUMENT",
      severity: "error",
      message: `Resolver ${owner} sources must be an array`,
      ...(node ? { source: locator.at(node.offset, node.length) } : {}),
    });
    return [];
  }
  return (node.children ?? []).flatMap((child, index): ResolutionSource[] => {
    if (child.type !== "object") {
      diagnostics.push({
        code: "DTCG_INVALID_RESOLUTION_SOURCE",
        severity: "error",
        message: "A resolver source must be a reference object or inline token object",
        source: locator.at(child.offset, child.length),
      });
      return [];
    }
    const reference = optionalString(child, "$ref");
    if (reference !== undefined) {
      if (properties(child).some((property) => propertyName(property) !== "$ref"))
        diagnostics.push({
          code: "DTCG_UNSUPPORTED_RESOLVER_REFERENCE_OVERRIDE",
          severity: "error",
          message: "Resolver reference-object sibling overrides are not supported in this release",
          source: locator.at(child.offset, child.length),
        });
      if (
        reference.startsWith("#/resolutionOrder/") ||
        (owner === "modifier" && reference.startsWith("#/modifiers/")) ||
        (owner === "set" && reference.startsWith("#/modifiers/"))
      ) {
        diagnostics.push({
          code: "DTCG_INVALID_RESOLVER_REFERENCE",
          severity: "error",
          message: `Invalid ${owner} reference \`${reference}\``,
          source: locator.at(child.offset, child.length),
        });
        return [];
      }
      return [
        {
          kind: "reference" as const,
          ref: reference,
          source: locator.at(child.offset, child.length),
        },
      ];
    }
    const value = objectValue(child);
    return value
      ? [
          {
            kind: "inline" as const,
            file: `${locator.file}#${pointer}/${index}`,
            content: locator.content.slice(child.offset, child.offset + child.length),
            value,
            source: locator.at(child.offset, child.length),
          },
        ]
      : [];
  });
}

function parseSet(
  name: string,
  node: Node | undefined,
  locator: Locator,
  diagnostics: Diagnostic[],
  pointer: string,
): TokenSet | undefined {
  if (node?.type !== "object") return undefined;
  const sourcesNode = propertyValue(findProperty(node, "sources"));
  const description = optionalString(node, "description");
  const extensionValues = extensions(node);
  return {
    kind: "set",
    name,
    sources: parseSources(sourcesNode, locator, diagnostics, `${pointer}/sources`, "set"),
    source: locator.at(node.offset, node.length),
    ...(description ? { description } : {}),
    ...(extensionValues ? { extensions: extensionValues } : {}),
  };
}

function parseModifier(
  name: string,
  node: Node | undefined,
  locator: Locator,
  diagnostics: Diagnostic[],
  pointer: string,
): ResolverModifier | undefined {
  if (node?.type !== "object") return undefined;
  const contextsNode = propertyValue(findProperty(node, "contexts"));
  const contextProperties = properties(contextsNode);
  if (contextsNode?.type !== "object" || contextProperties.length === 0)
    diagnostics.push({
      code: "DTCG_INVALID_RESOLVER_MODIFIER",
      severity: "error",
      message: `Modifier \`${name}\` must declare at least one context`,
      source: locator.at(node.offset, node.length),
    });
  else if (contextProperties.length === 1)
    diagnostics.push({
      code: "DTCG_RESOLVER_SINGLE_CONTEXT",
      severity: "warning",
      message: `Modifier \`${name}\` should declare at least two contexts`,
      source: locator.at(contextsNode.offset, contextsNode.length),
    });
  const contexts = Object.fromEntries(
    contextProperties.map((property) => {
      const contextName = propertyName(property);
      return [
        contextName,
        parseSources(
          propertyValue(property),
          locator,
          diagnostics,
          `${pointer}/contexts/${contextName}`,
          "modifier",
        ),
      ];
    }),
  );
  const defaultValue = optionalString(node, "default");
  if (defaultValue !== undefined && !(defaultValue in contexts))
    diagnostics.push({
      code: "DTCG_INVALID_RESOLVER_DEFAULT",
      severity: "error",
      message: `Modifier \`${name}\` default \`${defaultValue}\` is not a declared context`,
      source: locator.at(node.offset, node.length),
      suggestions: Object.keys(contexts),
    });
  const description = optionalString(node, "description");
  const extensionValues = extensions(node);
  return {
    kind: "modifier",
    name,
    contexts,
    source: locator.at(node.offset, node.length),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(description ? { description } : {}),
    ...(extensionValues ? { extensions: extensionValues } : {}),
  };
}

function decodePointerName(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Parse one DTCG 2025.10 resolver document without performing file-system IO. */
export function parseResolverDocument(content: string, source: string): ParsedResolverDocument {
  const locator = new Locator(content, source);
  const parseErrors: ParseError[] = [];
  const root = parseTree(content, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  const diagnostics: Diagnostic[] = parseErrors.map((error) => ({
    code: "DTCG_INVALID_RESOLVER_DOCUMENT",
    severity: "error",
    message: printParseErrorCode(error.error),
    source: locator.at(error.offset, error.length),
  }));
  if (!root || root.type !== "object" || parseErrors.length > 0) return { diagnostics };

  const allowedRootProperties = new Set([
    "$schema",
    "$defs",
    "name",
    "version",
    "description",
    "sets",
    "modifiers",
    "resolutionOrder",
  ]);
  for (const property of properties(root)) {
    const name = propertyName(property);
    if (!allowedRootProperties.has(name))
      diagnostics.push({
        code: "DTCG_INVALID_RESOLVER_DOCUMENT",
        severity: "error",
        message: `Unknown resolver property \`${name}\``,
        source: locator.at(property.offset, property.length),
      });
  }
  for (const name of ["name", "description"]) {
    const property = findProperty(root, name);
    if (property && typeof propertyValue(property)?.value !== "string")
      diagnostics.push({
        code: "DTCG_INVALID_RESOLVER_DOCUMENT",
        severity: "error",
        message: `Resolver \`${name}\` must be a string`,
        source: locator.at(property.offset, property.length),
      });
  }

  const version = optionalString(root, "version");
  if (version !== "2025.10")
    diagnostics.push({
      code: "DTCG_INVALID_RESOLVER_VERSION",
      severity: "error",
      message: "Resolver document version must be `2025.10`",
      source: locator.at(root.offset, root.length),
    });

  const sets = new Map<string, TokenSet>();
  const setsNode = propertyValue(findProperty(root, "sets"));
  if (setsNode && setsNode.type !== "object")
    diagnostics.push({
      code: "DTCG_INVALID_RESOLVER_DOCUMENT",
      severity: "error",
      message: "Resolver `sets` must be an object",
      source: locator.at(setsNode.offset, setsNode.length),
    });
  for (const property of properties(setsNode)) {
    const name = propertyName(property);
    const set = parseSet(name, propertyValue(property), locator, diagnostics, `sets/${name}`);
    if (set) sets.set(name, set);
  }

  const modifiers = new Map<string, ResolverModifier>();
  const modifiersNode = propertyValue(findProperty(root, "modifiers"));
  if (modifiersNode && modifiersNode.type !== "object")
    diagnostics.push({
      code: "DTCG_INVALID_RESOLVER_DOCUMENT",
      severity: "error",
      message: "Resolver `modifiers` must be an object",
      source: locator.at(modifiersNode.offset, modifiersNode.length),
    });
  for (const property of properties(modifiersNode)) {
    const name = propertyName(property);
    const modifier = parseModifier(
      name,
      propertyValue(property),
      locator,
      diagnostics,
      `modifiers/${name}`,
    );
    if (modifier) modifiers.set(name, modifier);
  }

  const orderNode = propertyValue(findProperty(root, "resolutionOrder"));
  const resolutionOrder: ResolutionOrderItem[] = [];
  const orderNames = new Set<string>();
  if (orderNode?.type !== "array" || (orderNode.children?.length ?? 0) === 0)
    diagnostics.push({
      code: "DTCG_INVALID_RESOLUTION_ORDER",
      severity: "error",
      message: "Resolver document must declare a non-empty resolutionOrder array",
      ...(orderNode ? { source: locator.at(orderNode.offset, orderNode.length) } : {}),
    });
  for (const [index, child] of (orderNode?.children ?? []).entries()) {
    const reference = optionalString(child, "$ref");
    let item: ResolutionOrderItem | undefined;
    if (
      reference !== undefined &&
      properties(child).some((property) => propertyName(property) !== "$ref")
    )
      diagnostics.push({
        code: "DTCG_UNSUPPORTED_RESOLVER_REFERENCE_OVERRIDE",
        severity: "error",
        message: "Resolver reference-object sibling overrides are not supported in this release",
        source: locator.at(child.offset, child.length),
      });
    if (reference?.startsWith("#/sets/"))
      item = sets.get(decodePointerName(reference.slice("#/sets/".length)));
    else if (reference?.startsWith("#/modifiers/"))
      item = modifiers.get(decodePointerName(reference.slice("#/modifiers/".length)));
    else if (reference !== undefined)
      diagnostics.push({
        code: "DTCG_INVALID_RESOLUTION_ORDER",
        severity: "error",
        message: `Resolution order reference \`${reference}\` must target a set or modifier`,
        source: locator.at(child.offset, child.length),
      });
    else {
      const name = optionalString(child, "name");
      const type = optionalString(child, "type");
      if (name && type === "set")
        item = parseSet(name, child, locator, diagnostics, `resolutionOrder/${index}`);
      else if (name && type === "modifier")
        item = parseModifier(name, child, locator, diagnostics, `resolutionOrder/${index}`);
      else
        diagnostics.push({
          code: "DTCG_INVALID_RESOLUTION_ORDER",
          severity: "error",
          message: "Inline resolution items require a unique name and type of `set` or `modifier`",
          source: locator.at(child.offset, child.length),
        });
    }
    if (!item) {
      if (reference)
        diagnostics.push({
          code: reference.includes("/modifiers/") ? "DTCG_UNKNOWN_MODIFIER" : "DTCG_UNKNOWN_SET",
          severity: "error",
          message: `Unknown resolution order target \`${reference}\``,
          source: locator.at(child.offset, child.length),
        });
      continue;
    }
    if (orderNames.has(item.name))
      diagnostics.push({
        code: "DTCG_INVALID_RESOLUTION_ORDER",
        severity: "error",
        message: `Duplicate resolution order name \`${item.name}\``,
        source: item.source,
      });
    else {
      orderNames.add(item.name);
      resolutionOrder.push(item);
    }
  }

  const documentName = optionalString(root, "name");
  const documentDescription = optionalString(root, "description");
  const document: ResolverDocument = {
    source,
    content,
    version: "2025.10",
    sets,
    modifiers,
    resolutionOrder,
    ...(documentName ? { name: documentName } : {}),
    ...(documentDescription ? { description: documentDescription } : {}),
  };
  return { document, diagnostics };
}

function sourceFile(document: ResolverDocument, reference: string): string | undefined {
  if (/^[a-z][a-z+.-]*:/iu.test(reference)) return undefined;
  const filePart = reference.split("#", 1)[0];
  if (!filePart) return undefined;
  return isAbsolute(filePart) ? filePart : resolve(dirname(document.source), filePart);
}

/** Resolve one modifier input into the ordered token source stream defined by DTCG. */
export function resolveResolverDocument(
  document: ResolverDocument,
  availableSources: readonly TokenSourceInput[],
  input: CompilationContext = {},
): ResolverResolution {
  const diagnostics: Diagnostic[] = [];
  const normalizedInput = new Map(
    Object.entries(input).map(([name, value]) => [name.toLocaleLowerCase(), value]),
  );
  const context: Record<string, string> = {};
  const contexts: Record<string, { default: string; values: readonly string[] }> = {};
  const sourceIndex = new Map(availableSources.map((item) => [resolve(item.file), item]));
  const output: TokenSourceInput[] = [];
  const steps: ResolverResolutionStep[] = [];
  const modifiers = [
    ...new Set([
      ...document.modifiers.values(),
      ...document.resolutionOrder.filter(
        (item): item is ResolverModifier => item.kind === "modifier",
      ),
    ]),
  ];
  const selectedContexts = new Map<ResolverModifier, string>();

  for (const [inputName] of Object.entries(input)) {
    if (
      !modifiers.some(
        (modifier) => modifier.name.toLocaleLowerCase() === inputName.toLocaleLowerCase(),
      )
    )
      diagnostics.push({
        code: "DTCG_UNKNOWN_MODIFIER",
        severity: "error",
        message: `Unknown resolver modifier input \`${inputName}\``,
      });
  }
  for (const modifier of modifiers) {
    const values = Object.keys(modifier.contexts);
    const requested = normalizedInput.get(modifier.name.toLocaleLowerCase());
    const selected =
      requested === undefined
        ? modifier.default
        : values.find((value) => value.toLocaleLowerCase() === requested.toLocaleLowerCase());
    if (!selected) {
      diagnostics.push({
        code:
          requested === undefined ? "DTCG_RESOLVER_MISSING_INPUT" : "DTCG_INVALID_RESOLVER_INPUT",
        severity: "error",
        message:
          requested === undefined
            ? `Modifier \`${modifier.name}\` requires an input`
            : `Invalid context \`${requested}\` for modifier \`${modifier.name}\``,
        source: modifier.source,
        suggestions: values,
      });
      continue;
    }
    selectedContexts.set(modifier, selected);
    context[modifier.name] = selected;
    contexts[modifier.name] = { default: selected, values };
  }

  const expand = (
    sources: readonly ResolutionSource[],
    activeSets: ReadonlySet<string>,
  ): SourceLocation[] =>
    sources.flatMap((source) => {
      if (source.kind === "inline") {
        output.push({
          file: source.file,
          content: source.content,
          origin: source.source,
        });
        return [source.source];
      }
      if (source.ref.startsWith("#/sets/")) {
        const name = decodePointerName(source.ref.slice("#/sets/".length));
        const set = document.sets.get(name);
        if (!set) {
          diagnostics.push({
            code: "DTCG_UNKNOWN_SET",
            severity: "error",
            message: `Unknown resolver set \`${name}\``,
            source: source.source,
          });
          return [];
        }
        if (activeSets.has(name)) {
          diagnostics.push({
            code: "DTCG_RESOLVER_CIRCULAR_REFERENCE",
            severity: "error",
            message: `Circular resolver set reference involving \`${name}\``,
            source: source.source,
          });
          return [];
        }
        return expand(set.sources, new Set(activeSets).add(name));
      }
      if (source.ref.includes("#")) {
        diagnostics.push({
          code: "DTCG_UNSUPPORTED_RESOLVER_REFERENCE",
          severity: "error",
          message: `External JSON Pointer references are not yet supported: \`${source.ref}\``,
          source: source.source,
        });
        return [];
      }
      const file = sourceFile(document, source.ref);
      const loaded = file ? sourceIndex.get(resolve(file)) : undefined;
      if (!loaded) {
        diagnostics.push({
          code: "DTCG_RESOLVER_SOURCE_NOT_FOUND",
          severity: "error",
          message: `Resolver source not found: \`${source.ref}\``,
          source: source.source,
        });
        return [];
      }
      output.push(loaded);
      return [source.source];
    });

  for (const item of document.resolutionOrder) {
    if (item.kind === "set") {
      const sourceLocations = expand(item.sources, new Set([item.name]));
      steps.push({
        kind: "set",
        name: item.name,
        sources: sourceLocations,
        source: item.source,
      });
      continue;
    }
    const selected = selectedContexts.get(item);
    if (!selected) continue;
    const sourceLocations = expand(item.contexts[selected] ?? [], new Set());
    steps.push({
      kind: "modifier",
      name: item.name,
      context: selected,
      sources: sourceLocations,
      source: item.source,
    });
  }

  return { sources: output, context, contexts, steps, diagnostics };
}

/** Return external source paths so IO layers can load them before semantic resolution. */
export function resolverSourceFiles(document: ResolverDocument): readonly string[] {
  const references = [
    ...[...document.sets.values()].flatMap((set) => set.sources),
    ...[...document.modifiers.values()].flatMap((modifier) =>
      Object.values(modifier.contexts).flat(),
    ),
    ...document.resolutionOrder.flatMap((item) =>
      item.kind === "set" ? item.sources : Object.values(item.contexts).flat(),
    ),
  ];
  return [
    ...new Set(
      references.flatMap((source) => {
        if (source.kind !== "reference" || source.ref.startsWith("#")) return [];
        const file = sourceFile(document, source.ref);
        return file ? [file] : [];
      }),
    ),
  ];
}
