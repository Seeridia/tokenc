import { contextKey, defaultContext, selectTokenCandidate } from "./context.js";
import { TokenGraph } from "./graph.js";
import type {
  CompilationContext,
  ContextDefinition,
  Diagnostic,
  TokenId,
  TokenNode,
  TokenReference,
} from "./model.js";

function distance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? j;
      const old = above;
      previous[j] = Math.min(
        (previous[j - 1] ?? 0) + 1,
        above + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = old;
    }
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

/** Find nearby canonical IDs using edit distance and shared path prefix. */
export function suggestTokenIds(
  target: TokenId,
  candidates: readonly TokenId[],
  limit = 3,
): readonly TokenId[] {
  const prefix = String(target).split(".").slice(0, -1).join(".");
  return candidates
    .map((candidate) => ({
      candidate,
      score: distance(target, candidate) - (String(candidate).startsWith(prefix) ? 2 : 0),
    }))
    .toSorted((a, b) => a.score - b.score || String(a.candidate).localeCompare(String(b.candidate)))
    .filter((item) => item.score <= Math.max(3, Math.floor(String(target).length / 3)))
    .slice(0, limit)
    .map((item) => item.candidate);
}

function references(
  graph: TokenGraph,
  scope?: ReadonlySet<TokenId>,
): readonly { owner: TokenId; reference: TokenReference }[] {
  const tokens = scope
    ? [...scope].flatMap((id) => {
        const token = graph.getToken(id);
        return token ? [token] : [];
      })
    : graph.tokens;
  return tokens.flatMap((token) =>
    [token.value, ...token.overrides.map((override) => override.expression)]
      .filter((expression): expression is TokenReference => expression.kind === "reference")
      .map((reference) => ({ owner: token.id, reference })),
  );
}

interface CheckedCycle {
  readonly path: readonly TokenId[];
  readonly context?: CompilationContext;
}

interface CycleProjectionLimit {
  readonly region: readonly TokenId[];
  readonly dimensions: readonly RelevantDimension[];
}

interface ContextAwareCycleResult {
  readonly cycles: readonly CheckedCycle[];
  readonly limits: readonly CycleProjectionLimit[];
}

/** Maximum number of Context projections checked for one cyclic candidate region. */
export const CONTEXT_CYCLE_PROJECTION_LIMIT = 16_384;

function canonicalCycle(cycle: readonly TokenId[]): string {
  const body = cycle.slice(0, -1).map(String);
  return (
    body
      .map((_, index) => [...body.slice(index), ...body.slice(0, index)].join("\0"))
      .toSorted()[0] ?? ""
  );
}

function reachable(
  graph: TokenGraph,
  root: TokenId,
  direction: "dependencies" | "dependents",
): ReadonlySet<TokenId> {
  const found = new Set<TokenId>([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    const adjacent =
      direction === "dependencies" ? graph.getDependencies(current) : graph.getDependents(current);
    for (const id of adjacent) {
      if (!graph.hasToken(id) || found.has(id)) continue;
      found.add(id);
      queue.push(id);
    }
  }
  return found;
}

/** Find union-graph strongly connected regions without materializing unrelated Context products. */
function cyclicRegions(
  graph: TokenGraph,
  scope?: ReadonlySet<TokenId>,
): readonly (readonly TokenId[])[] {
  const regions: TokenId[][] = [];
  const assigned = new Set<TokenId>();
  for (const cycle of graph.detectCycles(scope)) {
    const root = cycle[0];
    if (!root || assigned.has(root)) continue;
    const forward = reachable(graph, root, "dependencies");
    const backward = reachable(graph, root, "dependents");
    const region = [...forward]
      .filter((id) => backward.has(id))
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const id of region) assigned.add(id);
    regions.push(region);
  }
  return regions;
}

interface RelevantDimension {
  readonly name: string;
  readonly values: readonly string[];
}

function relevantDimensions(
  tokens: readonly TokenNode[],
  definition: ContextDefinition,
): readonly RelevantDimension[] {
  const selectedValues = new Map<string, Set<string>>();
  for (const token of tokens) {
    for (const override of token.overrides) {
      for (const [name, value] of Object.entries(override.selector)) {
        const values = selectedValues.get(name) ?? new Set<string>();
        values.add(value);
        selectedValues.set(name, values);
      }
    }
  }
  return Object.entries(definition).flatMap(([name, dimension]) => {
    const selected = selectedValues.get(name);
    if (!selected) return [];
    const allowed = [...new Set([dimension.default, ...dimension.values])];
    const unselectedRepresentative = allowed.find((value) => !selected.has(value));
    return [
      {
        name,
        values: allowed.filter(
          (value) => selected.has(value) || value === unselectedRepresentative,
        ),
      },
    ];
  });
}

/** Lazily enumerate only dimensions that can change edge selection inside one cyclic region. */
function* projectedContexts(
  definition: ContextDefinition,
  dimensions: readonly RelevantDimension[],
): Generator<CompilationContext> {
  const context: Record<string, string> = { ...defaultContext(definition) };
  function* visit(index: number): Generator<CompilationContext> {
    const dimension = dimensions[index];
    if (!dimension) {
      yield { ...context };
      return;
    }
    for (const value of dimension.values) {
      context[dimension.name] = value;
      yield* visit(index + 1);
    }
  }
  yield* visit(0);
}

