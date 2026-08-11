import { performance } from "node:perf_hooks";

import {
  compileParsedDocuments,
  type CompilationResult,
  type CompileDocumentsOptions,
} from "./compiler.js";
import {
  linkTokenDocuments,
  parseUnresolvedTokenDocument,
  type UnresolvedTokenDocument,
} from "./frontend.js";
import { TokenGraph, type TokenGraphDelta } from "./graph.js";
import type { TokenSourceInput } from "./loader.js";
import type { Diagnostic, ParsedTokenDocument, TokenId, TokenNode } from "./model.js";

export interface IncrementalUpdate {
  readonly changed: readonly TokenId[];
  readonly affected: ReadonlySet<TokenId>;
  readonly recomputed: number;
  readonly graphDelta: TokenGraphDelta;
  readonly result: CompilationResult;
}

function semanticExpression(value: TokenNode["value"]): object {
  return value.kind === "reference"
    ? { kind: value.kind, target: value.target, pointer: value.pointer }
    : value.kind === "json-pointer-reference"
      ? {
          kind: value.kind,
          target: value.target,
          pointer: value.pointer,
          value: value.value,
        }
      : value;
}

function semanticSignature(token: TokenNode): string {
  return JSON.stringify({
    type: token.type,
    value: semanticExpression(token.value),
    description: token.description,
    deprecated: token.deprecated,
    extensions: token.extensions,
    overrides: token.overrides.map((override) => ({
      selector: override.selector,
      expression: semanticExpression(override.expression),
    })),
    dependencies: token.dependencies,
    propertyReferences: token.propertyReferences?.map((reference) => ({
      pointer: reference.pointer,
      target: reference.target,
    })),
    inheritance: token.inheritance
      ? { token: token.inheritance.token, group: token.inheritance.group }
      : undefined,
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
  readonly #syntaxDocuments = new Map<string, UnresolvedTokenDocument>();
  readonly #documents = new Map<string, ParsedTokenDocument>();
  readonly #options: CompileDocumentsOptions;
  #lastResult: CompilationResult | undefined;
  #graph = new TokenGraph();
  readonly #owners = new Map<TokenId, Map<string, readonly TokenNode[]>>();

  constructor(options: CompileDocumentsOptions = {}) {
    this.#options = options;
  }

  get files(): readonly string[] {
    return [...this.#syntaxDocuments.keys()];
  }
  get result(): CompilationResult | undefined {
    return this.#lastResult;
  }

  async initialize(sources: readonly TokenSourceInput[]): Promise<IncrementalUpdate> {
    const start = performance.now();
    this.#syntaxDocuments.clear();
    this.#documents.clear();
    this.#owners.clear();
    for (const source of sources)
      this.#syntaxDocuments.set(
        source.file,
        parseUnresolvedTokenDocument(
          source.content,
          source.file,
          source.origin ? { origin: source.origin } : {},
        ),
      );
    const linked = linkTokenDocuments([...this.#syntaxDocuments.values()]);
    for (const [index, file] of [...this.#syntaxDocuments.keys()].entries()) {
      const document = linked[index];
      if (document) this.#documents.set(file, document);
    }
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
    const previousDocuments = new Map(this.#documents);
    const nextSyntaxDocument = parseUnresolvedTokenDocument(
      source.content,
      source.file,
      source.origin ? { origin: source.origin } : {},
    );
    this.#syntaxDocuments.set(source.file, nextSyntaxDocument);
    this.#relink();
    const changed = this.#changedIds(previousDocuments);
    this.#rebuildOwners();
    const delta = this.#patchGraph(changed);
    return this.#rebuild(changed, delta, performance.now() - start, start);
  }

  async remove(file: string): Promise<IncrementalUpdate> {
    const start = performance.now();
    const previousDocuments = new Map(this.#documents);
    this.#syntaxDocuments.delete(file);
    this.#relink();
    const changed = this.#changedIds(previousDocuments);
    this.#rebuildOwners();
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

  #relink(): void {
    const files = [...this.#syntaxDocuments.keys()];
    const linked = linkTokenDocuments([...this.#syntaxDocuments.values()]);
    this.#documents.clear();
    for (const [index, file] of files.entries()) {
      const document = linked[index];
      if (document) this.#documents.set(file, document);
    }
  }

  #changedIds(previous: ReadonlyMap<string, ParsedTokenDocument>): readonly TokenId[] {
    const files = new Set([...previous.keys(), ...this.#documents.keys()]);
    return [
      ...new Set(
        [...files].flatMap((file) => changedIds(previous.get(file), this.#documents.get(file))),
      ),
    ];
  }

  #rebuildOwners(): void {
    this.#owners.clear();
    for (const [file, document] of this.#documents)
      for (const token of document.tokens) this.#addOwner(file, token);
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
