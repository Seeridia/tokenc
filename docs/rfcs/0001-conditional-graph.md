# RFC 0001: Conditional Dependency Graph

[简体中文](0001-conditional-graph.zh-CN.md)

- Status: Accepted
- Milestone: M1-02 / M1-03
- Updated: 2026-08-30

## Summary

tokenc preserves every dependency spelling as a source-located `DependencyOccurrence`, then derives
a `DependencyEdge` with the exact `ContextPredicate` under which its candidate wins. Predicates use
a canonical, disjoint DNF over finite Context domains and are closed under intersection, union,
complement, and subtraction. Conditional edges become the only source of truth for cycle checking,
queries, impact analysis, and incremental invalidation.

The project is in `0.x`. This RFC directly replaces `TokenNode.dependencies` and the public ID-only
`TokenGraph` queries. It provides no compatibility view or migration period.

## User problem

The current Graph collapses base and override dependencies into `TokenId → Set<TokenId>`. It cannot
answer where a reference was written, which Contexts select it, whether two edges can be active
together, which `(TokenId, Context)` pairs an edit affects, or why usages, impact, and cycle queries
return their results.

The Checker compensates by enumerating relevant Contexts and rerunning candidate selection. That
duplicates semantics and leaves the Query API unable to consume the same facts.

## Decisions

### 1. Preserve every dependency occurrence

The Frontend and Linker produce this record before deduplication:

```ts
interface DependencyOccurrence {
  readonly id: string;
  readonly owner: TokenId;
  readonly candidate: CandidateId;
  readonly target: TokenId;
  readonly kind: "alias" | "json-pointer" | "inheritance" | "composite-field";
  readonly fieldPath: readonly (string | number)[];
  readonly source: SourceLocation;
  readonly sourceOrder: number;
}
```

`id` is deterministically derived from source document identity, owner, candidate, field path,
source offset, and a same-position ordinal. It identifies and orders facts within one source
revision; it is not stable across content edits.

Duplicate occurrences are **preserved as separate edges**, not aggregated. Different composite
fields, JSON Pointers, and source locations must remain independently navigable and diagnosable even
when `from`, `to`, and condition match. Queries that need set semantics deduplicate explicitly at
their return boundary.

### 2. Candidate ranking is the only winner rule

Each Token has one base candidate and zero or more override candidates. Override rank is, in order:

1. explicit `precedence`, higher first;
2. selector specificity, more constrained dimensions first;
3. dimension-presence bits compared from last to first in `ContextDefinition` declaration order;
4. source order, earlier first.

Duplicate raw selectors remain `TOKEN_RESOLUTION_AMBIGUOUS`; source order does not hide that error.
The base raw predicate is the complete valid Context universe and ranks below every valid override.

A raw selector says only where a candidate may compete. Its effective condition is:

```text
effective(candidate) = raw(candidate)
                     − union(raw(candidate with a higher winner rank))
```

Every occurrence in a candidate inherits that effective predicate. An empty predicate emits no edge,
but the occurrence remains available to explain that it is fully shadowed.

### 3. Predicates use canonical, disjoint DNF

The predicate universe comes from a validated `ContextDefinition`; every dimension is a finite set of
strings. The internal representation is an ordered set of disjoint clauses, each carrying the allowed
values for its constrained dimensions:

```ts
interface ContextClause {
  readonly dimensions: ReadonlyMap<string, ReadonlySet<string>>;
}

interface ContextPredicate {
  readonly clauses: readonly ContextClause[];
}
```

- `false` is an empty clause list; `true` is one clause spanning every domain.
- An omitted dimension means its complete domain and is omitted from serialization.
- Dimensions, values, and clauses have canonical ordering.
- Normalization removes empty, duplicate, and subsumed clauses and splits overlaps so clauses are
  pairwise disjoint.
- `matches`, `intersect`, `union`, `complement`, `subtract`, and `isSatisfiable` are exact. A
  non-convex result is never approximated by one conjunction.

