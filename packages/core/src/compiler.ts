import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { CompilationIR, type TokenBackend } from "./backend.js";
import { checkTokenGraphDetailed } from "./checker.js";
import { checkContexts, contextKey, defaultContext } from "./context.js";
import { DiagnosticBag } from "./diagnostic.js";
import {
  parseResolverDocument,
  resolveResolverDocument,
  type ResolverDocument,
  type ResolverResolution,
} from "./dtcg/resolver-document.js";
import {
  linkTokenDocuments,
  parseUnresolvedTokenDocument,
  relinkParsedTokenDocuments,
} from "./frontend.js";
import { TokenGraph } from "./graph.js";
import { FileSystemDocumentLoader, loadTokenFiles, type TokenSourceInput } from "./loader.js";
import type {
  CompilationContext,
  CompilationStats,
  CompiledToken,
  ContextDefinition,
  Diagnostic,
  ParsedTokenDocument,
  ResolvedToken,
  TokenId,
  TokenNode,
} from "./model.js";
import { InternalCompilationQuery, type CompilationQuery } from "./query.js";
import { TokenResolver } from "./resolver.js";
import { createCompilerSession } from "./session.js";
import {
  InvalidCompilationQuery,
  InvalidCompilationSnapshot,
  ValidCompilationSnapshot,
  type CompilationSnapshot,
  type SnapshotDocument,
} from "./snapshot.js";
import { InternalEditorSourceIndex } from "./source-index.js";

export interface CompilerConfig {
  readonly source: readonly string[];
  readonly contexts?: ContextDefinition;
  readonly outputs?: readonly TokenBackend[];
  readonly cwd?: string;
  readonly resolver?: ResolverFileConfig;
}

export interface CompileOptions {
  readonly signal?: AbortSignal;
}

export interface ResolverFileConfig {
  readonly source: string;
  readonly input?: CompilationContext;
}

export interface CompilationOptions {
  readonly contexts?: ContextDefinition;
  readonly resolver?: ResolverDocument;
  readonly resolverInput?: CompilationContext;
  /** Diagnostics produced while an IO layer loaded the resolver document. */
  readonly resolverDiagnostics?: readonly Diagnostic[];
}

/** @internal Builder controls used by the compilation pipeline and differential oracle. */
export interface CompileDocumentsOptions extends CompilationOptions {
  readonly affectedTokens?: ReadonlySet<TokenId>;
  readonly resolverSeed?: Iterable<ResolvedToken>;
  readonly resolution?: ResolverResolution;
  readonly allowTokenOverrides?: boolean;
  /** Reused by incremental sessions; cold compilation creates a fresh graph. */
  readonly graph?: TokenGraph;
  /** Conservative affected subgraph used by incremental checking. */
  readonly checkTokens?: ReadonlySet<TokenId>;
  readonly skipDuplicateCheck?: boolean;
  readonly additionalDiagnostics?: readonly Diagnostic[];
  /** Documents were linked together by the Session's component cache. */
  readonly linkedDocuments?: boolean;
}

/** @internal Mutable build state; public callers receive an immutable CompilationSnapshot. */
class CompilationState {
  readonly graph: TokenGraph;
  readonly diagnostics: readonly Diagnostic[];
  readonly tokens: readonly CompiledToken[];
  readonly contexts: ContextDefinition;
  readonly availableContexts: readonly CompilationContext[];
  readonly resolver: TokenResolver;
  readonly query: CompilationQuery;
  readonly resolution?: ResolverResolution;

