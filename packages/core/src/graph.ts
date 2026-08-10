import type { ImpactAnalysis, TokenId, TokenNode } from "./model.js";

export interface TokenGraphPatch {
  readonly added?: readonly TokenNode[];
  readonly changed?: readonly TokenNode[];
  readonly removed?: readonly TokenId[];
}

export interface TokenGraphDelta {
  readonly added: readonly TokenId[];
  readonly changed: readonly TokenId[];
  readonly removed: readonly TokenId[];
  readonly affected: ReadonlySet<TokenId>;
  readonly touchedNodes: number;
  readonly touchedEdges: number;
}

function canonicalCycle(cycle: readonly TokenId[]): string {
  const body = cycle.slice(0, -1).map(String);
  const rotations = body.map((_, index) =>
    [...body.slice(index), ...body.slice(0, index)].join("\0"),
  );
  return rotations.toSorted()[0] ?? "";
}

class StableTokenQueue {
  readonly #heap: TokenId[] = [];

  get size(): number {
    return this.#heap.length;
  }

  push(id: TokenId): void {
    this.#heap.push(id);
    let index = this.#heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.#heap[parent];
      if (!parentValue || String(parentValue).localeCompare(String(id)) <= 0) break;
      this.#heap[index] = parentValue;
      index = parent;
    }
    this.#heap[index] = id;
  }

  take(): TokenId | undefined {
    const first = this.#heap[0];
    const last = this.#heap.pop();
    if (!first || !last || this.#heap.length === 0) return first;
    this.#heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        this.#heap[left] &&
        String(this.#heap[left]).localeCompare(String(this.#heap[smallest])) < 0
      )
        smallest = left;
      if (
        this.#heap[right] &&
        String(this.#heap[right]).localeCompare(String(this.#heap[smallest])) < 0
      )
        smallest = right;
      if (smallest === index) break;
      const value = this.#heap[index];
      const next = this.#heap[smallest];
      if (!value || !next) break;
      this.#heap[index] = next;
      this.#heap[smallest] = value;
      index = smallest;
    }
    return first;
  }
}

/** Directed token dependency graph with O(1) node and adjacency lookup. */
export class TokenGraph {
  readonly #tokens = new Map<TokenId, TokenNode>();
  readonly #forward = new Map<TokenId, Set<TokenId>>();
  readonly #reverse = new Map<TokenId, Set<TokenId>>();
  #revision = 0;

