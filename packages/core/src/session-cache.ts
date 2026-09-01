import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { TokenBackend } from "./backend.js";
import {
  compileParsedDocuments,
  createImmutableTokenGraph,
  type CompilationBuildResult,
  type CompileDocumentsOptions,
} from "./compiler.js";
import { contextKey, selectTokenCandidate } from "./context.js";
import { resolveResolverDocument } from "./dtcg/resolver-document.js";
import {
  linkTokenDocuments,
  parseUnresolvedTokenDocument,
  partitionTokenDocumentLinkComponents,
  type UnresolvedTokenDocument,
} from "./frontend.js";
import type { TokenGraph } from "./graph.js";
import type { TokenSourceInput } from "./loader.js";
import type {
  ContextDefinition,
  ParsedTokenDocument,
  ResolvedToken,
  TokenExpression,
  TokenId,
  TokenNode,
} from "./model.js";
import { trueContextPredicate } from "./predicate.js";

const PARSER_VERSION = "dtcg-2025.10-v1";

export type SessionInvalidationReason =
  | "cache-disabled"
  | "cold"
  | "component-changed"
  | "content-changed"
  | "context-changed"
  | "document-added"
  | "document-removed"
  | "graph-changed"
  | "linked-document-changed";

export interface SessionStageMetrics {
  readonly enabled: boolean;
  readonly hits: number;
  readonly misses: number;
  readonly reused: number;
  readonly recomputed: number;
  readonly invalidations: readonly SessionInvalidationReason[];
}

export interface SessionMetrics {
  readonly revision: number;
  readonly documents: number;
  readonly changedTokens: number;
  readonly affectedTokens: number;
  readonly stages: Readonly<{
    parse: SessionStageMetrics;
    link: SessionStageMetrics;
    graph: SessionStageMetrics;
    resolve: SessionStageMetrics;
    backendPlan: SessionStageMetrics;
  }>;
}

interface CachedCompilationOptions extends CompileDocumentsOptions {
  readonly backends?: readonly TokenBackend[];
}

interface ParseCacheEntry {
  readonly key: string;
  readonly document: UnresolvedTokenDocument;
}

interface LinkCacheEntry {
  readonly documents: readonly ParsedTokenDocument[];
}

interface CacheState {
  readonly parse: ReadonlyMap<string, ParseCacheEntry>;
  readonly link: ReadonlyMap<string, LinkCacheEntry>;
  readonly linkedDocuments: readonly ParsedTokenDocument[];
  readonly graphKey?: string;
  readonly build?: CompilationBuildResult;
  readonly contextsKey?: string;
}

interface PreparedCompilation {
  readonly build: CompilationBuildResult;
  readonly metrics: Omit<SessionMetrics, "revision">;
  commit(): void;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function stage(
  hits: number,
  misses: number,
  reused: number,
  recomputed: number,
  invalidations: readonly SessionInvalidationReason[],
  enabled = true,
): SessionStageMetrics {
  return Object.freeze({
    enabled,
    hits,
    misses,
    reused,
    recomputed,
    invalidations: Object.freeze([...new Set(invalidations)]),
  });
}

function expressionSignature(expression: TokenExpression): unknown {
  if (expression.kind === "literal") return expression;
  if (expression.kind === "reference")
    return { kind: expression.kind, target: expression.target, pointer: expression.pointer };
  return {
    kind: expression.kind,
    target: expression.target,
    pointer: expression.pointer,
    value: expression.value,
  };
}

function semanticSignature(token: TokenNode): string {
  return stableJson({
    type: token.type,
    value: expressionSignature(token.value),
    description: token.description,
    deprecated: token.deprecated,
    extensions: token.extensions,
    overrides: token.overrides.map((override) => ({
      selector: override.selector,
      expression: expressionSignature(override.expression),
      precedence: override.precedence,
      origin: override.origin,
    })),
    dependencies: token.dependencyOccurrences.map((occurrence) => ({
      candidate: occurrence.candidate,
      target: occurrence.target,
      kind: occurrence.kind,
      fieldPath: occurrence.fieldPath,
      sourceOrder: occurrence.sourceOrder,
    })),
    inheritance: token.inheritance
      ? { token: token.inheritance.token, group: token.inheritance.group }
      : undefined,
  });
}

function tokenSignatures(
  documents: readonly ParsedTokenDocument[],
): Map<TokenId, readonly string[]> {
  const result = new Map<TokenId, string[]>();
  for (const document of documents)
    for (const token of document.tokens) {
      const signatures = result.get(token.id) ?? [];
      signatures.push(semanticSignature(token));
      result.set(token.id, signatures);
    }
  return result;
}

function changedTokenIds(
  previous: readonly ParsedTokenDocument[],
  next: readonly ParsedTokenDocument[],
): readonly TokenId[] {
  const before = tokenSignatures(previous);
  const after = tokenSignatures(next);
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => stableJson(before.get(id)) !== stableJson(after.get(id)),
  );
}

