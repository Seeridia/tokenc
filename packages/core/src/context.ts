import type {
  CompilationContext,
  ContextDefinition,
  Diagnostic,
  TokenExpression,
  TokenNode,
} from "./model.js";

/** Materialize only the declared defaults; no context Cartesian product is created. */
export function defaultContext(definition: ContextDefinition = {}): CompilationContext {
  return Object.fromEntries(
    Object.entries(definition).map(([name, dimension]) => [name, dimension.default]),
  );
}

/** Stable context cache key independent of object insertion order. */
export function contextKey(context: CompilationContext): string {
  return Object.entries(context)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export function parseContextKey(key: string): CompilationContext {
  if (!key.trim()) return {};
  return Object.fromEntries(
    key.split("&").map((clause) => {
      const boundary = clause.indexOf("=");
      return [clause.slice(0, boundary).trim(), clause.slice(boundary + 1).trim()];
    }),
  );
}

function matches(selector: CompilationContext, context: CompilationContext): boolean {
  return Object.entries(selector).every(([name, value]) => context[name] === value);
}

/** Select the most-specific matching expression for one token and context. */
export function selectTokenExpression(
  token: TokenNode,
  context: CompilationContext,
): TokenExpression {
  let selected = token.value;
  let specificity = -1;
  for (const override of token.overrides) {
    const score = Object.keys(override.selector).length;
    if (score > specificity && matches(override.selector, context)) {
      selected = override.expression;
      specificity = score;
    }
  }
  return selected;
}

/** Validate context defaults, values, and token override selectors. */
export function checkContexts(
  tokens: readonly TokenNode[],
  definition: ContextDefinition = {},
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [name, dimension] of Object.entries(definition)) {
    if (!dimension.values.includes(dimension.default)) {
      diagnostics.push({
        code: "TOKEN_CONTEXT_INVALID_DEFAULT",
        severity: "error",
        message: `Context \`${name}\` default \`${dimension.default}\` is not listed in its values`,
      });
    }
  }
  for (const token of tokens) {
    for (const override of token.overrides) {
      for (const [name, value] of Object.entries(override.selector)) {
        const dimension = definition[name];
        if (!dimension) {
          diagnostics.push({
            code: "TOKEN_CONTEXT_UNKNOWN_DIMENSION",
            severity: "error",
            message: `Unknown context dimension \`${name}\``,
            source: override.source,
          });
        } else if (!dimension.values.includes(value)) {
          diagnostics.push({
            code: "TOKEN_CONTEXT_UNKNOWN_VALUE",
            severity: "error",
            message: `Unknown value \`${value}\` for context \`${name}\``,
            source: override.source,
            suggestions: dimension.values,
          });
        }
      }
    }
  }
  return diagnostics;
}
