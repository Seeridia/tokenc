import type { ResolverResolution } from "./dtcg/resolver-document.js";
import type { DependencyEdge, TokenGraph } from "./graph.js";
import type {
  CompilationContext,
  DependencyCandidateId,
  DependencyKind,
  ExplainTraceV1,
  ResolvedToken,
  SourceLocation,
  TokenId,
  TokenNode,
} from "./model.js";
import {
  contextPredicateFromSelector,
  intersectContextPredicates,
  isContextPredicateSatisfiable,
  trueContextPredicate,
  type ContextPredicate,
} from "./predicate.js";
import type { TokenResolver } from "./resolver.js";

export type QueryRegion =
  | { readonly context: CompilationContext; readonly predicate?: never }
  | { readonly predicate: ContextPredicate; readonly context?: never }
  | { readonly context?: never; readonly predicate?: never };

export interface QueryEdgeV1 {
  readonly schemaVersion: "1";
  readonly from: TokenId;
  readonly to: TokenId;
  readonly candidate: DependencyCandidateId;
  readonly kind: DependencyKind;
  readonly fieldPath: readonly (string | number)[];
  readonly source: SourceLocation;
  readonly condition: ContextPredicate;
}

export interface ImpactedTokenV1 {
  readonly token: TokenId;
  readonly condition: ContextPredicate;
}

export interface ImpactQueryV1 {
  readonly schemaVersion: "1";
  readonly changed: readonly ImpactedTokenV1[];
  readonly directlyAffected: readonly ImpactedTokenV1[];
  readonly indirectlyAffected: readonly ImpactedTokenV1[];
}

function compareIds(left: TokenId, right: TokenId): number {
  return String(left).localeCompare(String(right));
}

