import {
  createCompilerSession,
  parseTokenId,
  type CompilationSnapshot,
  type CompilerSession,
  type DocumentLoader,
  type TokenSourceInput,
  type ValidCompilationSnapshot,
} from "@tokenc/core";

import {
  LAYERED_CONTEXTS,
  LAYERED_REFERENCE_COUNT,
  LAYERED_TOKEN_COUNT,
  layeredSources,
} from "./fixtures/change-intelligence/layered.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkFixtureKind,
  BenchmarkFixtureMetadata,
  BenchmarkInvocation,
  BenchmarkRunResult,
} from "./types.js";

interface FixtureDescriptorInput {
  readonly kind: BenchmarkFixtureKind;
  readonly version: string;
  readonly description: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly parameters?: Readonly<Record<string, boolean | number | string>>;
}

type FixtureDescriptor = (input: FixtureDescriptorInput) => BenchmarkFixtureMetadata;

function singleUse(run: () => Promise<BenchmarkRunResult>): BenchmarkInvocation {
  let used = false;
  return {
    async run() {
      if (used) throw new Error("Benchmark invocation has already run");
      used = true;
      return run();
    },
  };
}

function document(input: TokenSourceInput) {
  return { identity: input.file, content: input.content };
}

function fixtureFiles(sources: readonly TokenSourceInput[]) {
  return sources.map((source) => ({
    path: source.file.replace(/^\/benchmark\//u, ""),
    content: source.content,
  }));
}

function revisionFiles(label: "base" | "head", sources: readonly TokenSourceInput[]) {
  return fixtureFiles(sources).map((file) => ({
    path: `${label}/${file.path}`,
    content: file.content,
  }));
}

function requireValid(snapshot: CompilationSnapshot, operation: string): ValidCompilationSnapshot {
  if (snapshot.status !== "valid") throw new Error(`${operation} must produce a valid Snapshot`);
  return snapshot;
}

function requireSessionMetrics(session: CompilerSession) {
  if (!session.metrics) throw new Error("Editor-loop benchmark requires Session metrics");
  return session.metrics;
}

function queryRepresentativeFacts(snapshot: ValidCompilationSnapshot): number {
  const primitive = parseTokenId("primitive.scale0");
  const component = parseTokenId("component.value0");
  const completions = snapshot.query.completions("semantic.alias");
  const location = snapshot.query.definition(primitive);
  const usages = snapshot.query.usages(primitive);
  const resolved = snapshot.query.resolve(component, { theme: "dark", density: "comfortable" });
  if (completions.length !== 400 || !location || usages.length !== 1 || !resolved)
    throw new Error("Representative editor queries changed semantics");
  return completions.length + usages.length + 2;
}

function fanOutSources(changed: boolean, count: number): readonly TokenSourceInput[] {
  return [
    {
      file: "/benchmark/editor-loop/fan-out-base.tokens.json",
      content: JSON.stringify({ base: { $type: "number", $value: changed ? 2 : 1 } }),
    },
    {
      file: "/benchmark/editor-loop/fan-out-consumers.tokens.json",
      content: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `consumer${index}`,
            { $type: "number", $value: "{base}" },
          ]),
        ),
      ),
    },
  ];
}

function definition(
  describeFixture: FixtureDescriptor,
  input: Omit<BenchmarkCaseDefinition, "createInvocation" | "fixture" | "group"> & {
    readonly files: readonly { readonly path: string; readonly content: string }[];
    readonly description: string;
    readonly parameters?: Readonly<Record<string, boolean | number | string>>;
    readonly createInvocation: () => Promise<BenchmarkInvocation>;
  },
): BenchmarkCaseDefinition {
  return {
    id: input.id,
    name: input.name,
    group: "editor-loop",
    fixture: describeFixture({
      kind: "synthetic",
      version: "m3-00-v1",
      description: input.description,
      files: input.files,
      ...(input.parameters ? { parameters: input.parameters } : {}),
    }),
    operation: input.operation,
    expected: input.expected,
    createInvocation: input.createInvocation,
  };
}

