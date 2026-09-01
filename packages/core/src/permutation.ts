import {
  emitBackendPlans,
  type BackendEmissionResult,
  type BackendPreparationResult,
  type TokenBackend,
} from "./backend.js";
import { createDiagnostic } from "./diagnostic.js";
import type { ResolverDocument, ResolverModifier } from "./dtcg/resolver-document.js";
import type { CompilationContext, Diagnostic } from "./model.js";
import type { CompilerSession, SessionMetrics } from "./session.js";
import {
  compareSnapshots,
  type SnapshotComparisonOptions,
  type SnapshotDiffV1,
} from "./snapshot-diff.js";
import type { CompilationSnapshot } from "./snapshot.js";

export interface ResolverPermutationDimensionV1 {
  readonly name: string;
  readonly values: readonly string[];
  readonly default?: string;
}

export interface ResolverPermutationV1 {
  readonly index: number;
  readonly key: string;
  readonly context: CompilationContext;
}

export interface ResolverPermutationPlanOptions {
  readonly filters?: CompilationContext;
  readonly limit?: number;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function contextKey(context: CompilationContext): string {
  return JSON.stringify(
    Object.entries(context).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function orderedModifiers(document: ResolverDocument): readonly ResolverModifier[] {
  const seen = new Set<string>();
  const ordered: ResolverModifier[] = [];
  for (const item of document.resolutionOrder) {
    if (item.kind !== "modifier" || seen.has(item.name)) continue;
    seen.add(item.name);
    ordered.push(item);
  }
  for (const modifier of [...document.modifiers.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (seen.has(modifier.name)) continue;
    seen.add(modifier.name);
    ordered.push(modifier);
  }
  return ordered;
}

function dimension(modifier: ResolverModifier): ResolverPermutationDimensionV1 {
  const values = Object.keys(modifier.contexts).toSorted();
  const ordered = modifier.default
    ? [modifier.default, ...values.filter((value) => value !== modifier.default)]
    : values;
  return deepFreeze({
    name: modifier.name,
    values: Object.freeze(ordered),
    ...(modifier.default ? { default: modifier.default } : {}),
  });
}

function countPermutations(dimensions: readonly ResolverPermutationDimensionV1[]): {
  readonly value: number;
  readonly saturated: boolean;
} {
  let count = 1;
  for (const item of dimensions) {
    if (item.values.length === 0) return { value: 0, saturated: false };
    if (count > Math.floor(Number.MAX_SAFE_INTEGER / item.values.length))
      return { value: Number.MAX_SAFE_INTEGER, saturated: true };
    count *= item.values.length;
  }
  return { value: count, saturated: false };
}

function* enumerate(
  dimensions: readonly ResolverPermutationDimensionV1[],
  index: number,
  current: Readonly<Record<string, string>>,
  state: { index: number },
): Generator<ResolverPermutationV1> {
  const item = dimensions[index];
  if (!item) {
    const context = Object.freeze({ ...current });
    yield deepFreeze({ index: state.index, key: contextKey(context), context });
    state.index += 1;
    return;
  }
  for (const value of item.values)
    yield* enumerate(dimensions, index + 1, { ...current, [item.name]: value }, state);
}

/** Immutable permutation metadata with a fresh lazy iterator for each traversal. */
export class ResolverPermutationPlanV1 implements Iterable<ResolverPermutationV1> {
  readonly schemaVersion = "1" as const;
  readonly status: "ready" | "invalid";
  readonly dimensions: readonly ResolverPermutationDimensionV1[];
  readonly filters: CompilationContext;
  readonly estimatedCount: number;
  readonly estimateSaturated: boolean;
  readonly limit?: number;
  readonly diagnostics: readonly Diagnostic[];

  constructor(init: {
    readonly status: "ready" | "invalid";
    readonly dimensions: readonly ResolverPermutationDimensionV1[];
    readonly filters: CompilationContext;
    readonly estimatedCount: number;
    readonly estimateSaturated: boolean;
    readonly limit?: number;
    readonly diagnostics: readonly Diagnostic[];
  }) {
    this.status = init.status;
    this.dimensions = init.dimensions;
    this.filters = init.filters;
    this.estimatedCount = init.estimatedCount;
    this.estimateSaturated = init.estimateSaturated;
    if (init.limit !== undefined) this.limit = init.limit;
    this.diagnostics = init.diagnostics;
    Object.freeze(this);
  }

  *[Symbol.iterator](): Iterator<ResolverPermutationV1> {
    if (this.status === "invalid") return;
    yield* enumerate(this.dimensions, 0, {}, { index: 0 });
  }
}

/** Plan exact Resolver modifier combinations without materializing their Cartesian product. */
export function planResolverPermutations(
  document: ResolverDocument,
  options: ResolverPermutationPlanOptions = {},
): ResolverPermutationPlanV1 {
  const diagnostics: Diagnostic[] = [];
  const filters = Object.freeze(
    Object.fromEntries(
      Object.entries(options.filters ?? {}).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
  const known = new Map(orderedModifiers(document).map((modifier) => [modifier.name, modifier]));
  for (const [name, value] of Object.entries(filters)) {
    const modifier = known.get(name);
    if (!modifier) {
      diagnostics.push(
        createDiagnostic({
          code: "RESOLVER_PERMUTATION_UNKNOWN_FILTER",
          message: `Unknown Resolver permutation filter: ${name}`,
          parameters: { dimension: name },
        }),
      );
      continue;
    }
    if (!Object.hasOwn(modifier.contexts, value))
      diagnostics.push(
        createDiagnostic({
          code: "RESOLVER_PERMUTATION_INVALID_FILTER",
          message: `Invalid Resolver permutation value \`${value}\` for \`${name}\``,
          parameters: { dimension: name, value },
          source: modifier.source,
        }),
      );
  }
  const dimensions = Object.freeze(
    [...known.values()].map((modifier) => {
      const planned = dimension(modifier);
      const selected = filters[modifier.name];
      return selected && planned.values.includes(selected)
        ? deepFreeze({ ...planned, values: Object.freeze([selected]) })
        : planned;
    }),
  );
  const estimate = countPermutations(dimensions);
  const limit = options.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    diagnostics.push(
      createDiagnostic({
        code: "RESOLVER_PERMUTATION_INVALID_LIMIT",
        message: "Resolver permutation limit must be a positive safe integer",
        parameters: { limit: typeof limit === "number" && Number.isFinite(limit) ? limit : -1 },
      }),
    );
  else if (estimate.value > 1 && limit === undefined)
    diagnostics.push(
      createDiagnostic({
        code: "RESOLVER_PERMUTATION_LIMIT_REQUIRED",
        message: `Resolver permutation enumeration requires a limit for ${estimate.saturated ? "at least " : ""}${estimate.value} combinations`,
        parameters: { estimatedCount: estimate.value },
      }),
    );
  else if (limit !== undefined && estimate.value > limit)
    diagnostics.push(
      createDiagnostic({
        code: "RESOLVER_PERMUTATION_LIMIT_EXCEEDED",
        message: `Resolver permutation estimate ${estimate.value} exceeds limit ${limit}`,
        parameters: { limit, estimatedCount: estimate.value },
      }),
    );
  return new ResolverPermutationPlanV1({
    status: diagnostics.length === 0 ? "ready" : "invalid",
    dimensions,
    filters,
    estimatedCount: estimate.value,
    estimateSaturated: estimate.saturated,
    ...(limit === undefined ? {} : { limit }),
    diagnostics: Object.freeze(diagnostics),
  });
}

export interface ResolverPermutationCompilationV1 {
  readonly permutation: ResolverPermutationV1;
  readonly snapshot: CompilationSnapshot;
  readonly metrics?: SessionMetrics;
  readonly preparation?: BackendPreparationResult;
  readonly emission?: BackendEmissionResult;
}

export interface ResolverPermutationBatchV1 {
  readonly schemaVersion: "1";
  readonly status: "complete" | "incomplete";
  readonly plan: ResolverPermutationPlanV1;
  readonly entries: readonly ResolverPermutationCompilationV1[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface CompileResolverPermutationsOptions {
  readonly backends?: readonly TokenBackend[];
  readonly emit?: boolean;
}

function collisionKey(path: string): string {
  return path.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

function batchCollisionDiagnostics(
  entries: readonly ResolverPermutationCompilationV1[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const owners = new Map<string, { path: string; context: string }>();
  for (const entry of entries) {
    for (const plan of entry.preparation?.plans ?? []) {
      for (const artifact of plan.artifacts) {
        const key = collisionKey(artifact.path);
        const previous = owners.get(key);
        if (!previous) {
          owners.set(key, { path: artifact.path, context: entry.permutation.key });
          continue;
        }
        if (previous.context === entry.permutation.key) continue;
        diagnostics.push(
          createDiagnostic({
            code: "RESOLVER_PERMUTATION_OUTPUT_COLLISION",
            message: `Artifact \`${artifact.path}\` is shared by Resolver permutations ${previous.context} and ${entry.permutation.key}`,
            parameters: {
              path: previous.path,
              firstContext: previous.context,
              secondContext: entry.permutation.key,
            },
          }),
        );
      }
    }
  }
  return Object.freeze(diagnostics);
}

function compilationEntry(
  permutation: ResolverPermutationV1,
  snapshot: CompilationSnapshot,
  metrics: SessionMetrics | undefined,
  preparation: BackendPreparationResult | undefined,
  emission?: BackendEmissionResult,
): ResolverPermutationCompilationV1 {
  return deepFreeze({
    permutation,
    snapshot,
    ...(metrics ? { metrics } : {}),
    ...(preparation ? { preparation } : {}),
    ...(emission ? { emission } : {}),
  });
}

/** Compile selected permutations through one Session and preflight every Backend before any emit. */
export async function compileResolverPermutations(
  session: CompilerSession,
  plan: ResolverPermutationPlanV1,
  options: CompileResolverPermutationsOptions = {},
): Promise<ResolverPermutationBatchV1> {
  if (plan.status === "invalid")
    return deepFreeze({
      schemaVersion: "1",
      status: "incomplete",
      plan,
      entries: [],
      diagnostics: plan.diagnostics,
    });
  const backends = options.backends ?? session.backends;
  const entries: ResolverPermutationCompilationV1[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const permutation of plan) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One Session intentionally processes permutations serially.
    const snapshot = await session.apply({ resolverInput: permutation.context });
    let preparation: BackendPreparationResult | undefined;
    if (snapshot.status === "valid" && backends.length > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- All plans must exist before any batch emission.
      preparation = await snapshot.prepare(backends);
    }
    diagnostics.push(...snapshot.diagnostics, ...(preparation?.diagnostics ?? []));
    entries.push(compilationEntry(permutation, snapshot, session.metrics, preparation));
  }
  const collisions = batchCollisionDiagnostics(entries);
  diagnostics.push(...collisions);
  const canEmit =
    options.emit === true &&
    diagnostics.every((diagnostic) => diagnostic.severity !== "error") &&
    entries.every(
      (entry) => entry.snapshot.status === "valid" && entry.preparation?.success !== false,
    );
  if (canEmit) {
    for (const [index, current] of entries.entries()) {
      if (!current.preparation) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Deterministic emission follows complete batch preflight.
      const emission = await emitBackendPlans(backends, current.preparation);
      entries[index] = compilationEntry(
        current.permutation,
        current.snapshot,
        current.metrics,
        current.preparation,
        emission,
      );
    }
  }
  const status =
    diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    entries.some((entry) => entry.snapshot.status === "invalid")
      ? "incomplete"
      : "complete";
  return deepFreeze({
    schemaVersion: "1",
    status,
    plan,
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  });
}

export interface ResolverPermutationComparisonV1 {
  readonly permutation: ResolverPermutationV1;
  readonly diff: SnapshotDiffV1;
  readonly baseMetrics?: SessionMetrics;
  readonly headMetrics?: SessionMetrics;
}

export interface ResolverPermutationComparisonBatchV1 {
  readonly schemaVersion: "1";
  readonly status: "complete" | "incomplete";
  readonly plan: ResolverPermutationPlanV1;
  readonly comparisons: readonly ResolverPermutationComparisonV1[];
}

/** Compile and compare matching base/head permutations through the public Snapshot Diff API. */
export async function compareResolverPermutations(
  baseSession: CompilerSession,
  headSession: CompilerSession,
  plan: ResolverPermutationPlanV1,
  options: Omit<SnapshotComparisonOptions, "context"> = {},
): Promise<ResolverPermutationComparisonBatchV1> {
  if (plan.status === "invalid")
    return deepFreeze({ schemaVersion: "1", status: "incomplete", plan, comparisons: [] });
  const comparisons: ResolverPermutationComparisonV1[] = [];
  for (const permutation of plan) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each side reuses its own ordered Session cache.
    const [base, head] = await Promise.all([
      baseSession.apply({ resolverInput: permutation.context }),
      headSession.apply({ resolverInput: permutation.context }),
    ]);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Stable comparison ordering follows the plan.
    const diff = await compareSnapshots(base, head, { ...options, context: permutation.context });
    comparisons.push(
      deepFreeze({
        permutation,
        diff,
        ...(baseSession.metrics ? { baseMetrics: baseSession.metrics } : {}),
        ...(headSession.metrics ? { headMetrics: headSession.metrics } : {}),
      }),
    );
  }
  return deepFreeze({
    schemaVersion: "1",
    status: comparisons.every((entry) => entry.diff.status === "complete")
      ? "complete"
      : "incomplete",
    plan,
    comparisons: Object.freeze(comparisons),
  });
}
