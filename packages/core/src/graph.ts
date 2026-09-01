import { createDiagnostic, DiagnosticBag } from "./diagnostic.js";
import type {
  CompilationContext,
  ContextDefinition,
  ContextOverride,
  DependencyOccurrence,
  Diagnostic,
  TokenId,
  TokenNode,
} from "./model.js";
import {
  contextPredicateFromSelector,
  contextPredicateMatches,
  createContextDomain,
  falseContextPredicate,
  intersectContextPredicates,
  isContextPredicateSatisfiable,
  subtractContextPredicates,
  trueContextPredicate,
  unionContextPredicates,
  type ContextDomain,
  type ContextPredicate,
} from "./predicate.js";

export interface DependencyEdge {
  readonly occurrence: DependencyOccurrence;
  readonly from: TokenId;
  readonly to: TokenId;
  readonly condition: ContextPredicate;
}

export interface ConditionalCycle {
  readonly edges: readonly DependencyEdge[];
  readonly condition: ContextPredicate;
  readonly witness: CompilationContext;
}

export interface DependencyEdgeFilter {
  readonly context?: CompilationContext;
  readonly predicate?: ContextPredicate;
}

function compareIds(left: TokenId, right: TokenId): number {
  return String(left).localeCompare(String(right));
}

function compareEdges(left: DependencyEdge, right: DependencyEdge): number {
  return (
    left.occurrence.sourceOrder - right.occurrence.sourceOrder ||
    compareIds(left.to, right.to) ||
    left.occurrence.kind.localeCompare(right.occurrence.kind) ||
    left.occurrence.id.localeCompare(right.occurrence.id)
  );
}

