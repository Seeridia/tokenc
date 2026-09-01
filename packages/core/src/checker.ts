import { contextKey } from "./context.js";
import { DiagnosticBag } from "./diagnostic.js";
import { TokenGraph } from "./graph.js";
import type {
  ContextCycleMetrics,
  ContextDefinition,
  DependencyOccurrence,
  Diagnostic,
  TokenId,
  TokenNode,
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

function candidateExpression(token: TokenNode, occurrence: DependencyOccurrence) {
  if (occurrence.candidate === token.baseCandidate) return token.value;
  return token.overrides.find((override) => override.candidate === occurrence.candidate)
    ?.expression;
}

function requiresWholeTokenType(token: TokenNode, occurrence: DependencyOccurrence): boolean {
  const expression = candidateExpression(token, occurrence);
  return (
    expression?.kind === "reference" &&
    expression.target === occurrence.target &&
    occurrence.fieldPath.length === 0
  );
}

export interface TokenGraphCheckResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly metrics: ContextCycleMetrics;
}

/** Maximum retained for benchmark/report compatibility; conditional edges no longer enumerate it. */
export const CONTEXT_CYCLE_PROJECTION_LIMIT = 16_384;

/** @internal Check graph integrity directly against conditional dependency edges. */
export function checkTokenGraphDetailed(
  graph: TokenGraph,
  scope?: ReadonlySet<TokenId>,
  _contexts: ContextDefinition = {},
): TokenGraphCheckResult {
  const diagnostics = new DiagnosticBag();
  const ids = graph.tokens.map((token) => token.id);
  const edges = scope ? [...scope].flatMap((id) => graph.getOutgoingEdges(id)) : graph.edges;
  for (const edge of edges) {
    const sourceToken = graph.getToken(edge.from);
    const targetToken = graph.getToken(edge.to);
    if (!sourceToken) continue;
    if (!targetToken) {
      const suggestions = suggestTokenIds(edge.to, ids).map(String);
      diagnostics.push({
        code: "TOKEN_UNKNOWN_REFERENCE",
        severity: "error",
        message: `Unknown token \`${edge.to}\``,
        source: edge.occurrence.source,
        anchor: {
          kind: "field",
          token: edge.from,
          candidate: edge.occurrence.candidate,
          path: edge.occurrence.fieldPath,
        },
        parameters: { target: edge.to },
        related: suggestions.map((suggestion) => ({ message: `Did you mean \`${suggestion}\`?` })),
      });
    } else if (
      requiresWholeTokenType(sourceToken, edge.occurrence) &&
      sourceToken.type !== targetToken.type
    ) {
      diagnostics.push({
        code: "TOKEN_REFERENCE_TYPE_MISMATCH",
        severity: "error",
        message: `Invalid token reference: \`${edge.from}\` expects ${sourceToken.type}, but \`${edge.to}\` is ${targetToken.type}`,
        source: edge.occurrence.source,
        anchor: {
          kind: "field",
          token: edge.from,
          candidate: edge.occurrence.candidate,
          path: edge.occurrence.fieldPath,
        },
        parameters: { target: edge.to, expected: sourceToken.type, actual: targetToken.type },
        related: [
          {
            message: `\`${edge.to}\` is defined here as ${targetToken.type}`,
            source: targetToken.source,
          },
        ],
      });
    }
  }

  const cycles = graph.detectConditionalCycles(scope);
  for (const cycle of cycles) {
    const first = cycle.edges[0];
    if (!first) continue;
    const path = [first.from, ...cycle.edges.map((edge) => edge.to)];
    const activeContext = contextKey(cycle.witness);
    diagnostics.push({
      code: "TOKEN_CIRCULAR_REFERENCE",
      severity: "error",
      message: `Circular token reference detected:\n${path.map((id, index) => `${"    ".repeat(index)}${index === 0 ? "" : "└── "}${id}`).join("\n")}${activeContext ? `\nActive context: \`${activeContext}\`` : ""}`,
      source: first.occurrence.source,
      anchor: { kind: "token", token: first.from },
      parameters: { cycle: path.map(String), context: cycle.witness },
      related: cycle.edges.slice(1).map((edge) => ({
        message: `\`${edge.from}\` references \`${edge.to}\` here`,
        source: edge.occurrence.source,
      })),
    });
  }

  return {
    diagnostics,
    metrics: {
      candidateRegions: cycles.length,
      relevantDimensions: cycles.reduce(
        (count, cycle) => count + Object.keys(cycle.witness).length,
        0,
      ),
      estimatedProjections: 0,
      estimateSaturated: false,
      enumeratedProjections: 0,
      earlyExits: 0,
      limitHits: graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "TOKEN_CONTEXT_PREDICATE_LIMIT",
      ).length,
    },
  };
}

/** Perform graph integrity and reference type checks. */
export function checkTokenGraph(
  graph: TokenGraph,
  scope?: ReadonlySet<TokenId>,
  contexts: ContextDefinition = {},
): readonly Diagnostic[] {
  return checkTokenGraphDetailed(graph, scope, contexts).diagnostics;
}
