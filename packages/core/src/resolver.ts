import { contextKey, defaultContext, selectTokenCandidate } from "./context.js";
import { TokenGraph } from "./graph.js";
import type {
  CompilationContext,
  ContextDefinition,
  ResolvedToken,
  ResolutionTrace,
  ResolutionTraceStep,
  TokenId,
  TokenLiteral,
} from "./model.js";
import { parseTokenId } from "./token-id.js";

/** Lazy, context-aware graph evaluator with selective cache invalidation. */
export class TokenResolver {
  readonly #graph: TokenGraph;
  readonly #contextDefinition: ContextDefinition;
  readonly #resolutionOrder: readonly string[];
  readonly #cache = new Map<string, ResolvedToken>();
  #computations = 0;

  constructor(
    graph: TokenGraph,
    contextDefinition: ContextDefinition = {},
    seed: Iterable<ResolvedToken> = [],
  ) {
    this.#graph = graph;
    this.#contextDefinition = contextDefinition;
    this.#resolutionOrder = Object.keys(contextDefinition);
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
    return this.#resolve(id, context);
  }

  #resolve(id: TokenId, context: CompilationContext): ResolvedToken | undefined {
    const suffix = `\0${contextKey(context)}`;
    const existing = this.#cache.get(`${id}${suffix}`);
    if (existing) return existing;
    const active = new Set<TokenId>();
    const path: {
      token: NonNullable<ReturnType<TokenGraph["getToken"]>>;
      expression: ReturnType<typeof selectTokenCandidate>["expression"];
    }[] = [];
    let current: TokenId | undefined = id;
    let value: TokenLiteral | undefined;
    while (current) {
      const cached = this.#cache.get(`${current}${suffix}`);
      if (cached) {
        value = cached.value;
        break;
      }
      const token = this.#graph.getToken(current);
      if (!token || active.has(current)) return undefined;
      active.add(current);
      const expression = selectTokenCandidate(token, context, this.#resolutionOrder).expression;
      path.push({ token, expression });
      if (expression.kind === "literal") {
        value = expression.value;
        break;
      }
      current = expression.target;
    }
    if (value === undefined) return undefined;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index];
      if (!entry) continue;
      const result: ResolvedToken = {
        id: entry.token.id,
        type: entry.token.type,
        expression: entry.expression,
        value,
        context,
        dependencies: entry.token.dependencies,
        source: entry.token.source,
      };
      this.#cache.set(`${entry.token.id}${suffix}`, result);
      this.#computations += 1;
    }
    return this.#cache.get(`${id}${suffix}`);
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

  /** Explain context selection and alias traversal without exposing resolver internals. */
  trace(id: TokenId, partialContext: CompilationContext = {}): ResolutionTrace | undefined {
    const context = { ...this.defaults, ...partialContext };
    if (!this.#graph.hasToken(id)) return undefined;
    const steps: ResolutionTraceStep[] = [];
    const active = new Set<TokenId>();
    let current: TokenId | undefined = id;
    while (current && !active.has(current)) {
      active.add(current);
      const token = this.#graph.getToken(current);
      if (!token) break;
      const selected = selectTokenCandidate(token, context, this.#resolutionOrder);
      steps.push({
        token: current,
        selection: selected.selector ? "override" : "base",
        expression: selected.expression,
        source: selected.source,
        ...(selected.selector ? { selector: selected.selector } : {}),
        ...(selected.precedence === undefined ? {} : { precedence: selected.precedence }),
        ...(selected.origin === undefined ? {} : { origin: selected.origin }),
      });
      current = selected.expression.kind === "reference" ? selected.expression.target : undefined;
    }
    const resolved = this.resolve(id, context);
    return {
      token: id,
      context,
      ...(steps[0] ? { selectedSource: steps[0].source } : {}),
      steps,
      resolverSteps: [],
      ...(resolved ? { value: resolved.value } : {}),
    };
  }
}