Operations estimate expansion before allocation. One operation may produce at most 16,384 canonical
clauses. Exceeding it returns `TOKEN_CONTEXT_PREDICATE_LIMIT` with the operation, candidate, relevant
dimensions, and estimate, without allocating a partial result. This initial limit reuses the safe
projection bound measured by M1-01 and may change only with benchmarks and regression tests.

### 4. Conditional edges are the only Graph facts

```ts
interface DependencyEdge {
  readonly occurrence: DependencyOccurrence;
  readonly from: TokenId;
  readonly to: TokenId;
  readonly condition: ContextPredicate;
}
```

The Graph indexes immutable edges by `(from, to, occurrence.id)` and in forward and reverse indexes.
There is no second `Set<TokenId>` adjacency fact.

A cycle exists exactly when the intersection of every edge condition on a closed path is satisfiable.
The diagnostic returns the closed edge path, its satisfiable predicate, and one deterministic witness
Context. Each related location points to the exact occurrence. Full Context Cartesian enumeration is
no longer required.

`dependencies`, `usages`, and `impact` queries accept an optional Context or Predicate:

- a Context returns only edges whose condition matches it;
- a Predicate returns edges with a satisfiable intersection and that intersection;
- no filter returns every occurrence without implicit deduplication;
- Token-ID aggregation is a separate explicit Query operation.

### 5. Invalid input and diagnostics

Unknown dimensions, unknown values, and duplicate selectors produce their existing stable diagnostics
before graph construction. Their candidates produce no semantic edge. An unknown target still
produces an edge so definition navigation, usages, and unknown-reference diagnostics share one
occurrence; target existence is a Checker fact, not an edge-construction prerequisite.

Predicate complexity errors, conditional cycles, and unknown references use the occurrence source as
their primary location. Conditional-cycle related locations follow path order instead of pointing only
to Token definitions.

## Incremental invalidation

- Document changes compare occurrence and candidate semantic identity first.
- An occurrence change rebuilds only its owner's outgoing edges; target changes also update the
  reverse index.
- Selector, precedence, `ContextDefinition`, or dimension-order changes recompute candidate effective
  predicates for relevant Tokens.
- Edge-condition changes invalidate only resolver/query cache entries intersecting the changed
  predicate.
- Cycle caches invalidate by affected conditional strongly connected region. A complexity failure
  never publishes a partial Graph revision.
- Source-range-only changes update provenance without invalidating resolved-value caches, but still
  produce a new snapshot.

## Public API changes

- Remove `TokenNode.dependencies`, `baseDependencies`, and ID-only override `dependencies`.
- Remove `TokenGraph.getDependencies(id)`, `getDependents(id)`, and ID-only impact results.
- Make `TokenGraph.patch()` non-public; the Session builds and freezes Graph revisions.
- The new Query API returns `DependencyEdge`, occurrences, or an explicitly aggregated result.
- Migrate `compile` and CLI graph/usages/explain in M1-09 in one step, with no compatibility facade.

## Test plan

- Characterize every M0 cycle fixture with identical semantic outcomes.
- Table tests for base, override, default, precedence, specificity, and dimension order.
- Property tests for predicate Boolean algebra, closure, normalization idempotence, and deterministic
  serialization.
- Fixtures for partial overlaps, full shadowing, three-dimensional intersections, true mixed cycles,
  and mutually exclusive false cycles.
- Occurrences for the same target in multiple composite fields, repeated JSON Pointers, and
  cross-document provenance.
- Incremental differential tests comparing edges, cycles, and queries with cold builds.
- Stable pre-allocation tests for the 16,384-clause limit.

## Open questions

None. If review rejects a decision, its replacement and rationale must be recorded here before the
RFC is accepted.

## Explicit non-goals

- Infinite or regular-expression Context domains.
- Arbitrary user-authored Boolean Context syntax.
- Approximate predicates for performance.
- An ID-only Graph compatibility view.
- Session, Diagnostic schema, or Backend API design; RFC 0002 and RFC 0003 own those contracts.
