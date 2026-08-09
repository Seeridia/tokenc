import { contextKey, defaultContext, selectTokenExpression } from "./context.js";
import { TokenGraph } from "./graph.js";
import type {
  CompilationContext,
  ContextDefinition,
  ResolvedToken,
  TokenId,
  TokenLiteral,
} from "./model.js";
import { parseTokenId } from "./token-id.js";

/** Lazy, context-aware graph evaluator with selective cache invalidation. */
export class TokenResolver {
  readonly #graph: TokenGraph;
  readonly #contextDefinition: ContextDefinition;
  readonly #cache = new Map<string, ResolvedToken>();
  #computations = 0;

  constructor(
    graph: TokenGraph,
    contextDefinition: ContextDefinition = {},
    seed: Iterable<ResolvedToken> = [],
  ) {
    this.#graph = graph;
    this.#contextDefinition = contextDefinition;
    for (const token of seed) this.#cache.set(`${token.id}\0${contextKey(token.context)}`, token);
  }

  get computations(): number {
    return this.#computations;
  }
  get defaults(): CompilationContext {
    return defaultContext(this.#contextDefinition);
  }

  resolve(id: TokenId, partialContext: CompilationContext = {}): ResolvedToken | undefined {
    const context = { ...this.defaults, ...partialContext };
    return this.#resolve(id, context, new Set());
  }

  #resolve(
    id: TokenId,
    context: CompilationContext,
    active: Set<TokenId>,
  ): ResolvedToken | undefined {
    const cacheKey = `${id}\0${contextKey(context)}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) return cached;
    const token = this.#graph.getToken(id);
    if (!token || active.has(id)) return undefined;
    active.add(id);
    const expression = selectTokenExpression(token, context);
    let value: TokenLiteral | undefined;
    if (expression.kind === "literal") value = expression.value;
    else value = this.#resolve(expression.target, context, active)?.value;
    active.delete(id);
    if (value === undefined) return undefined;
    const result: ResolvedToken = {
      id,
      type: token.type,
      expression,
      value,
      context,
      dependencies: token.dependencies,
      source: token.source,
    };
    this.#cache.set(cacheKey, result);
    this.#computations += 1;
    return result;
  }

  invalidate(ids: ReadonlySet<TokenId>): void {
    for (const key of this.#cache.keys()) {
      const boundary = key.indexOf("\0");
      if (ids.has(parseTokenId(key.slice(0, boundary)))) this.#cache.delete(key);
    }
  }

  /** Snapshot cached evaluations so an incremental compiler can retain unaffected work. */
  snapshot(): readonly ResolvedToken[] {
    return [...this.#cache.values()];
  }
}