  constructor(tokens: Iterable<TokenNode> = []) {
    for (const token of tokens) this.#tokens.set(token.id, token);
    for (const token of this.#tokens.values()) this.#addEdges(token);
  }

  get size(): number {
    return this.#tokens.size;
  }
  get revision(): number {
    return this.#revision;
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

  /** Stable Kahn ordering. Dependencies precede consumers outside cyclic regions. */
  topologicalSort(): readonly TokenId[] {
    const inDegree = new Map<TokenId, number>();
    for (const id of this.#tokens.keys())
      inDegree.set(
        id,
        this.getDependencies(id).filter((dependency) => this.hasToken(dependency)).length,
      );
    const ready = new StableTokenQueue();
    for (const [id, degree] of inDegree) if (degree === 0) ready.push(id);
    const result: TokenId[] = [];
    while (ready.size > 0) {
      const id = ready.take();
      if (!id) continue;
      result.push(id);
      for (const dependent of this.getDependents(id)) {
        if (!this.hasToken(dependent)) continue;
        const degree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, degree);
        if (degree === 0) {
          ready.push(dependent);
        }
      }
    }
    if (result.length < this.size) {
      const emitted = new Set(result);
      result.push(
        ...[...this.#tokens.keys()]
          .filter((id) => !emitted.has(id))
          .toSorted((left, right) => String(left).localeCompare(String(right))),
      );
    }
    return result;
  }

  /** Patch nodes and adjacency indexes while preserving unaffected map/set identity. */
  patch(patch: TokenGraphPatch): TokenGraphDelta {
    const added = [...new Set((patch.added ?? []).map((token) => token.id))];
    const changed = [...new Set((patch.changed ?? []).map((token) => token.id))];
    const removed = [...new Set(patch.removed ?? [])];
    const touchedIds = new Set([...added, ...changed, ...removed]);
    const before = this.getAffectedTokens(touchedIds);
    let touchedEdges = 0;

    for (const id of [...removed, ...changed]) {
      const previous = this.#tokens.get(id);
      if (!previous) continue;
      touchedEdges += previous.dependencies.length;
      this.#removeEdges(previous);
      this.#tokens.delete(id);
      this.#forward.delete(id);
      if (this.#reverse.get(id)?.size === 0) this.#reverse.delete(id);
    }
    for (const token of [...(patch.added ?? []), ...(patch.changed ?? [])]) {
      const existing = this.#tokens.get(token.id);
      if (existing) {
        touchedEdges += existing.dependencies.length;
        this.#removeEdges(existing);
      }
      this.#tokens.set(token.id, token);
      this.#addEdges(token);
      touchedEdges += token.dependencies.length;
    }
    const affected = new Set([...before, ...this.getAffectedTokens(touchedIds)]);
    if (touchedIds.size > 0) this.#revision += 1;
    return {
      added,
      changed,
      removed,
      affected,
      touchedNodes: touchedIds.size,
      touchedEdges,
    };
  }

  #addEdges(token: TokenNode): void {
    this.#forward.set(token.id, new Set(token.dependencies));
    if (!this.#reverse.has(token.id)) this.#reverse.set(token.id, new Set());
    for (const dependency of token.dependencies) {
      const dependents = this.#reverse.get(dependency) ?? new Set<TokenId>();
      dependents.add(token.id);
      this.#reverse.set(dependency, dependents);
    }
  }

  #removeEdges(token: TokenNode): void {
    for (const dependency of token.dependencies) {
      const dependents = this.#reverse.get(dependency);
      dependents?.delete(token.id);
      if (dependents?.size === 0 && !this.#tokens.has(dependency)) this.#reverse.delete(dependency);
    }
  }

  /** Return closed cycle paths, with the first ID repeated at the end. */
  detectCycles(roots?: Iterable<TokenId>): readonly (readonly TokenId[])[] {
    const state = new Map<TokenId, 0 | 1 | 2>();
    const cycles: TokenId[][] = [];
    const signatures = new Set<string>();
    const path: TokenId[] = [];
    const positions = new Map<TokenId, number>();
    for (const root of roots ?? this.#tokens.keys()) {
      if (!this.hasToken(root) || (state.get(root) ?? 0) !== 0) continue;
      const stack: { id: TokenId; dependencies: readonly TokenId[]; index: number }[] = [
        { id: root, dependencies: this.getDependencies(root), index: 0 },
      ];
      state.set(root, 1);
      positions.set(root, path.length);
      path.push(root);
      while (stack.length > 0) {
        const frame = stack.at(-1);
        if (!frame) break;
        const dependency = frame.dependencies[frame.index];
        if (dependency) {
          frame.index += 1;
          if (!this.hasToken(dependency)) continue;
          const dependencyState = state.get(dependency) ?? 0;
          if (dependencyState === 0) {
            state.set(dependency, 1);
            positions.set(dependency, path.length);
            path.push(dependency);
            stack.push({
              id: dependency,
              dependencies: this.getDependencies(dependency),
              index: 0,
            });
          } else if (dependencyState === 1) {
            const start = positions.get(dependency) ?? 0;
            const cycle = [...path.slice(start), dependency];
            const signature = canonicalCycle(cycle);
            if (!signatures.has(signature)) {
              signatures.add(signature);
              cycles.push(cycle);
            }
          }
          continue;
        }
        stack.pop();
        state.set(frame.id, 2);
        positions.delete(frame.id);
        path.pop();
      }
    }
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

  /** Root nodes plus every transitive forward dependency. */
  getDependencyClosure(rootTokenIds: Iterable<TokenId>): ReadonlySet<TokenId> {
    const closure = new Set<TokenId>();
    const queue = [...rootTokenIds];
    for (const id of queue) closure.add(id);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      for (const dependency of this.getDependencies(current)) {
        if (!closure.has(dependency)) {
          closure.add(dependency);
          queue.push(dependency);
        }
      }
    }
    return closure;
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