function allTokenIds(previous: TokenGraph | undefined, next: TokenGraph): readonly TokenId[] {
  return [
    ...new Set([
      ...(previous?.tokens.map((token) => token.id) ?? []),
      ...next.tokens.map((token) => token.id),
    ]),
  ];
}

function affectedTokenIds(
  previous: TokenGraph | undefined,
  next: TokenGraph,
  changed: readonly TokenId[],
  invalidateAll: boolean,
): ReadonlySet<TokenId> {
  if (!previous || invalidateAll) return new Set(allTokenIds(previous, next));
  const affected = new Set<TokenId>(changed);
  const previousRoots = new Map(
    changed.map((id) => [id, trueContextPredicate(previous.domain)] as const),
  );
  const nextRoots = new Map(changed.map((id) => [id, trueContextPredicate(next.domain)] as const));
  for (const id of previous.getAffected(previousRoots).keys()) affected.add(id);
  for (const id of next.getAffected(nextRoots).keys()) affected.add(id);
  return affected;
}

function selectedResolutionSignature(
  graph: TokenGraph,
  id: TokenId,
  context: Readonly<Record<string, string>>,
  resolutionOrder: readonly string[],
): string {
  const token = graph.getToken(id);
  if (!token) return "missing";
  const selected = selectTokenCandidate(token, context, resolutionOrder);
  return stableJson({
    type: token.type,
    expression: expressionSignature(selected.expression),
    dependencies: selected.dependencyOccurrences.map((occurrence) => ({
      target: occurrence.target,
      kind: occurrence.kind,
      fieldPath: occurrence.fieldPath,
    })),
  });
}

function affectedInContext(
  previous: TokenGraph,
  next: TokenGraph,
  changed: readonly TokenId[],
  context: Readonly<Record<string, string>>,
  resolutionOrder: readonly string[],
): ReadonlySet<TokenId> {
  const affected = new Set(
    changed.filter(
      (id) =>
        selectedResolutionSignature(previous, id, context, resolutionOrder) !==
        selectedResolutionSignature(next, id, context, resolutionOrder),
    ),
  );
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (!id) continue;
    const incoming = [
      ...previous.getIncomingEdges(id, { context }),
      ...next.getIncomingEdges(id, { context }),
    ];
    for (const edge of incoming) {
      if (affected.has(edge.from)) continue;
      affected.add(edge.from);
      queue.push(edge.from);
    }
  }
  return affected;
}

interface ResolverReusePlan {
  readonly seed: readonly ResolvedToken[];
  readonly recompute: readonly ResolvedToken[];
}

function resolverReusePlan(
  build: CompilationBuildResult | undefined,
  previousGraph: TokenGraph | undefined,
  graph: TokenGraph,
  changed: readonly TokenId[],
  contexts: ContextDefinition,
  contextsChanged: boolean,
): ResolverReusePlan {
  if (!build?.success || !previousGraph || contextsChanged) return { seed: [], recompute: [] };
  const resolutionOrder = Object.keys(contexts);
  const affectedContexts = new Map<string, ReadonlySet<TokenId>>();
  const seed: ResolvedToken[] = [];
  const recompute: ResolvedToken[] = [];
  for (const resolved of build.compilation.resolver.snapshot()) {
    const key = contextKey(resolved.context);
    let affected = affectedContexts.get(key);
    if (!affected) {
      affected = affectedInContext(
        previousGraph,
        graph,
        changed,
        resolved.context,
        resolutionOrder,
      );
      affectedContexts.set(key, affected);
    }
    if (affected.has(resolved.id)) {
      recompute.push(resolved);
      continue;
    }
    const token = graph.getToken(resolved.id);
    if (!token) continue;
    const selected = selectTokenCandidate(token, resolved.context, resolutionOrder);
    seed.push({
      ...resolved,
      type: token.type,
      expression: selected.expression,
      dependencies: [
        ...new Set(selected.dependencyOccurrences.map((occurrence) => occurrence.target)),
      ],
      source: token.source,
    });
  }
  return { seed, recompute };
}

