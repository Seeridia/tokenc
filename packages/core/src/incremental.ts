import { performance } from "node:perf_hooks";

import {
  compileParsedDocuments,
  type CompilationResult,
  type CompileDocumentsOptions,
} from "./compiler.js";
import { TokenGraph } from "./graph.js";
import type { TokenSourceInput } from "./loader.js";
import type { ParsedTokenDocument, TokenId, TokenNode } from "./model.js";
import { parseTokenDocument } from "./parser.js";

export interface IncrementalUpdate {
  readonly changed: readonly TokenId[];
  readonly affected: ReadonlySet<TokenId>;
  readonly recomputed: number;
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
    overrides: token.overrides.map((override) => ({
      selector: override.selector,
      expression:
        override.expression.kind === "reference"
          ? { kind: override.expression.kind, target: override.expression.target }
          : override.expression,
    })),
  });
}

function changedIds(
  previous: ParsedTokenDocument | undefined,
  next: ParsedTokenDocument | undefined,
): readonly TokenId[] {
  const before = new Map(
    (previous?.tokens ?? []).map((token) => [token.id, semanticSignature(token)]),
  );
  const after = new Map((next?.tokens ?? []).map((token) => [token.id, semanticSignature(token)]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => before.get(id) !== after.get(id),
  );
}

/** Stateful compilation session that reparses only changed documents. */
export class IncrementalCompiler {
  readonly #documents = new Map<string, ParsedTokenDocument>();
  readonly #options: CompileDocumentsOptions;
  #lastResult: CompilationResult | undefined;

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
    for (const source of sources)
      this.#documents.set(source.file, parseTokenDocument(source.content, source.file));
    const changed = [...this.#documents.values()].flatMap((document) =>
      document.tokens.map((token) => token.id),
    );
    const affected = new Set(changed);
    const result = await compileParsedDocuments(
      [...this.#documents.values()],
      { ...this.#options, affectedTokens: affected },
      performance.now() - start,
      start,
    );
    this.#lastResult = result;
    return { changed, affected, recomputed: result.compilation.resolver.computations, result };
  }

  async update(source: TokenSourceInput): Promise<IncrementalUpdate> {
    const start = performance.now();
    const previousDocument = this.#documents.get(source.file);
    const nextDocument = parseTokenDocument(source.content, source.file);
    const changed = changedIds(previousDocument, nextDocument);
    const oldGraph = this.#lastResult?.graph ?? new TokenGraph(previousDocument?.tokens);
    this.#documents.set(source.file, nextDocument);
    return this.#rebuild(changed, oldGraph, performance.now() - start, start);
  }

  async remove(file: string): Promise<IncrementalUpdate> {
    const start = performance.now();
    const previous = this.#documents.get(file);
    const changed = changedIds(previous, undefined);
    const oldGraph = this.#lastResult?.graph ?? new TokenGraph(previous?.tokens);
    this.#documents.delete(file);
    return this.#rebuild(changed, oldGraph, 0, start);
  }

  async #rebuild(
    changed: readonly TokenId[],
    oldGraph: TokenGraph,
    parseTime: number,
    totalStart: number,
  ): Promise<IncrementalUpdate> {
    const nextGraph = new TokenGraph(
      [...this.#documents.values()].flatMap((document) => document.tokens),
    );
    const affected = new Set([
      ...oldGraph.getAffectedTokens(changed),
      ...nextGraph.getAffectedTokens(changed),
    ]);
    const seed = (this.#lastResult?.compilation.resolver.snapshot() ?? []).filter(
      (resolved) => !affected.has(resolved.id) && nextGraph.hasToken(resolved.id),
    );
    const result = await compileParsedDocuments(
      [...this.#documents.values()],
      {
        ...this.#options,
        affectedTokens: affected,
        resolverSeed: seed,
      },
      parseTime,
      totalStart,
    );
    this.#lastResult = result;
    return { changed, affected, recomputed: result.compilation.resolver.computations, result };
  }
}
