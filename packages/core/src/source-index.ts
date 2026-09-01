import type { TokenGraph } from "./graph.js";
import type { ParsedTokenDocument, SourceLocation, TokenId } from "./model.js";
import type { ContextPredicate } from "./predicate.js";

export type EditorSymbolRole = "declaration" | "alias" | "json-pointer" | "inheritance";

/** Transport-neutral declaration or reference occurrence owned by one Snapshot revision. */
export interface EditorSymbolV1 {
  readonly schemaVersion: "1";
  readonly role: EditorSymbolRole;
  readonly owner: TokenId;
  readonly target: TokenId;
  readonly source: SourceLocation;
  readonly fieldPath: readonly (string | number)[];
  readonly condition?: ContextPredicate;
}

/** Immutable source facts preserved by the compiler frontend. */
export interface EditorSourceIndex {
  all(document?: string): readonly EditorSymbolV1[];
  at(document: string, offset: number): EditorSymbolV1 | undefined;
  declarations(document?: string): readonly EditorSymbolV1[];
  occurrences(target: TokenId, document?: string): readonly EditorSymbolV1[];
}

const roleOrder: Readonly<Record<EditorSymbolRole, number>> = {
  declaration: 0,
  alias: 1,
  "json-pointer": 2,
  inheritance: 3,
};

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function compareSymbols(left: EditorSymbolV1, right: EditorSymbolV1): number {
  return (
    left.source.file.localeCompare(right.source.file) ||
    left.source.offset - right.source.offset ||
    roleOrder[left.role] - roleOrder[right.role] ||
    String(left.owner).localeCompare(String(right.owner)) ||
    String(left.target).localeCompare(String(right.target))
  );
}

function freezeSymbol(symbol: EditorSymbolV1): EditorSymbolV1 {
  return deepFreeze({
    ...symbol,
    source: { ...symbol.source },
    fieldPath: [...symbol.fieldPath],
    ...(symbol.condition ? { condition: structuredClone(symbol.condition) } : {}),
  });
}

/** @internal Built once from frontend and Graph facts when a Snapshot is published. */
export class InternalEditorSourceIndex implements EditorSourceIndex {
  readonly #symbols: readonly EditorSymbolV1[];

  constructor(documents: readonly ParsedTokenDocument[], graph: TokenGraph) {
    const symbols: EditorSymbolV1[] = documents.flatMap((document) => [
      ...document.declarations.map((declaration) => ({
        schemaVersion: "1" as const,
        role: "declaration" as const,
        owner: declaration.id,
        target: declaration.id,
        source: declaration.source,
        fieldPath: [],
      })),
      ...document.inheritances.map((inheritance) => ({
        schemaVersion: "1" as const,
        role: "inheritance" as const,
        owner: inheritance.owner,
        target: inheritance.target,
        source: inheritance.source,
        fieldPath: ["$extends"],
      })),
    ]);
    for (const edge of graph.edges) {
      if (edge.occurrence.kind === "inheritance") continue;
      const role: EditorSymbolRole =
        edge.occurrence.kind === "composite-field" ? "alias" : edge.occurrence.kind;
      symbols.push({
        schemaVersion: "1",
        role,
        owner: edge.from,
        target: edge.to,
        source: edge.occurrence.source,
        fieldPath: edge.occurrence.fieldPath,
        condition: edge.condition,
      });
    }
    const seen = new Set<string>();
    this.#symbols = Object.freeze(
      symbols
        .toSorted(compareSymbols)
        .filter((symbol) => {
          const key = `${symbol.source.file}\0${symbol.source.offset}\0${symbol.source.length}\0${symbol.role}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(freezeSymbol),
    );
    Object.freeze(this);
  }

  all(document?: string): readonly EditorSymbolV1[] {
    if (document === undefined) return this.#symbols;
    return Object.freeze(this.#symbols.filter((symbol) => symbol.source.file === document));
  }

  at(document: string, offset: number): EditorSymbolV1 | undefined {
    return this.#symbols
      .filter(
        (symbol) =>
          symbol.source.file === document &&
          offset >= symbol.source.offset &&
          offset < symbol.source.offset + symbol.source.length,
      )
      .toSorted(
        (left, right) => left.source.length - right.source.length || compareSymbols(left, right),
      )[0];
  }

  declarations(document?: string): readonly EditorSymbolV1[] {
    return Object.freeze(
      this.#symbols.filter(
        (symbol) =>
          symbol.role === "declaration" &&
          (document === undefined || symbol.source.file === document),
      ),
    );
  }

  occurrences(target: TokenId, document?: string): readonly EditorSymbolV1[] {
    return Object.freeze(
      this.#symbols.filter(
        (symbol) =>
          symbol.role !== "declaration" &&
          symbol.target === target &&
          (document === undefined || symbol.source.file === document),
      ),
    );
  }
}
