import type { ImpactAnalysis, TokenId, TokenNode } from "./model.js";

function canonicalCycle(cycle: readonly TokenId[]): string {
  const body = cycle.slice(0, -1).map(String);
  const rotations = body.map((_, index) =>
    [...body.slice(index), ...body.slice(0, index)].join("\0"),
  );
  return rotations.toSorted()[0] ?? "";
}

/** Directed token dependency graph with O(1) node and adjacency lookup. */
export class TokenGraph {
  readonly #tokens = new Map<TokenId, TokenNode>();
  readonly #forward = new Map<TokenId, Set<TokenId>>();
  readonly #reverse = new Map<TokenId, Set<TokenId>>();

  constructor(tokens: Iterable<TokenNode> = []) {
    for (const token of tokens) this.#tokens.set(token.id, token);
    for (const token of this.#tokens.values()) {
      this.#forward.set(token.id, new Set(token.dependencies));
      if (!this.#reverse.has(token.id)) this.#reverse.set(token.id, new Set());
      for (const dependency of token.dependencies) {
        const dependents = this.#reverse.get(dependency) ?? new Set<TokenId>();
        dependents.add(token.id);
        this.#reverse.set(dependency, dependents);
      }
    }
  }

  get size(): number {
    return this.#tokens.size;
  }
  get tokens(): readonly TokenNode[] {
    return [...this.#tokens.values()];
  }
  getToken(id: TokenId): TokenNode | undefined {
    return this.#tokens.get(id);
  }
  hasToken(id: TokenId): boolean {
    return this.#tokens.has(id);
  }
  getDependencies(id: TokenId): readonly TokenId[] {
    return [...(this.#forward.get(id) ?? [])];
  }
  getDependents(id: TokenId): readonly TokenId[] {
    return [...(this.#reverse.get(id) ?? [])];
  }

  /** Dependencies always precede their consumers. Cycles are omitted from guarantees. */
  topologicalSort(): readonly TokenId[] {
    const memo = new Map<TokenId, number>();
    const active = new Set<TokenId>();
    const depth = (id: TokenId): number => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (active.has(id)) return 0;
      active.add(id);
      const dependencies = this.getDependencies(id).filter((dependency) =>
        this.hasToken(dependency),
      );
      const value = dependencies.length === 0 ? 0 : Math.max(...dependencies.map(depth)) + 1;
      active.delete(id);
      memo.set(id, value);
      return value;
    };
    return [...this.#tokens.keys()].toSorted(
      (left, right) => depth(left) - depth(right) || String(left).localeCompare(String(right)),
    );
  }

  /** Return closed cycle paths, with the first ID repeated at the end. */
  detectCycles(): readonly (readonly TokenId[])[] {
    const state = new Map<TokenId, 0 | 1 | 2>();
    const stack: TokenId[] = [];
    const cycles: TokenId[][] = [];
    const signatures = new Set<string>();
    const visit = (id: TokenId): void => {
      state.set(id, 1);
      stack.push(id);
      for (const dependency of this.getDependencies(id)) {
        if (!this.hasToken(dependency)) continue;
        if ((state.get(dependency) ?? 0) === 0) visit(dependency);
        else if (state.get(dependency) === 1) {
          const start = stack.lastIndexOf(dependency);
          const cycle = [...stack.slice(start), dependency];
          const signature = canonicalCycle(cycle);
          if (!signatures.has(signature)) {
            signatures.add(signature);
            cycles.push(cycle);
          }
        }
      }
      stack.pop();
      state.set(id, 2);
    };
    for (const id of this.#tokens.keys()) if ((state.get(id) ?? 0) === 0) visit(id);
    return cycles;
  }

  /** Changed nodes plus every transitive reverse dependency. */
  getAffectedTokens(changedTokenIds: Iterable<TokenId>): ReadonlySet<TokenId> {
    const affected = new Set<TokenId>();
    const queue = [...changedTokenIds];
    for (const id of queue) affected.add(id);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      for (const dependent of this.getDependents(current)) {
        if (!affected.has(dependent)) {
          affected.add(dependent);
          queue.push(dependent);
        }
      }
    }
    return affected;
  }

  analyzeImpact(changedTokenIds: Iterable<TokenId>): ImpactAnalysis {
    const changed = [...new Set(changedTokenIds)];
    const changedSet = new Set(changed);
    const directlyAffected = [...new Set(changed.flatMap((id) => this.getDependents(id)))].filter(
      (id) => !changedSet.has(id),
    );
    const directSet = new Set(directlyAffected);
    const indirectlyAffected = [...this.getAffectedTokens(changed)].filter(
      (id) => !changedSet.has(id) && !directSet.has(id),
    );
    return { changed, directlyAffected, indirectlyAffected };
  }
}