export function editorLoopBenchmarkCases(
  describeFixture: FixtureDescriptor,
): readonly BenchmarkCaseDefinition[] {
  const layeredBase = layeredSources(false);
  const layeredHead = layeredSources(true);
  const fanOutBase = fanOutSources(false, 2_000);
  const fanOutHead = fanOutSources(true, 2_000);
  return [
    definition(describeFixture, {
      id: "m3/editor-cold-start/layered-1200",
      name: "M3 editor cold workspace start",
      files: fixtureFiles(layeredBase),
      description: "Cold Session startup and representative Query projection for 1,200 Tokens",
      parameters: { tokens: LAYERED_TOKEN_COUNT, documents: 3, queryResults: 403 },
      operation: {
        kind: "editor-cold-start",
        cacheState: "compiler-cold-runtime-warm",
        outputTarget: "none",
        ioIncluded: false,
      },
      expected: {
        success: true,
        tokens: LAYERED_TOKEN_COUNT,
        references: LAYERED_REFERENCE_COUNT,
        changedTokens: LAYERED_TOKEN_COUNT,
        affectedTokens: LAYERED_TOKEN_COUNT,
        recomputedTokens: LAYERED_TOKEN_COUNT,
        outputFiles: 0,
      },
      async createInvocation() {
        return singleUse(async () => {
          const session = createCompilerSession({ config: { contexts: LAYERED_CONTEXTS } });
          const snapshot = requireValid(
            await session.apply({
              documents: layeredBase.map((source) => ({ kind: "add", document: document(source) })),
            }),
            "Cold editor startup",
          );
          queryRepresentativeFacts(snapshot);
          return { snapshot, session: requireSessionMetrics(session) };
        });
      },
    }),
    definition(describeFixture, {
      id: "m3/editor-one-file-update/layered-1200",
      name: "M3 editor one-file update",
      files: [...revisionFiles("base", layeredBase), ...revisionFiles("head", layeredHead)],
      description: "Warm Session update of one primitive document in a 1,200-Token workspace",
      parameters: { tokens: LAYERED_TOKEN_COUNT, documents: 3, changedFiles: 1 },
      operation: {
        kind: "editor-one-file-update",
        cacheState: "initialized-session",
        outputTarget: "none",
        ioIncluded: false,
      },
      expected: {
        success: true,
        tokens: LAYERED_TOKEN_COUNT,
        references: LAYERED_REFERENCE_COUNT,
        changedTokens: 1,
        affectedTokens: 3,
        recomputedTokens: 3,
        outputFiles: 0,
      },
      async createInvocation() {
        const session = createCompilerSession({ config: { contexts: LAYERED_CONTEXTS } });
        await session.apply({
          documents: layeredBase.map((source) => ({ kind: "add", document: document(source) })),
        });
        return singleUse(async () => {
          const changed = layeredHead[0];
          if (!changed) throw new Error("Layered edit fixture is missing its primitive document");
          const snapshot = requireValid(
            await session.apply({ documents: [{ kind: "update", document: document(changed) }] }),
            "One-file editor update",
          );
          queryRepresentativeFacts(snapshot);
          return { snapshot, session: requireSessionMetrics(session) };
        });
      },
    }),
    definition(describeFixture, {
      id: "m3/editor-invalid-recovery/layered-1200",
      name: "M3 editor invalid JSON recovery",
      files: [...revisionFiles("base", layeredBase), ...revisionFiles("head", layeredHead)],
      description: "Invalid open-buffer transaction followed by recovery in one warm Session",
      parameters: { tokens: LAYERED_TOKEN_COUNT, documents: 3, transactions: 2 },
      operation: {
        kind: "editor-invalid-recovery",
        cacheState: "initialized-session",
        outputTarget: "none",
        ioIncluded: false,
      },
      expected: {
        success: true,
        tokens: LAYERED_TOKEN_COUNT,
        references: LAYERED_REFERENCE_COUNT,
        changedTokens: 400,
        affectedTokens: LAYERED_TOKEN_COUNT,
        recomputedTokens: LAYERED_TOKEN_COUNT,
        outputFiles: 0,
      },
      async createInvocation() {
        const session = createCompilerSession({ config: { contexts: LAYERED_CONTEXTS } });
        await session.apply({
          documents: layeredBase.map((source) => ({ kind: "add", document: document(source) })),
        });
        return singleUse(async () => {
          const primitive = layeredBase[0];
          const recovered = layeredHead[0];
          if (!primitive || !recovered) throw new Error("Layered recovery fixture is incomplete");
          const invalid = await session.apply({
            documents: [
              {
                kind: "update",
                document: { identity: primitive.file, content: '{"primitive":' },
              },
            ],
          });
          if (
            invalid.status !== "invalid" ||
            !invalid.diagnostics.some((entry) => entry.code === "TOKEN_INVALID_JSON")
          )
            throw new Error("Invalid editor transaction must publish TOKEN_INVALID_JSON");
          const snapshot = requireValid(
            await session.apply({ documents: [{ kind: "update", document: document(recovered) }] }),
            "Editor recovery",
          );
          if (snapshot.revision !== 3 || session.lastSuccessfulSnapshot !== snapshot)
            throw new Error("Editor recovery did not publish the newest valid Snapshot");
          queryRepresentativeFacts(snapshot);
          return { snapshot, session: requireSessionMetrics(session) };
        });
      },
    }),
    definition(describeFixture, {
      id: "m3/editor-high-fan-out/2000",
      name: "M3 editor high-fan-out update",
      files: [...revisionFiles("base", fanOutBase), ...revisionFiles("head", fanOutHead)],
      description: "Warm edit of one primitive with 2,000 direct consumers",
      parameters: { tokens: 2_001, directConsumers: 2_000, changedFiles: 1 },
      operation: {
        kind: "editor-high-fan-out",
        cacheState: "initialized-session",
        outputTarget: "none",
        ioIncluded: false,
      },
      expected: {
        success: true,
        tokens: 2_001,
        references: 2_000,
        changedTokens: 1,
        affectedTokens: 2_001,
        recomputedTokens: 2_001,
        outputFiles: 0,
      },
      async createInvocation() {
        const session = createCompilerSession();
        await session.apply({
          documents: fanOutBase.map((source) => ({ kind: "add", document: document(source) })),
        });
        return singleUse(async () => {
          const changed = fanOutHead[0];
          if (!changed) throw new Error("Fan-out edit fixture is missing its primitive document");
          const snapshot = requireValid(
            await session.apply({ documents: [{ kind: "update", document: document(changed) }] }),
            "High-fan-out editor update",
          );
          if (snapshot.query.usages(parseTokenId("base")).length !== 2_000)
            throw new Error("High-fan-out editor query lost consumers");
          return { snapshot, session: requireSessionMetrics(session) };
        });
      },
    }),
    definition(describeFixture, {
      id: "m3/editor-cancellation/active-load",
      name: "M3 editor cancellation acknowledgement",
      files: fixtureFiles([
        {
          file: "/benchmark/editor-loop/cancellation.tokens.json",
          content: JSON.stringify({ stable: { $type: "number", $value: 1 } }),
        },
      ]),
      description: "Abort one active loader-backed transaction without committing Session state",
      parameters: { committedRevisions: 1, cancelledTransactions: 1 },
      operation: {
        kind: "editor-cancellation",
        cacheState: "initialized-session",
        outputTarget: "none",
        ioIncluded: false,
      },
      expected: { success: true, tokens: 1, references: 0, outputFiles: 0 },
      async createInvocation() {
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const loader: DocumentLoader = {
          load(_request, signal) {
            markStarted?.();
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Cancelled editor load", "AbortError")),
                { once: true },
              );
            });
          },
        };
        const session = createCompilerSession({ loader });
        const baseline = requireValid(
          await session.apply({
            documents: [
              {
                kind: "add",
                document: {
                  identity: "/benchmark/editor-loop/cancellation.tokens.json",
                  content: JSON.stringify({ stable: { $type: "number", $value: 1 } }),
                },
              },
            ],
          }),
          "Cancellation baseline",
        );
        return singleUse(async () => {
          const controller = new AbortController();
          const pending = session.apply(
            { documents: [{ kind: "add", request: { specifier: "slow.tokens.json" } }] },
            { signal: controller.signal },
          );
          await started;
          controller.abort(new DOMException("Superseded editor revision", "AbortError"));
          let cancelled = false;
          try {
            await pending;
          } catch (error) {
            cancelled = error instanceof Error && error.name === "AbortError";
          }
          if (!cancelled || session.currentSnapshot !== baseline || baseline.revision !== 1)
            throw new Error("Cancelled editor transaction changed committed Session state");
          return { snapshot: baseline };
        });
      },
    }),
  ];
}
