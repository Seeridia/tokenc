import type { TokenSourceInput } from "./loader.js";
import type { CompilationSnapshot } from "./snapshot.js";

type SnapshotRecompiler = (sources: readonly TokenSourceInput[]) => Promise<CompilationSnapshot>;

const recompilers = new WeakMap<CompilationSnapshot, SnapshotRecompiler>();

export function registerSnapshotRecompiler(
  snapshot: CompilationSnapshot,
  recompile: SnapshotRecompiler,
): void {
  recompilers.set(snapshot, recompile);
}

export function recompileSnapshot(
  snapshot: CompilationSnapshot,
  sources: readonly TokenSourceInput[],
): Promise<CompilationSnapshot> | undefined {
  return recompilers.get(snapshot)?.(sources);
}
