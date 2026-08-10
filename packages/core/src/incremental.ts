import { performance } from "node:perf_hooks";

import {
  compileParsedDocuments,
  type CompilationResult,
  type CompileDocumentsOptions,
} from "./compiler.js";
import { TokenGraph, type TokenGraphDelta } from "./graph.js";
import type { TokenSourceInput } from "./loader.js";
import type { Diagnostic, ParsedTokenDocument, TokenId, TokenNode } from "./model.js";
import { parseTokenDocument } from "./parser.js";

export interface IncrementalUpdate {
  readonly changed: readonly TokenId[];
  readonly affected: ReadonlySet<TokenId>;
  readonly recomputed: number;
  readonly graphDelta: TokenGraphDelta;
  readonly result: CompilationResult;
}

function semanticSignature(token: TokenNode): string {
  return JSON.stringify({
    type: token.type,
    value:
      token.value.kind === "reference"
        ? { kind: token.value.kind, target: token.value.target }
        : token.value,
    description: token.description,
    deprecated: token.deprecated,
    extensions: token.extensions,
    overrides: token.overrides.map((override) => ({
      selector: override.selector,
      expression:
        override.expression.kind === "reference"
          ? { kind: override.expression.kind, target: override.expression.target }
          : override.expression,
    })),
  });
}

function documentSignatures(document: ParsedTokenDocument | undefined): Map<TokenId, string[]> {
  const result = new Map<TokenId, string[]>();
  for (const token of document?.tokens ?? [])
    result.set(token.id, [...(result.get(token.id) ?? []), semanticSignature(token)]);
  return result;
}

function changedIds(
  previous: ParsedTokenDocument | undefined,
  next: ParsedTokenDocument | undefined,
): readonly TokenId[] {
  const before = documentSignatures(previous);
  const after = documentSignatures(next);
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)),
  );
}

/** Stateful compilation session that reparses only changed documents. */
export class IncrementalCompiler {
  readonly #documents = new Map<string, ParsedTokenDocument>();
  readonly #options: CompileDocumentsOptions;
  #lastResult: CompilationResult | undefined;
  #graph = new TokenGraph();
  readonly #owners = new Map<TokenId, Map<string, readonly TokenNode[]>>();

  constructor(options: CompileDocumentsOptions = {}) {
    this.#options = options;
  }

