import type {
  CompilationContext,
  ContextOverride,
  ContextDefinition,
  Diagnostic,
  TokenExpression,
  TokenNode,
} from "./model.js";

export interface SelectedTokenExpression {
  readonly expression: TokenExpression;
  readonly source: TokenNode["source"];
  readonly selector?: CompilationContext;
  readonly precedence?: number;
  readonly origin?: ContextOverride["origin"];
}

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
    const difference = Number(dimension in left) - Number(dimension in right);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Select by explicit precedence, specificity, then configured dimension order. */
export function selectTokenExpression(
  token: TokenNode,
  context: CompilationContext,
  resolutionOrder: readonly string[] = Object.keys(context),
): TokenExpression {
  return selectTokenCandidate(token, context, resolutionOrder).expression;
}

/** Return the expression together with the semantic reason it won. */
export function selectTokenCandidate(
  token: TokenNode,
  context: CompilationContext,
  resolutionOrder: readonly string[] = Object.keys(context),
): SelectedTokenExpression {
  let selected: SelectedTokenExpression = {
    expression: token.value,
    source: token.source,
  };
  let selectedSelector: CompilationContext = {};
  let selectedPrecedence = Number.NEGATIVE_INFINITY;
  for (const override of token.overrides) {
    if (!matches(override.selector, context)) continue;
    const precedence = override.precedence ?? 0;
    if (
      precedence > selectedPrecedence ||
      (precedence === selectedPrecedence &&
        compareSelectors(override.selector, selectedSelector, resolutionOrder) > 0)
    ) {
      selected = {
        expression: override.expression,
        source: override.source,
        selector: override.selector,
        ...(override.precedence === undefined ? {} : { precedence: override.precedence }),
        ...(override.origin === undefined ? {} : { origin: override.origin }),
      };
      selectedSelector = override.selector;
      selectedPrecedence = precedence;
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
    const selectors = new Map<string, ContextOverride>();
    for (const override of token.overrides) {
      const selectorKey = contextKey(override.selector);
      const previous = selectors.get(selectorKey);
      if (previous) {
        diagnostics.push({
          code: "TOKEN_RESOLUTION_AMBIGUOUS",
          severity: "error",
          message: `Token \`${token.id}\` declares context selector \`${selectorKey}\` more than once`,
          source: override.source,
          related: [{ message: "First declared here", source: previous.source }],
        });
      } else selectors.set(selectorKey, override);
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