  constructor(args: {
    graph: TokenGraph;
    diagnostics: readonly Diagnostic[];
    contexts: ContextDefinition;
    resolver: TokenResolver;
    resolution?: ResolverResolution;
  }) {
    this.graph = args.graph;
    this.diagnostics = args.diagnostics;
    this.contexts = args.contexts;
    this.resolver = args.resolver;
    if (args.resolution) this.resolution = args.resolution;
    this.query = new InternalCompilationQuery(args.graph, args.resolver, args.resolution);
    const defaults = defaultContext(args.contexts);
    const seenContexts = new Map<string, CompilationContext>([[contextKey(defaults), defaults]]);
    for (const token of args.graph.tokens) {
      for (const override of token.overrides) {
        const context = { ...defaults, ...override.selector };
        seenContexts.set(contextKey(context), context);
      }
    }
    this.availableContexts = [...seenContexts.values()];
    this.tokens = args.graph.topologicalSort(defaults).flatMap((id) => {
      const node = args.graph.getToken(id);
      const resolved = args.resolver.resolve(id);
      return node && resolved ? [deepFreeze({ ...resolved, rawValue: node.value })] : [];
    });
  }

  get success(): boolean {
    return !this.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  }
  getToken(id: TokenId): TokenNode | undefined {
    return this.query.token(id);
  }
  getTokenAtSourcePosition(file: string, offset: number): TokenNode | undefined {
    return this.graph.tokens
      .filter(
        (token) =>
          token.source.file === file &&
          offset >= token.source.offset &&
          offset < token.source.offset + token.source.length,
      )
      .toSorted((left, right) => left.source.length - right.source.length)[0];
  }
  getDefinition(id: TokenId): TokenNode["source"] | undefined {
    return this.query.definition(id);
  }
  getCompletionCandidates(prefix = ""): readonly TokenId[] {
    return this.query.completions(prefix);
  }
  resolveToken(id: TokenId, context: CompilationContext = {}): ResolvedToken | undefined {
    return this.query.resolve(id, context);
  }
  tokensOfType<T extends TokenNode["type"]>(type: T): readonly CompiledToken<T>[] {
    return this.tokens.filter((token): token is CompiledToken<T> => token.type === type);
  }
}

/** @internal Data retained only while building a published Snapshot. */
export interface CompilationBuildResult {
  readonly success: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly graph: TokenGraph;
  readonly compilation: CompilationState;
  readonly stats: CompilationStats;
  readonly documents: readonly ParsedTokenDocument[];
}

interface PriorStageTimings {
  readonly link?: number;
  readonly graph?: number;
  readonly check?: number;
  readonly resolve?: number;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function cloneAndFreeze(value: TokenNode): TokenNode;
function cloneAndFreeze(value: unknown): unknown;
function cloneAndFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneAndFreeze(entry)));
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)])),
  );
}

