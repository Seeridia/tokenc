import type { TokenBackend } from "./backend.js";
import { CompilationSnapshotBuilder, compileDocumentsInternal } from "./compiler.js";
import type { LoadedDocument } from "./loader.js";
import type { CompilationContext, ContextDefinition } from "./model.js";
import {
  createCompilerSession,
  type CompilerSessionConfiguration,
  type DocumentChange,
  type SessionTransaction,
} from "./session.js";
import type { CompilationSnapshot } from "./snapshot.js";

export interface DifferentialOracleStep {
  readonly transaction: SessionTransaction;
  readonly backends?: readonly TokenBackend[];
}

export interface DifferentialOracleOptions {
  readonly documents?: readonly LoadedDocument[];
  readonly config?: CompilerSessionConfiguration;
  readonly backends?: readonly TokenBackend[];
  readonly steps: readonly DifferentialOracleStep[];
  /** Bounds full Context enumeration in test fixtures. Defaults to 256. */
  readonly contextLimit?: number;
}

export interface DifferentialOracleStepResult {
  readonly index: number;
  readonly matches: boolean;
  readonly session: string;
  readonly cold: string;
}

export interface DifferentialOracleResult {
  readonly matches: boolean;
  readonly steps: readonly DifferentialOracleStepResult[];
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function enumerateContexts(
  definition: ContextDefinition,
  limit: number,
): readonly CompilationContext[] {
  let contexts: readonly CompilationContext[] = [{}];
  for (const [name, dimension] of Object.entries(definition)) {
    if (contexts.length * dimension.values.length > limit)
      throw new RangeError(`Differential Context enumeration exceeds limit ${limit}`);
    contexts = contexts.flatMap((context) =>
      dimension.values.map((value) => Object.assign({}, context, { [name]: value })),
    );
  }
  return contexts;
}

async function normalizedSnapshot(
  snapshot: CompilationSnapshot,
  config: CompilerSessionConfiguration,
  backends: readonly TokenBackend[],
  contextLimit: number,
): Promise<string> {
  const ids = snapshot.query.completions();
  const graph = snapshot.query.graph();
  const operation = snapshot.status === "valid" ? await snapshot.emit(backends) : undefined;
  const contexts = enumerateContexts(
    snapshot.status === "valid" ? snapshot.ir.contexts : (config.contexts ?? {}),
    contextLimit,
  );
  return stableJson({
    status: snapshot.status,
    documents: snapshot.documents,
    diagnostics: snapshot.diagnostics,
    stats: {
      tokens: snapshot.stats.tokens,
      references: snapshot.stats.references,
      contexts: snapshot.stats.contexts,
      contextCycles: snapshot.stats.contextCycles,
    },
    ids,
    graph,
    resolved:
      snapshot.status === "valid"
        ? contexts.flatMap((context) =>
            ids.map((id) => ({ context, id, value: snapshot.query.resolve(id, context) })),
          )
        : [],
    traces:
      snapshot.status === "valid"
        ? contexts.flatMap((context) =>
            ids.map((id) => ({ context, id, trace: snapshot.query.explain(id, context) })),
          )
        : [],
    backend: operation
      ? {
          success: operation.success,
          diagnostics: operation.diagnostics,
          outputs: operation.outputs,
        }
      : null,
  });
}

function directDocument(change: DocumentChange): LoadedDocument | undefined {
  if (change.kind === "remove" || !change.document) return undefined;
  return change.document;
}

function applyReferenceChanges(
  documents: Map<string, LoadedDocument>,
  changes: readonly DocumentChange[],
): void {
  for (const change of changes) {
    if (change.kind === "remove") {
      documents.delete(change.identity);
      continue;
    }
    const document = directDocument(change);
    if (!document)
      throw new TypeError("Differential oracle steps require loaded documents, not requests");
    documents.set(document.identity, document);
  }
}

function sources(documents: ReadonlyMap<string, LoadedDocument>) {
  return [...documents.values()].map((document) =>
    document.origin
      ? { file: document.identity, content: document.content, origin: document.origin }
      : { file: document.identity, content: document.content },
  );
}

function cloneConfiguration(config: CompilerSessionConfiguration): CompilerSessionConfiguration {
  const { backends, ...semantic } = config;
  return {
    ...structuredClone(semantic),
    ...(backends ? { backends: [...backends] } : {}),
  };
}

/** Compare every Session transaction with a fresh uncached compilation of the same state. */
export async function runCompilationDifferentialOracle(
  options: DifferentialOracleOptions,
): Promise<DifferentialOracleResult> {
  const contextLimit = options.contextLimit ?? 256;
  const documents = new Map(
    (options.documents ?? []).map((document) => [document.identity, document]),
  );
  let config = cloneConfiguration(options.config ?? {});
  const session = createCompilerSession({ config });
  const results: DifferentialOracleStepResult[] = [];
  try {
    if (documents.size > 0)
      await session.apply({
        documents: [...documents.values()].map((document) => ({ kind: "add", document })),
      });
    for (const [index, step] of options.steps.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Transactions must be observed in FIFO order.
      const snapshot = await session.apply(step.transaction);
      applyReferenceChanges(documents, step.transaction.documents ?? []);
      config = cloneConfiguration(step.transaction.config ?? config);
      if (step.transaction.resolverInput)
        config = { ...config, resolverInput: { ...step.transaction.resolverInput } };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each cold build is the oracle for the preceding transaction.
      const build = await compileDocumentsInternal(sources(documents), config);
      const cold = new CompilationSnapshotBuilder().publish(build, config);
      const backends = step.backends ?? config.backends ?? options.backends ?? [];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Normalization belongs to this ordered oracle step.
      const [sessionValue, coldValue] = await Promise.all([
        normalizedSnapshot(snapshot, config, backends, contextLimit),
        normalizedSnapshot(cold, config, backends, contextLimit),
      ]);
      results.push(
        Object.freeze({
          index,
          matches: sessionValue === coldValue,
          session: sessionValue,
          cold: coldValue,
        }),
      );
    }
  } finally {
    await session.close();
  }
  return Object.freeze({
    matches: results.every((result) => result.matches),
    steps: Object.freeze(results),
  });
}

/** Throw with the first normalized mismatch while retaining a reusable non-asserting runner. */
export async function assertCompilationDifferential(
  options: DifferentialOracleOptions,
): Promise<DifferentialOracleResult> {
  const result = await runCompilationDifferentialOracle(options);
  const mismatch = result.steps.find((step) => !step.matches);
  if (mismatch)
    throw new Error(
      `Compilation differential mismatch at step ${mismatch.index}:\nsession=${mismatch.session}\ncold=${mismatch.cold}`,
    );
  return result;
}