function compareSelectors(
  left: CompilationContext,
  right: CompilationContext,
  order: readonly string[],
): number {
  const specificity = Object.keys(left).length - Object.keys(right).length;
  if (specificity !== 0) return specificity;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const dimension = order[index];
    if (!dimension) continue;
    const difference =
      Number(Object.hasOwn(left, dimension)) - Number(Object.hasOwn(right, dimension));
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareOverrides(
  left: { readonly override: ContextOverride; readonly index: number },
  right: { readonly override: ContextOverride; readonly index: number },
  order: readonly string[],
): number {
  const precedence = (right.override.precedence ?? 0) - (left.override.precedence ?? 0);
  if (precedence !== 0) return precedence;
  const selector = compareSelectors(left.override.selector, right.override.selector, order);
  if (selector !== 0) return -selector;
  return left.index - right.index;
}

function witness(predicate: ContextPredicate): CompilationContext {
  const clause = predicate.clauses[0] ?? {};
  return Object.fromEntries(
    predicate.domain.dimensions.map((dimension) => [
      dimension.name,
      clause[dimension.name]?.[0] ?? dimension.default,
    ]),
  );
}

function canonicalCycleSignature(edges: readonly DependencyEdge[]): string {
  const ids = edges.map((edge) => edge.occurrence.id);
  return (
    ids.map((_, index) => [...ids.slice(index), ...ids.slice(0, index)].join("\0")).toSorted()[0] ??
    ""
  );
}

/** Conditional dependency graph backed by source-level dependency occurrences. */
export class TokenGraph {
  readonly #tokens = new Map<TokenId, TokenNode>();
  readonly #forward = new Map<TokenId, readonly DependencyEdge[]>();
  readonly #reverse = new Map<TokenId, readonly DependencyEdge[]>();
  readonly #contexts: ContextDefinition;
  readonly #domain: ContextDomain;
  #edges: readonly DependencyEdge[] = [];
  #diagnostics: readonly Diagnostic[] = [];

  constructor(tokens: Iterable<TokenNode> = [], contexts: ContextDefinition = {}) {
    this.#contexts = contexts;
    this.#domain = createContextDomain(contexts);
    for (const token of tokens) this.#tokens.set(token.id, token);
    this.#rebuildEdges();
  }

  get size(): number {
    return this.#tokens.size;
  }
  get tokens(): readonly TokenNode[] {
    return [...this.#tokens.values()];
  }
  get edges(): readonly DependencyEdge[] {
    return this.#edges;
  }
  get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
  get domain(): ContextDomain {
    return this.#domain;
  }
  getToken(id: TokenId): TokenNode | undefined {
    return this.#tokens.get(id);
  }
  hasToken(id: TokenId): boolean {
    return this.#tokens.has(id);
  }

  getOutgoingEdges(id: TokenId, filter: DependencyEdgeFilter = {}): readonly DependencyEdge[] {
    return this.#filterEdges(this.#forward.get(id) ?? [], filter);
  }

  getIncomingEdges(id: TokenId, filter: DependencyEdgeFilter = {}): readonly DependencyEdge[] {
    return this.#filterEdges(this.#reverse.get(id) ?? [], filter);
  }

  #filterEdges(
    edges: readonly DependencyEdge[],
    filter: DependencyEdgeFilter,
  ): readonly DependencyEdge[] {
    if (filter.context)
      return edges.filter((edge) => contextPredicateMatches(edge.condition, filter.context ?? {}));
    if (filter.predicate)
      return edges.filter((edge) => {
        const intersection = intersectContextPredicates(edge.condition, filter.predicate!);
        return intersection.ok && isContextPredicateSatisfiable(intersection.value);
      });
    return edges;
  }

  /** Stable Kahn ordering. Dependencies precede consumers for the requested Context. */
  topologicalSort(context: CompilationContext = {}): readonly TokenId[] {
    const inDegree = new Map<TokenId, number>();
    for (const id of this.#tokens.keys()) {
      const dependencies = new Set(
        this.getOutgoingEdges(id, { context })
          .map((edge) => edge.to)
          .filter((dependency) => this.hasToken(dependency)),
      );
      inDegree.set(id, dependencies.size);
    }
    const ready = [...inDegree]
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id)
      .toSorted(compareIds);
    const result: TokenId[] = [];
    while (ready.length > 0) {
      const id = ready.shift();
      if (!id) continue;
      result.push(id);
      const dependents = [
        ...new Set(this.getIncomingEdges(id, { context }).map((edge) => edge.from)),
      ].toSorted(compareIds);
      for (const dependent of dependents) {
        if (!this.hasToken(dependent)) continue;
        const degree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, degree);
        if (degree === 0) {
          ready.push(dependent);
          ready.sort(compareIds);
        }
      }
    }
    if (result.length < this.size) {
      const emitted = new Set(result);
      result.push(
        ...[...this.#tokens.keys()].filter((id) => !emitted.has(id)).toSorted(compareIds),
      );
    }
    return result;
  }

  /** Propagate changed Context regions through reverse conditional edges. */
  getAffected(
    changed: ReadonlyMap<TokenId, ContextPredicate>,
  ): ReadonlyMap<TokenId, ContextPredicate> {
    const affected = new Map(changed);
    const queue = [...changed.keys()];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      const currentCondition = affected.get(current);
      if (!currentCondition) continue;
      for (const edge of this.getIncomingEdges(current)) {
        const intersection = intersectContextPredicates(currentCondition, edge.condition);
        if (!intersection.ok || !isContextPredicateSatisfiable(intersection.value)) continue;
        const previous = affected.get(edge.from) ?? falseContextPredicate(this.#domain);
        const combined = unionContextPredicates(previous, intersection.value);
        if (!combined.ok || combined.value.key === previous.key) continue;
        affected.set(edge.from, combined.value);
        queue.push(edge.from);
      }
    }
    return affected;
  }

  /** Propagate a root region through forward conditional edges. */
  getDependencyClosure(
    roots: ReadonlyMap<TokenId, ContextPredicate>,
  ): ReadonlyMap<TokenId, ContextPredicate> {
    const closure = new Map(roots);
    const queue = [...roots.keys()];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      const currentCondition = closure.get(current);
      if (!currentCondition) continue;
      for (const edge of this.getOutgoingEdges(current)) {
        const intersection = intersectContextPredicates(currentCondition, edge.condition);
        if (!intersection.ok || !isContextPredicateSatisfiable(intersection.value)) continue;
        const previous = closure.get(edge.to) ?? falseContextPredicate(this.#domain);
        const combined = unionContextPredicates(previous, intersection.value);
        if (!combined.ok || combined.value.key === previous.key) continue;
        closure.set(edge.to, combined.value);
        queue.push(edge.to);
      }
    }
    return closure;
  }

  detectConditionalCycles(roots?: Iterable<TokenId>): readonly ConditionalCycle[] {
    const cycles: ConditionalCycle[] = [];
    const signatures = new Set<string>();
    for (const component of this.#cyclicComponents(roots)) {
      const members = new Set(component);
      for (const start of component) {
        const visit = (
          current: TokenId,
          active: ReadonlySet<TokenId>,
          path: readonly DependencyEdge[],
          condition: ContextPredicate,
        ): void => {
          for (const edge of this.getOutgoingEdges(current)) {
            if (!members.has(edge.to)) continue;
            const intersection = intersectContextPredicates(condition, edge.condition);
            if (!intersection.ok || !isContextPredicateSatisfiable(intersection.value)) continue;
            if (edge.to === start) {
              const edges = [...path, edge];
              const signature = `${canonicalCycleSignature(edges)}\0${intersection.value.key}`;
              if (!signatures.has(signature)) {
                signatures.add(signature);
                cycles.push({
                  edges,
                  condition: intersection.value,
                  witness: witness(intersection.value),
                });
              }
            } else if (!active.has(edge.to)) {
              visit(edge.to, new Set([...active, edge.to]), [...path, edge], intersection.value);
            }
          }
        };
        visit(start, new Set([start]), [], trueContextPredicate(this.#domain));
      }
    }
    return cycles;
  }

  #cyclicComponents(roots?: Iterable<TokenId>): readonly (readonly TokenId[])[] {
    const ids = [...this.#tokens.keys()].toSorted(compareIds);
    const visited = new Set<TokenId>();
    const finished: TokenId[] = [];
    for (const start of ids) {
      if (visited.has(start)) continue;
      const stack: { id: TokenId; adjacent: readonly TokenId[]; index: number }[] = [
        {
          id: start,
          adjacent: [...new Set(this.getOutgoingEdges(start).map((edge) => edge.to))],
          index: 0,
        },
      ];
      visited.add(start);
      while (stack.length > 0) {
        const frame = stack.at(-1)!;
        const next = frame.adjacent[frame.index];
        if (next) {
          frame.index += 1;
          if (!this.hasToken(next) || visited.has(next)) continue;
          visited.add(next);
          stack.push({
            id: next,
            adjacent: [...new Set(this.getOutgoingEdges(next).map((edge) => edge.to))],
            index: 0,
          });
        } else {
          stack.pop();
          finished.push(frame.id);
        }
      }
    }
    const assigned = new Set<TokenId>();
    const rootSet = roots ? new Set(roots) : undefined;
    const components: TokenId[][] = [];
    for (const start of finished.toReversed()) {
      if (assigned.has(start)) continue;
      const component: TokenId[] = [];
      const stack = [start];
      assigned.add(start);
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        component.push(current);
        for (const previous of new Set(this.getIncomingEdges(current).map((edge) => edge.from))) {
          if (!this.hasToken(previous) || assigned.has(previous)) continue;
          assigned.add(previous);
          stack.push(previous);
        }
      }
      component.sort(compareIds);
      const cyclic =
        component.length > 1 ||
        this.getOutgoingEdges(component[0]!).some((edge) => edge.to === component[0]);
      if (cyclic && (!rootSet || component.some((id) => rootSet.has(id))))
        components.push(component);
    }
    return components;
  }

  #rebuildEdges(): void {
    const diagnostics = new DiagnosticBag();
    const edges: DependencyEdge[] = [];
    const resolutionOrder = Object.keys(this.#contexts);
    for (const token of this.#tokens.values()) {
      const predicates = new Map<string, ContextPredicate>();
      let covered = falseContextPredicate(this.#domain);
      const ranked = token.overrides
        .map((override, index) => ({ override, index }))
        .toSorted((left, right) => compareOverrides(left, right, resolutionOrder));
      for (const { override } of ranked) {
        const raw = contextPredicateFromSelector(this.#domain, override.selector);
        if (!raw.ok) continue;
        const effective = subtractContextPredicates(raw.value, covered);
        const nextCovered = unionContextPredicates(covered, raw.value);
        if (!effective.ok) {
          diagnostics.push(
            createDiagnostic({
              ...effective.error,
              severity: "error",
              source: override.source,
              anchor: { kind: "candidate", token: token.id, candidate: override.candidate },
            }),
          );
          continue;
        }
        if (!nextCovered.ok) {
          diagnostics.push(
            createDiagnostic({
              ...nextCovered.error,
              severity: "error",
              source: override.source,
              anchor: { kind: "candidate", token: token.id, candidate: override.candidate },
            }),
          );
          continue;
        }
        predicates.set(override.candidate, effective.value);
        covered = nextCovered.value;
      }
      const base = subtractContextPredicates(trueContextPredicate(this.#domain), covered);
      if (base.ok) predicates.set(token.baseCandidate, base.value);
      else
        diagnostics.push(
          createDiagnostic({
            ...base.error,
            severity: "error",
            source: token.source,
            anchor: { kind: "token", token: token.id },
          }),
        );
      for (const occurrence of token.dependencyOccurrences) {
        const condition =
          occurrence.kind === "inheritance"
            ? trueContextPredicate(this.#domain)
            : predicates.get(occurrence.candidate);
        if (!condition || !isContextPredicateSatisfiable(condition)) continue;
        edges.push({ occurrence, from: token.id, to: occurrence.target, condition });
      }
    }
    this.#edges = Object.freeze(edges.toSorted(compareEdges));
    this.#diagnostics = Object.freeze(diagnostics);
    this.#forward.clear();
    this.#reverse.clear();
    for (const id of this.#tokens.keys()) {
      this.#forward.set(id, []);
      this.#reverse.set(id, []);
    }
    for (const edge of this.#edges) {
      this.#forward.set(edge.from, Object.freeze([...(this.#forward.get(edge.from) ?? []), edge]));
      this.#reverse.set(edge.to, Object.freeze([...(this.#reverse.get(edge.to) ?? []), edge]));
    }
  }
}
