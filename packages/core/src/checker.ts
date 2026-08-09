import { TokenGraph } from "./graph.js";
import type { Diagnostic, TokenId, TokenReference } from "./model.js";

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

function references(graph: TokenGraph): readonly { owner: TokenId; reference: TokenReference }[] {
  return graph.tokens.flatMap((token) =>
    [token.value, ...token.overrides.map((override) => override.expression)]
      .filter((expression): expression is TokenReference => expression.kind === "reference")
      .map((reference) => ({ owner: token.id, reference })),
  );
}

/** Perform graph integrity and reference type checks. */
export function checkTokenGraph(graph: TokenGraph): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = graph.tokens.map((token) => token.id);
  for (const { owner, reference } of references(graph)) {
    const sourceToken = graph.getToken(owner);
    const targetToken = graph.getToken(reference.target);
    if (!sourceToken) continue;
    if (!targetToken) {
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
  for (const cycle of graph.detectCycles()) {
    const first = cycle[0];
    if (!first) continue;
    const token = graph.getToken(first);
    diagnostics.push({
      code: "TOKEN_CIRCULAR_REFERENCE",
      severity: "error",
      message: `Circular token reference detected:\n${cycle.map((id, index) => `${"    ".repeat(index)}${index === 0 ? "" : "└── "}${id}`).join("\n")}`,
      ...(token ? { source: token.source } : {}),
      related: cycle.slice(1, -1).flatMap((id) => {
        const related = graph.getToken(id);
        return related
          ? [{ message: `\`${id}\` participates in this cycle`, source: related.source }]
          : [];
      }),
    });
  }
  return diagnostics;
}