function exceedsProjectionLimit(dimensions: readonly RelevantDimension[]): boolean {
  let count = 1;
  for (const dimension of dimensions) {
    // Division avoids overflowing Number before the fixed limit is detected.
    if (dimension.values.length > Math.floor(CONTEXT_CYCLE_PROJECTION_LIMIT / count)) return true;
    count *= dimension.values.length;
  }
  return false;
}

function selectedDependencies(
  token: TokenNode,
  context: CompilationContext,
  resolutionOrder: readonly string[],
): readonly TokenId[] {
  const selected = selectTokenCandidate(token, context, resolutionOrder);
  return [
    ...new Set([...selected.dependencies, ...(token.inheritance ? [token.inheritance.token] : [])]),
  ];
}

function contextAwareCycles(
  graph: TokenGraph,
  definition: ContextDefinition,
  scope?: ReadonlySet<TokenId>,
): ContextAwareCycleResult {
  const cycles: CheckedCycle[] = [];
  const limits: CycleProjectionLimit[] = [];
  const signatures = new Set<string>();
  const resolutionOrder = Object.keys(definition);
  for (const region of cyclicRegions(graph, scope)) {
    const tokens = region.flatMap((id) => {
      const token = graph.getToken(id);
      return token ? [token] : [];
    });
    if (tokens.every((token) => token.overrides.length === 0)) {
      for (const path of new TokenGraph(tokens).detectCycles()) {
        const signature = canonicalCycle(path);
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        cycles.push({ path });
      }
      continue;
    }
    const dimensions = relevantDimensions(tokens, definition);
    if (exceedsProjectionLimit(dimensions)) {
      limits.push({ region, dimensions });
      continue;
    }
    for (const context of projectedContexts(definition, dimensions)) {
      const projectedTokens: TokenNode[] = [];
      for (const token of tokens) {
        projectedTokens.push({
          ...token,
          dependencies: selectedDependencies(token, context, resolutionOrder),
        });
      }
      const projection = new TokenGraph(projectedTokens);
      for (const path of projection.detectCycles()) {
        const signature = canonicalCycle(path);
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        cycles.push({ path, context });
      }
    }
  }
  return { cycles, limits };
}

/** Perform graph integrity and reference type checks. */
export function checkTokenGraph(
  graph: TokenGraph,
  scope?: ReadonlySet<TokenId>,
  contexts: ContextDefinition = {},
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let ids: readonly TokenId[] | undefined;
  for (const { owner, reference } of references(graph, scope)) {
    const sourceToken = graph.getToken(owner);
    const targetToken = graph.getToken(reference.target);
    if (!sourceToken) continue;
    if (!targetToken) {
      ids ??= graph.tokens.map((token) => token.id);
      const suggestions = suggestTokenIds(reference.target, ids).map(String);
      diagnostics.push({
        code: "TOKEN_UNKNOWN_REFERENCE",
        severity: "error",
        message: `Unknown token \`${reference.target}\``,
        source: reference.source,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      });
    } else if (sourceToken.type !== targetToken.type) {
      diagnostics.push({
        code: "TOKEN_REFERENCE_TYPE_MISMATCH",
        severity: "error",
        message: `Invalid token reference: \`${owner}\` expects ${sourceToken.type}, but \`${reference.target}\` is ${targetToken.type}`,
        source: reference.source,
        related: [
          {
            message: `\`${reference.target}\` is defined here as ${targetToken.type}`,
            source: targetToken.source,
          },
        ],
      });
    }
  }
  const cycleCheck = contextAwareCycles(graph, contexts, scope);
  for (const cycle of cycleCheck.cycles) {
    const first = cycle.path[0];
    if (!first) continue;
    const token = graph.getToken(first);
    const activeContext = cycle.context ? contextKey(cycle.context) : "";
    diagnostics.push({
      code: "TOKEN_CIRCULAR_REFERENCE",
      severity: "error",
      message: `Circular token reference detected:\n${cycle.path.map((id, index) => `${"    ".repeat(index)}${index === 0 ? "" : "└── "}${id}`).join("\n")}${activeContext ? `\nActive context: \`${activeContext}\`` : ""}`,
      ...(token ? { source: token.source } : {}),
      related: cycle.path.slice(1, -1).flatMap((id) => {
        const related = graph.getToken(id);
        return related
          ? [{ message: `\`${id}\` participates in this cycle`, source: related.source }]
          : [];
      }),
    });
  }
  for (const limit of cycleCheck.limits) {
    const first = limit.region[0];
    if (!first) continue;
    const token = graph.getToken(first);
    diagnostics.push({
      code: "TOKEN_CONTEXT_PROJECTION_LIMIT",
      severity: "error",
      message: `Context-aware cycle analysis exceeded its limit of ${CONTEXT_CYCLE_PROJECTION_LIMIT} projections for the region rooted at \`${first}\` (${limit.region.length} tokens; ${limit.dimensions.length} relevant dimensions: ${limit.dimensions.map((dimension) => `${dimension.name}=${dimension.values.length}`).join(", ")}). Reduce the region's Context combinations before checking.`,
      ...(token ? { source: token.source } : {}),
    });
  }
  return diagnostics;
}