function compareEdges(left: QueryEdgeV1, right: QueryEdgeV1): number {
  return (
    compareIds(left.from, right.from) ||
    compareIds(left.to, right.to) ||
    left.source.file.localeCompare(right.source.file) ||
    left.source.offset - right.source.offset ||
    left.candidate.localeCompare(right.candidate) ||
    JSON.stringify(left.fieldPath).localeCompare(JSON.stringify(right.fieldPath))
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function freezeEdge(edge: DependencyEdge, condition: ContextPredicate): QueryEdgeV1 {
  return deepFreeze({
    schemaVersion: "1",
    from: edge.from,
    to: edge.to,
    candidate: edge.occurrence.candidate,
    kind: edge.occurrence.kind,
    fieldPath: Object.freeze([...edge.occurrence.fieldPath]),
    source: edge.occurrence.source,
    condition: structuredClone(condition),
  });
}

/** Stable, read-only semantic queries over one Compilation revision. */
export interface CompilationQuery {
  context(overrides?: CompilationContext): CompilationContext;
  token(id: TokenId): TokenNode | undefined;
  definition(id: TokenId): SourceLocation | undefined;
  tokenAt(document: string, offset: number): TokenNode | undefined;
  completions(prefix?: string): readonly TokenId[];
  dependencies(id: TokenId, region?: QueryRegion): readonly QueryEdgeV1[];
  usages(id: TokenId, region?: QueryRegion): readonly QueryEdgeV1[];
  graph(roots?: readonly TokenId[], region?: QueryRegion): readonly QueryEdgeV1[];
  impact(changedIds: readonly TokenId[], region?: QueryRegion): ImpactQueryV1;
  resolve(id: TokenId, context?: CompilationContext): ResolvedToken | undefined;
  explain(id: TokenId, context?: CompilationContext): ExplainTraceV1 | undefined;
}

/** @internal Concrete Query implementation created only by the compiler. */
export class InternalCompilationQuery implements CompilationQuery {
  readonly #graph: TokenGraph;
  readonly #resolver: TokenResolver;
  readonly #resolution: ResolverResolution | undefined;

  constructor(graph: TokenGraph, resolver: TokenResolver, resolution?: ResolverResolution) {
    this.#graph = graph;
    this.#resolver = resolver;
    this.#resolution = resolution;
  }

  /** Complete Context used by resolve/explain after applying defaults and Resolver selection. */
  context(overrides: CompilationContext = {}): CompilationContext {
    return Object.freeze({
      ...this.#resolver.defaults,
      ...this.#resolution?.context,
      ...overrides,
    });
  }

  token(id: TokenId): TokenNode | undefined {
    return this.#graph.getToken(id);
  }

  definition(id: TokenId): SourceLocation | undefined {
    return this.#graph.getToken(id)?.source;
  }

  tokenAt(document: string, offset: number): TokenNode | undefined {
    return this.#graph.tokens
      .filter(
        (token) =>
          token.source.file === document &&
          offset >= token.source.offset &&
          offset < token.source.offset + token.source.length,
      )
      .toSorted(
        (left, right) => left.source.length - right.source.length || compareIds(left.id, right.id),
      )[0];
  }

  completions(prefix = ""): readonly TokenId[] {
    return Object.freeze(
      this.#graph.tokens
        .map((token) => token.id)
        .filter((id) => String(id).startsWith(prefix))
        .toSorted(compareIds),
    );
  }

  dependencies(id: TokenId, region: QueryRegion = {}): readonly QueryEdgeV1[] {
    return this.#edges(this.#graph.getOutgoingEdges(id), region);
  }

  usages(id: TokenId, region: QueryRegion = {}): readonly QueryEdgeV1[] {
    return this.#edges(this.#graph.getIncomingEdges(id), region);
  }

  graph(roots?: readonly TokenId[], region: QueryRegion = {}): readonly QueryEdgeV1[] {
    if (!roots) return this.#edges(this.#graph.edges, region);
    const edges: QueryEdgeV1[] = [];
    const visited = new Set<TokenId>();
    const queue = [...new Set(roots)].toSorted(compareIds);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const edge of this.dependencies(current, region)) {
        edges.push(edge);
        if (!visited.has(edge.to)) queue.push(edge.to);
      }
    }
    return Object.freeze(edges.toSorted(compareEdges));
  }

  impact(changedIds: readonly TokenId[], region: QueryRegion = {}): ImpactQueryV1 {
    const rootCondition = this.#regionPredicate(region);
    const roots = [...new Set(changedIds)].toSorted(compareIds);
    const affected = this.#graph.getAffected(
      new Map(roots.map((id) => [id, rootCondition] as const)),
    );
    const directIds = new Set(
      roots.flatMap((id) => this.usages(id, region).map((edge) => edge.from)),
    );
    const entry = (id: TokenId): ImpactedTokenV1 | undefined => {
      const condition = affected.get(id);
      return condition
        ? deepFreeze({ token: id, condition: structuredClone(condition) })
        : undefined;
    };
    const entries = (ids: readonly TokenId[]): readonly ImpactedTokenV1[] =>
      Object.freeze(ids.flatMap((id) => entry(id) ?? []));
    const changed = entries(roots);
    const directlyAffected = entries([...directIds].toSorted(compareIds));
    const indirectIds = [...affected.keys()]
      .filter((id) => !roots.includes(id) && !directIds.has(id))
      .toSorted(compareIds);
    return Object.freeze({
      schemaVersion: "1",
      changed,
      directlyAffected,
      indirectlyAffected: entries(indirectIds),
    });
  }

  resolve(id: TokenId, context: CompilationContext = {}): ResolvedToken | undefined {
    return this.#resolver.resolve(id, this.context(context));
  }

  explain(id: TokenId, context: CompilationContext = {}): ExplainTraceV1 | undefined {
    const trace = this.#resolver.trace(id, this.context(context));
    if (!trace) return undefined;
    return deepFreeze({
      ...trace,
      steps: trace.steps,
      resolverSteps:
        this.#resolution?.steps.map((step) => ({
          kind: step.kind,
          name: step.name,
          source: { ...step.source },
          ...(step.context ? { context: step.context } : {}),
        })) ?? [],
    });
  }

  #regionPredicate(region: QueryRegion): ContextPredicate {
    if (region.predicate) {
      const result = intersectContextPredicates(
        trueContextPredicate(this.#graph.domain),
        region.predicate,
      );
      if (!result.ok) throw new RangeError(result.error.message);
      return result.value;
    }
    if (region.context) {
      const result = contextPredicateFromSelector(this.#graph.domain, {
        ...this.#resolver.defaults,
        ...region.context,
      });
      if (!result.ok) throw new RangeError(result.error.message);
      return result.value;
    }
    return trueContextPredicate(this.#graph.domain);
  }

  #edges(edges: readonly DependencyEdge[], region: QueryRegion): readonly QueryEdgeV1[] {
    const scope = this.#regionPredicate(region);
    return Object.freeze(
      edges
        .flatMap((edge) => {
          const intersection = intersectContextPredicates(edge.condition, scope);
          if (!intersection.ok) throw new RangeError(intersection.error.message);
          return isContextPredicateSatisfiable(intersection.value)
            ? [freezeEdge(edge, intersection.value)]
            : [];
        })
        .toSorted(compareEdges),
    );
  }
}