/** @internal Build a Graph safe to share across immutable snapshots and Session cache entries. */
export function createImmutableTokenGraph(
  documents: readonly ParsedTokenDocument[],
  contexts: ContextDefinition = {},
): TokenGraph {
  return new TokenGraph(
    documents.flatMap((document) => document.tokens.map((token) => cloneAndFreeze(token))),
    contexts,
  );
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

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function canonicalDocumentIdentity(identity: string): string {
  const normalized = identity.split(sep).join("/");
  if (!isAbsolute(identity)) return normalized.replace(/^\.\//u, "");
  return relative(process.cwd(), identity).split(sep).join("/");
}

function graphIdentity(graph: TokenGraph): string {
  return digest({
    tokens: graph.tokens.map((token) => ({
      id: token.id,
      type: token.type,
      baseCandidate: token.baseCandidate,
      value: token.value.kind === "literal" ? token.value : { ...token.value, source: undefined },
      description: token.description,
      deprecated: token.deprecated,
      extensions: token.extensions,
      overrides: token.overrides.map((override) => ({
        candidate: override.candidate,
        selector: override.selector,
        expression:
          override.expression.kind === "literal"
            ? override.expression
            : { ...override.expression, source: undefined },
        precedence: override.precedence,
        origin: override.origin,
      })),
      inheritance: token.inheritance
        ? { token: token.inheritance.token, group: token.inheritance.group }
        : undefined,
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      candidate: edge.occurrence.candidate,
      kind: edge.occurrence.kind,
      fieldPath: edge.occurrence.fieldPath,
      sourceOrder: edge.occurrence.sourceOrder,
      condition: edge.condition.key,
    })),
  });
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const severity = { error: 0, warning: 1, info: 2 } as const;
  return (
    (left.source?.document ?? "").localeCompare(right.source?.document ?? "") ||
    (left.source?.range.offset ?? -1) - (right.source?.range.offset ?? -1) ||
    severity[left.severity] - severity[right.severity] ||
    left.code.localeCompare(right.code) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

function snapshotDocuments(documents: readonly ParsedTokenDocument[]): readonly SnapshotDocument[] {
  return Object.freeze(
    documents.map((document) =>
      Object.freeze({
        identity: canonicalDocumentIdentity(document.source),
        content: document.content,
        tokenIds: Object.freeze(
          document.tokens
            .map((token) => token.id)
            .toSorted((left, right) => String(left).localeCompare(String(right))),
        ),
      }),
    ),
  );
}

function configurationIdentity(options: CompileDocumentsOptions): string {
  return digest({
    contexts: options.contexts ?? {},
    resolverInput: options.resolverInput ?? {},
    resolver: options.resolver?.content ?? null,
    allowTokenOverrides: options.allowTokenOverrides ?? false,
  });
}

function sourceRevision(documents: readonly SnapshotDocument[], configuration: string): string {
  return digest({
    configuration,
    documents: documents.map((document) => ({
      identity: document.identity,
      content: document.content,
    })),
  });
}

/** Preserve config inference while keeping configuration data declarative. */
export function defineConfig(config: CompilerConfig): CompilerConfig {
  return config;
}

function duplicateDiagnostics(documents: readonly ParsedTokenDocument[]): readonly Diagnostic[] {
  const owners = new Map<TokenId, TokenNode>();
  const diagnostics = new DiagnosticBag();
  for (const document of documents) {
    for (const token of document.tokens) {
      const previous = owners.get(token.id);
      if (previous) {
        diagnostics.push({
          code: "TOKEN_DUPLICATE_ID",
          severity: "error",
          message: `Duplicate token \`${token.id}\``,
          source: token.source,
          anchor: { kind: "token", token: token.id },
          parameters: { token: token.id },
          related: [{ message: "First defined here", source: previous.source }],
        });
      } else owners.set(token.id, token);
    }
  }
  return diagnostics;
}

/** @internal Unpublished build state for incremental compilation. */
export async function compileDocumentsInternal(
  sources: readonly TokenSourceInput[],
  options: CompileDocumentsOptions = {},
): Promise<CompilationBuildResult> {
  const totalStart = performance.now();
  const resolverStart = performance.now();
  const resolution = options.resolver
    ? resolveResolverDocument(options.resolver, sources, options.resolverInput)
    : options.resolution;
  const resolverLinkTime = performance.now() - resolverStart;
  const effectiveSources = resolution?.sources ?? sources;
  const parseStart = performance.now();
  const unresolved = effectiveSources.map((source) =>
    parseUnresolvedTokenDocument(
      source.content,
      source.file,
      source.origin ? { origin: source.origin } : {},
    ),
  );
  const parseTime = performance.now() - parseStart;
  const linkStart = performance.now();
  const documents = linkTokenDocuments(unresolved);
  const linkTime = resolverLinkTime + performance.now() - linkStart;
  return compileParsedDocuments(
    documents,
    {
      ...options,
      ...(resolution
        ? {
            resolution,
            contexts: { ...resolution.contexts, ...options.contexts },
            allowTokenOverrides: true,
          }
        : {}),
    },
    parseTime,
    totalStart,
    { link: linkTime },
  );
}

/** Assemble pre-parsed documents. Used by the incremental session to avoid reparsing unchanged files. */
export async function compileParsedDocuments(
  documents: readonly ParsedTokenDocument[],
  options: CompileDocumentsOptions = {},
  parseTime = 0,
  totalStart = performance.now(),
  priorTimings: PriorStageTimings = {},
): Promise<CompilationBuildResult> {
  const linkStart = performance.now();
  const semanticDocuments = options.linkedDocuments
    ? documents
    : relinkParsedTokenDocuments(documents);
  const linkTime = (priorTimings.link ?? 0) + performance.now() - linkStart;
  const canReuseIncrementalState = semanticDocuments === documents;
  const graphStart = performance.now();
  const graph =
    canReuseIncrementalState && options.graph !== undefined
      ? options.graph
      : new TokenGraph(
          semanticDocuments.flatMap((document) => document.tokens),
          options.contexts ?? {},
        );
  const graphTime = (priorTimings.graph ?? 0) + performance.now() - graphStart;
  const checkStart = performance.now();
  const contextTokens = options.checkTokens
    ? [...options.checkTokens].flatMap((id) => {
        const token = graph.getToken(id);
        return token ? [token] : [];
      })
    : graph.tokens;
  const graphCheck = checkTokenGraphDetailed(graph, options.checkTokens, options.contexts ?? {});
  const frontendDiagnostics = [
    ...(options.resolverDiagnostics ?? []),
    ...(options.resolution?.diagnostics ?? []),
    ...(options.additionalDiagnostics ?? []),
    ...semanticDocuments.flatMap((document) => document.diagnostics),
    ...(options.allowTokenOverrides || options.skipDuplicateCheck
      ? []
      : duplicateDiagnostics(semanticDocuments)),
    ...graph.diagnostics,
    ...graphCheck.diagnostics,
    ...checkContexts(contextTokens, options.contexts ?? {}),
  ];
  const checkTime = (priorTimings.check ?? 0) + performance.now() - checkStart;
  const resolveStart = performance.now();
  const snapshotGraph =
    canReuseIncrementalState && options.graph
      ? options.graph
      : createImmutableTokenGraph(semanticDocuments, options.contexts ?? {});
  const resolver = new TokenResolver(
    snapshotGraph,
    options.contexts ?? {},
    canReuseIncrementalState ? options.resolverSeed : undefined,
  );
  const compilation = new CompilationState({
    graph: snapshotGraph,
    diagnostics: frontendDiagnostics,
    contexts: options.contexts ?? {},
    resolver,
    ...(options.resolution ? { resolution: options.resolution } : {}),
  });
  const resolveTime = (priorTimings.resolve ?? 0) + performance.now() - resolveStart;
  const references = graph.edges.length;
  const stats: CompilationStats = {
    tokens: graph.size,
    references,
    contexts: compilation.availableContexts.length,
    ...(options.affectedTokens ? { affectedTokens: options.affectedTokens.size } : {}),
    ...(options.checkTokens ? { checkedTokens: options.checkTokens.size } : {}),
    contextCycles: graphCheck.metrics,
    timings: {
      parse: parseTime,
      link: linkTime,
      graph: graphTime,
      check: checkTime,
      resolve: resolveTime,
      emit: 0,
      total: performance.now() - totalStart,
    },
  };
  return {
    success: compilation.success,
    diagnostics: frontendDiagnostics,
    graph: snapshotGraph,
    compilation,
    stats,
    documents: semanticDocuments,
  };
}

function createSnapshot(
  build: CompilationBuildResult,
  options: CompilationOptions,
  revision: number,
  graphRevision: number,
): CompilationSnapshot {
  const diagnostics = Object.freeze([...build.diagnostics].toSorted(compareDiagnostics));
  const documents = snapshotDocuments(build.documents);
  const configuration = configurationIdentity(options);
  const base = {
    revision,
    graphRevision,
    sourceRevision: sourceRevision(documents, configuration),
    configurationIdentity: configuration,
    documents,
    diagnostics,
    stats: deepFreeze(structuredClone(build.stats)),
    sourceIndex: new InternalEditorSourceIndex(build.documents, build.graph),
  };
  const resolver = build.compilation.resolver;
  const query = new InternalCompilationQuery(
    build.graph,
    resolver,
    build.compilation.resolution,
    base.sourceIndex,
  );
  Object.freeze(query);
  if (!build.compilation.success)
    return new InvalidCompilationSnapshot({
      ...base,
      query: new InvalidCompilationQuery(query, diagnostics),
    });
  const ir = new CompilationIR({
    tokens: build.compilation.tokens,
    sourceTokens: build.graph.tokens,
    contexts: build.compilation.contexts,
    availableContexts: build.compilation.availableContexts,
    ...(build.compilation.resolution
      ? { resolutionContext: build.compilation.resolution.context }
      : {}),
    getToken: (id) => build.graph.getToken(id),
    resolveToken: (id, context) => resolver.resolve(id, context),
  });
  return new ValidCompilationSnapshot({ ...base, query, ir });
}

/** @internal Publishes build results with a monotonic snapshot revision sequence. */
export class CompilationSnapshotBuilder {
  #revision = 0;
  #graphRevision = 0;
  #graphIdentity: string | undefined;

  async build(
    sources: readonly TokenSourceInput[],
    options: CompilationOptions = {},
  ): Promise<CompilationSnapshot> {
    const build = await compileDocumentsInternal(sources, options);
    return this.publish(build, options);
  }

  /** @internal Publish an already-built result while preserving this builder's revision sequence. */
  publish(build: CompilationBuildResult, options: CompilationOptions = {}): CompilationSnapshot {
    const nextGraphIdentity = graphIdentity(build.graph);
    this.#revision += 1;
    if (this.#graphIdentity !== nextGraphIdentity) this.#graphRevision += 1;
    this.#graphIdentity = nextGraphIdentity;
    return createSnapshot(build, options, this.#revision, this.#graphRevision);
  }
}

/** Compile already-loaded documents into one immutable semantic Snapshot. */
export async function compileDocuments(
  sources: readonly TokenSourceInput[],
  options: CompilationOptions = {},
): Promise<CompilationSnapshot> {
  const session = createCompilerSession({
    config: {
      ...(options.contexts ? { contexts: options.contexts } : {}),
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.resolverInput ? { resolverInput: options.resolverInput } : {}),
      ...(options.resolverDiagnostics ? { resolverDiagnostics: options.resolverDiagnostics } : {}),
    },
  });
  try {
    return await session.apply({
      documents: sources.map((source) => ({
        kind: "add",
        document: {
          identity: source.file,
          content: source.content,
          ...(source.origin ? { origin: source.origin } : {}),
        },
      })),
    });
  } finally {
    await session.close();
  }
}

/** High-level programmatic compiler API using configured source globs. */
export async function compile(
  config: CompilerConfig,
  options: CompileOptions = {},
): Promise<CompilationSnapshot> {
  options.signal?.throwIfAborted();
  const cwd = config.cwd ?? process.cwd();
  const loader = new FileSystemDocumentLoader(cwd);
  const loadedSources = await loadTokenFiles(config.source, cwd, options.signal);
  let resolver: ResolverDocument | undefined;
  let resolverDiagnostics: readonly Diagnostic[] = [];
  if (config.resolver) {
    const loadedResolver = await loader.load({ specifier: config.resolver.source }, options.signal);
    const parsed = parseResolverDocument(loadedResolver.content, loadedResolver.identity);
    resolver = parsed.document;
    resolverDiagnostics = parsed.diagnostics;
  }
  const session = createCompilerSession({
    loader,
    config: {
      ...(config.contexts ? { contexts: config.contexts } : {}),
      ...(config.outputs ? { backends: config.outputs } : {}),
      ...(resolver ? { resolver } : {}),
      ...(config.resolver?.input ? { resolverInput: config.resolver.input } : {}),
      ...(resolverDiagnostics.length > 0 ? { resolverDiagnostics } : {}),
    },
  });
  try {
    return await session.apply(
      {
        documents: loadedSources.map((source) => ({
          kind: "add",
          document: { identity: source.file, content: source.content },
        })),
      },
      options,
    );
  } finally {
    await session.close();
  }
}