function sourceKey(source: TokenSourceInput): string {
  return digest({
    parser: PARSER_VERSION,
    identity: source.file,
    content: source.content,
    origin: source.origin ?? null,
  });
}

/** @internal Transactional stage caches owned by one CompilerSession. */
export class SessionCompilationCache {
  #state: CacheState = {
    parse: new Map(),
    link: new Map(),
    linkedDocuments: [],
  };

  async prepare(
    sources: readonly TokenSourceInput[],
    options: CachedCompilationOptions,
  ): Promise<PreparedCompilation> {
    const totalStart = performance.now();
    const { backends: _backends, ...compilationOptions } = options;
    const resolverStart = performance.now();
    const resolution = compilationOptions.resolver
      ? resolveResolverDocument(
          compilationOptions.resolver,
          sources,
          compilationOptions.resolverInput,
        )
      : undefined;
    const effectiveSources = resolution?.sources ?? sources;
    const resolverLinkTime = performance.now() - resolverStart;

    const parseStart = performance.now();
    const nextParse = new Map<string, ParseCacheEntry>();
    const syntaxDocuments: UnresolvedTokenDocument[] = [];
    const parseKeys = new Map<UnresolvedTokenDocument, string>();
    let parseHits = 0;
    let parseMisses = 0;
    for (const source of effectiveSources) {
      const key = sourceKey(source);
      const cached = this.#state.parse.get(source.file);
      const document =
        cached?.key === key
          ? cached.document
          : parseUnresolvedTokenDocument(
              source.content,
              source.file,
              source.origin ? { origin: source.origin } : {},
            );
      if (cached?.key === key) parseHits += 1;
      else parseMisses += 1;
      const entry = { key, document };
      nextParse.set(source.file, entry);
      syntaxDocuments.push(document);
      parseKeys.set(document, key);
    }
    const parseTime = performance.now() - parseStart;
    const previousIdentities = new Set(this.#state.parse.keys());
    const nextIdentities = new Set(nextParse.keys());
    const addedDocuments = [...nextIdentities].filter(
      (identity) => !previousIdentities.has(identity),
    ).length;
    const removedDocuments = [...previousIdentities].filter(
      (identity) => !nextIdentities.has(identity),
    ).length;
    const changedDocuments = [...nextParse].filter(([identity, entry]) => {
      const previous = this.#state.parse.get(identity);
      return previous !== undefined && previous.key !== entry.key;
    }).length;

    const linkStart = performance.now();
    const components = partitionTokenDocumentLinkComponents(syntaxDocuments);
    const nextLink = new Map<string, LinkCacheEntry>();
    const linkedBySyntax = new Map<UnresolvedTokenDocument, ParsedTokenDocument>();
    let linkHits = 0;
    let linkMisses = 0;
    let linkedReused = 0;
    let linkedRecomputed = 0;
    const componentKeys: string[] = [];
    for (const component of components) {
      const key = digest(component.map((document) => parseKeys.get(document)));
      componentKeys.push(key);
      const cached = this.#state.link.get(key);
      const linked = cached?.documents ?? linkTokenDocuments(component);
      if (cached) {
        linkHits += 1;
        linkedReused += component.length;
      } else {
        linkMisses += 1;
        linkedRecomputed += component.length;
      }
      nextLink.set(key, { documents: linked });
      for (const [index, document] of component.entries()) {
        const parsed = linked[index];
        if (parsed) linkedBySyntax.set(document, parsed);
      }
    }
    const linkedDocuments = syntaxDocuments.flatMap(
      (document) => linkedBySyntax.get(document) ?? [],
    );
    const linkTime = resolverLinkTime + performance.now() - linkStart;

    const contexts = resolution
      ? { ...resolution.contexts, ...compilationOptions.contexts }
      : (compilationOptions.contexts ?? {});
    const contextsKey = digest(contexts);
    const graphKey = digest({ components: componentKeys, contexts });
    const graphHit = this.#state.graphKey === graphKey && this.#state.build !== undefined;
    const previousGraph = this.#state.build?.graph;
    let changed = changedTokenIds(this.#state.linkedDocuments, linkedDocuments);
    const contextsChanged =
      this.#state.contextsKey !== undefined && this.#state.contextsKey !== contextsKey;
    const graphStart = performance.now();
    const graph = graphHit
      ? this.#state.build!.graph
      : createImmutableTokenGraph(linkedDocuments, contexts);
    const graphTime = performance.now() - graphStart;
    if (contextsChanged) changed = allTokenIds(previousGraph, graph);

    const effectiveOptions = {
      ...compilationOptions,
      ...(resolution
        ? {
            resolution,
            contexts,
            allowTokenOverrides: true,
          }
        : {}),
    };
    const affected = affectedTokenIds(previousGraph, graph, changed, contextsChanged);
    const resolverPlan = resolverReusePlan(
      this.#state.build,
      previousGraph,
      graph,
      changed,
      contexts,
      contextsChanged,
    );
    const unadjustedBuild = await compileParsedDocuments(
      linkedDocuments,
      {
        ...effectiveOptions,
        linkedDocuments: true,
        graph,
        ...(resolverPlan.seed.length > 0 ? { resolverSeed: resolverPlan.seed } : {}),
        ...(this.#state.build?.success ? { checkTokens: affected, affectedTokens: affected } : {}),
      },
      parseTime,
      totalStart,
      { link: linkTime, graph: graphTime },
    );
    const recomputeStart = performance.now();
    for (const entry of resolverPlan.recompute)
      if (graph.hasToken(entry.id))
        unadjustedBuild.compilation.resolver.resolve(entry.id, entry.context);
    const extraResolveTime = performance.now() - recomputeStart;
    const build: CompilationBuildResult = {
      ...unadjustedBuild,
      stats: {
        ...unadjustedBuild.stats,
        timings: {
          ...unadjustedBuild.stats.timings,
          resolve: unadjustedBuild.stats.timings.resolve + Math.max(0, extraResolveTime),
          total: performance.now() - totalStart,
        },
      },
    };

    const documentInvalidations: SessionInvalidationReason[] = this.#state.build
      ? [
          ...(addedDocuments > 0 ? (["document-added"] as const) : []),
          ...(changedDocuments > 0 ? (["content-changed"] as const) : []),
          ...(removedDocuments > 0 ? (["document-removed"] as const) : []),
        ]
      : ["cold"];
    const graphTokens = build.graph.size;
    const resolveRecomputed = build.compilation.resolver.computations;
    const metrics: Omit<SessionMetrics, "revision"> = Object.freeze({
      documents: effectiveSources.length,
      changedTokens: changed.length,
      affectedTokens: affected.size,
      stages: Object.freeze({
        parse: stage(
          parseHits,
          parseMisses,
          parseHits,
          parseMisses,
          parseMisses > 0 || removedDocuments > 0 ? documentInvalidations : [],
        ),
        link: stage(
          linkHits,
          linkMisses,
          linkedReused,
          linkedRecomputed,
          linkMisses > 0 || removedDocuments > 0
            ? [this.#state.build ? "component-changed" : "cold"]
            : [],
        ),
        graph: stage(
          Number(graphHit),
          Number(!graphHit),
          graphHit ? graphTokens : 0,
          graphHit ? 0 : graphTokens,
          graphHit ? [] : [contextsChanged ? "context-changed" : "linked-document-changed"],
        ),
        resolve: stage(
          resolverPlan.seed.length,
          resolveRecomputed,
          resolverPlan.seed.length,
          resolveRecomputed,
          affected.size > 0 ? [contextsChanged ? "context-changed" : "graph-changed"] : [],
        ),
        backendPlan: stage(0, 0, 0, 0, ["cache-disabled"], false),
      }),
    });
    const nextState: CacheState = {
      parse: nextParse,
      link: nextLink,
      linkedDocuments,
      graphKey,
      build,
      contextsKey,
    };
    return {
      build,
      metrics,
      commit: () => {
        this.#state = nextState;
      },
    };
  }
}

export function publishSessionMetrics(
  metrics: Omit<SessionMetrics, "revision">,
  revision: number,
): SessionMetrics {
  return Object.freeze({ ...metrics, revision });
}