  get files(): readonly string[] {
    return [...this.#documents.keys()];
  }
  get result(): CompilationResult | undefined {
    return this.#lastResult;
  }

  async initialize(sources: readonly TokenSourceInput[]): Promise<IncrementalUpdate> {
    const start = performance.now();
    this.#documents.clear();
    this.#owners.clear();
    for (const source of sources)
      this.#documents.set(
        source.file,
        parseTokenDocument(source.content, source.file, {
          ...(this.#options.dialect ? { dialect: this.#options.dialect } : {}),
          ...(source.origin ? { origin: source.origin } : {}),
        }),
      );
    for (const [file, document] of this.#documents)
      for (const token of document.tokens) this.#addOwner(file, token);
    const changed = [...this.#documents.values()].flatMap((document) =>
      document.tokens.map((token) => token.id),
    );
    const affected = new Set(changed);
    this.#graph = new TokenGraph(
      [...this.#documents.values()].flatMap((document) => document.tokens),
    );
    const result = await compileParsedDocuments(
      [...this.#documents.values()],
      { ...this.#options, affectedTokens: affected, graph: this.#graph },
      performance.now() - start,
      start,
    );
    this.#lastResult = result;
    const graphDelta: TokenGraphDelta = {
      added: changed,
      changed: [],
      removed: [],
      affected,
      touchedNodes: changed.length,
      touchedEdges: result.stats.references,
    };
    return {
      changed,
      affected,
      recomputed: result.compilation.resolver.computations,
      graphDelta,
      result,
    };
  }

  async update(source: TokenSourceInput): Promise<IncrementalUpdate> {
    const start = performance.now();
    const previousDocument = this.#documents.get(source.file);
    const nextDocument = parseTokenDocument(source.content, source.file, {
      ...(this.#options.dialect ? { dialect: this.#options.dialect } : {}),
      ...(source.origin ? { origin: source.origin } : {}),
    });
    const changed = changedIds(previousDocument, nextDocument);
    this.#documents.set(source.file, nextDocument);
    this.#replaceOwners(source.file, previousDocument, nextDocument);
    const delta = this.#patchGraph(changed);
    return this.#rebuild(changed, delta, performance.now() - start, start);
  }

  async remove(file: string): Promise<IncrementalUpdate> {
    const start = performance.now();
    const previous = this.#documents.get(file);
    const changed = changedIds(previous, undefined);
    this.#documents.delete(file);
    this.#replaceOwners(file, previous, undefined);
    const delta = this.#patchGraph(changed);
    return this.#rebuild(changed, delta, 0, start);
  }

  #winningToken(id: TokenId): TokenNode | undefined {
    const owners = this.#owners.get(id);
    let winner: TokenNode | undefined;
    for (const file of this.#documents.keys()) winner = owners?.get(file)?.at(-1) ?? winner;
    return winner;
  }

  #addOwner(file: string, token: TokenNode): void {
    const owners = this.#owners.get(token.id) ?? new Map<string, readonly TokenNode[]>();
    owners.set(file, [...(owners.get(file) ?? []), token]);
    this.#owners.set(token.id, owners);
  }

  #replaceOwners(
    file: string,
    previous: ParsedTokenDocument | undefined,
    next: ParsedTokenDocument | undefined,
  ): void {
    for (const token of previous?.tokens ?? []) {
      const owners = this.#owners.get(token.id);
      owners?.delete(file);
      if (owners?.size === 0) this.#owners.delete(token.id);
    }
    for (const token of next?.tokens ?? []) this.#addOwner(file, token);
  }

  #duplicateDiagnostics(ids: readonly TokenId[]): readonly Diagnostic[] {
    return ids.flatMap((id) => {
      const owners = this.#owners.get(id);
      if (!owners || [...owners.values()].reduce((count, tokens) => count + tokens.length, 0) < 2)
        return [];
      const ordered = [...this.#documents.keys()].flatMap((file) => owners.get(file) ?? []);
      const first = ordered[0];
      return first
        ? ordered.slice(1).map((token) => ({
            code: "TOKEN_DUPLICATE_ID",
            severity: "error" as const,
            message: `Duplicate token \`${token.id}\``,
            source: token.source,
            related: [{ message: "First defined here", source: first.source }],
          }))
        : [];
    });
  }

  #patchGraph(tokenIds: readonly TokenId[]): TokenGraphDelta {
    const added: TokenNode[] = [];
    const changed: TokenNode[] = [];
    const removed: TokenId[] = [];
    for (const id of tokenIds) {
      const previous = this.#graph.getToken(id);
      const next = this.#winningToken(id);
      if (!previous && next) added.push(next);
      else if (previous && !next) removed.push(id);
      else if (previous && next && semanticSignature(previous) !== semanticSignature(next))
        changed.push(next);
    }
    return this.#graph.patch({ added, changed, removed });
  }

  async #rebuild(
    changed: readonly TokenId[],
    delta: TokenGraphDelta,
    parseTime: number,
    totalStart: number,
  ): Promise<IncrementalUpdate> {
    const affected = delta.affected;
    const seed = (this.#lastResult?.compilation.resolver.snapshot() ?? []).filter(
      (resolved) => !affected.has(resolved.id) && this.#graph.hasToken(resolved.id),
    );
    const result = await compileParsedDocuments(
      [...this.#documents.values()],
      {
        ...this.#options,
        affectedTokens: affected,
        resolverSeed: seed,
        graph: this.#graph,
        ...(this.#lastResult?.success === false
          ? {}
          : {
              checkTokens: affected,
              skipDuplicateCheck: true,
              additionalDiagnostics: this.#duplicateDiagnostics(changed),
            }),
      },
      parseTime,
      totalStart,
    );
    this.#lastResult = result;
    return {
      changed,
      affected,
      recomputed: result.compilation.resolver.computations,
      graphDelta: delta,
      result,
    };
  }
}
