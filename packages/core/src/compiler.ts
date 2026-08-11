import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";

import { checkTokenGraph } from "./checker.js";
import { checkContexts, contextKey, defaultContext } from "./context.js";
import {
  parseResolverDocument,
  resolveResolverDocument,
  resolverSourceFiles,
  type ResolverDocument,
  type ResolverResolution,
} from "./dtcg/resolver-document.js";
import {
  linkTokenDocuments,
  parseUnresolvedTokenDocument,
  relinkParsedTokenDocuments,
} from "./frontend.js";
import { TokenGraph } from "./graph.js";
import { loadTokenFiles, type TokenSourceInput } from "./loader.js";
import type {
  CompilationContext,
  CompilationStats,
  CompiledToken,
  ContextDefinition,
  Diagnostic,
  OutputFile,
  ParsedTokenDocument,
  ResolvedToken,
  ResolutionTrace,
  TokenId,
  TokenNode,
} from "./model.js";
import { TokenResolver } from "./resolver.js";

export interface TokenBackend {
  readonly name: string;
  emit(compilation: Compilation): Promise<readonly OutputFile[]> | readonly OutputFile[];
}

export interface CompilerConfig {
  readonly source: readonly string[];
  readonly contexts?: ContextDefinition;
  readonly outputs?: readonly TokenBackend[];
  readonly cwd?: string;
  readonly resolver?: ResolverFileConfig;
}

export interface ResolverFileConfig {
  readonly source: string;
  readonly input?: CompilationContext;
}

export interface CompileDocumentsOptions {
  readonly contexts?: ContextDefinition;
  readonly outputs?: readonly TokenBackend[];
  readonly affectedTokens?: ReadonlySet<TokenId>;
  readonly resolverSeed?: Iterable<ResolvedToken>;
  readonly resolver?: ResolverDocument;
  readonly resolverInput?: CompilationContext;
  /** Diagnostics produced while an IO layer loaded the resolver document. */
  readonly resolverDiagnostics?: readonly Diagnostic[];
  readonly resolution?: ResolverResolution;
  readonly allowTokenOverrides?: boolean;
  /** Reused by incremental sessions; cold compilation creates a fresh graph. */
  readonly graph?: TokenGraph;
  /** Conservative affected subgraph used by incremental checking. */
  readonly checkTokens?: ReadonlySet<TokenId>;
  readonly skipDuplicateCheck?: boolean;
  readonly additionalDiagnostics?: readonly Diagnostic[];
}

/** Public, backend-facing IR. Backends never parse or validate source documents. */
export class Compilation {
  readonly graph: TokenGraph;
  readonly diagnostics: readonly Diagnostic[];
  readonly tokens: readonly CompiledToken[];
  readonly contexts: ContextDefinition;
  readonly availableContexts: readonly CompilationContext[];
  readonly resolver: TokenResolver;
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
    const defaults = defaultContext(args.contexts);
    const seenContexts = new Map<string, CompilationContext>([[contextKey(defaults), defaults]]);
    for (const token of args.graph.tokens) {
      for (const override of token.overrides) {
        const context = { ...defaults, ...override.selector };
        seenContexts.set(contextKey(context), context);
      }
    }
    this.availableContexts = [...seenContexts.values()];
    this.tokens = args.graph.topologicalSort().flatMap((id) => {
      const node = args.graph.getToken(id);
      const resolved = args.resolver.resolve(id);
      return node && resolved ? [{ ...resolved, rawValue: node.value }] : [];
    });
  }

  get success(): boolean {
    return !this.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  }
  getToken(id: TokenId): TokenNode | undefined {
    return this.graph.getToken(id);
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
    return this.graph.getToken(id)?.source;
  }
  getCompletionCandidates(prefix = ""): readonly TokenId[] {
    return this.graph.tokens
      .map((token) => token.id)
      .filter((id) => String(id).startsWith(prefix))
      .toSorted((left, right) => String(left).localeCompare(String(right)));
  }
  resolveToken(id: TokenId, context: CompilationContext = {}): ResolvedToken | undefined {
    return this.resolver.resolve(id, context);
  }
  tokensOfType<T extends TokenNode["type"]>(type: T): readonly CompiledToken<T>[] {
    return this.tokens.filter((token): token is CompiledToken<T> => token.type === type);
  }
  explainToken(id: TokenId, context: CompilationContext = {}): ResolutionTrace | undefined {
    const trace = this.resolver.trace(id, context);
    if (!trace) return undefined;
    return {
      ...trace,
      resolverSteps:
        this.resolution?.steps.map((step) => ({
          kind: step.kind,
          name: step.name,
          source: step.source,
          ...(step.context ? { context: step.context } : {}),
        })) ?? [],
    };
  }
}

export interface CompilationResult {
  readonly success: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly graph: TokenGraph;
  readonly compilation: Compilation;
  readonly outputs: readonly OutputFile[];
  readonly stats: CompilationStats;
}

/** Preserve config inference while keeping configuration data declarative. */
export function defineConfig(config: CompilerConfig): CompilerConfig {
  return config;
}

function duplicateDiagnostics(documents: readonly ParsedTokenDocument[]): readonly Diagnostic[] {
  const owners = new Map<TokenId, TokenNode>();
  const diagnostics: Diagnostic[] = [];
  for (const document of documents) {
    for (const token of document.tokens) {
      const previous = owners.get(token.id);
      if (previous) {
        diagnostics.push({
          code: "TOKEN_DUPLICATE_ID",
          severity: "error",
          message: `Duplicate token \`${token.id}\``,
          source: token.source,
          related: [{ message: "First defined here", source: previous.source }],
        });
      } else owners.set(token.id, token);
    }
  }
  return diagnostics;
}

/** Compile already-loaded documents through parse, graph, check, resolve, and emit. */
export async function compileDocuments(
  sources: readonly TokenSourceInput[],
  options: CompileDocumentsOptions = {},
): Promise<CompilationResult> {
  const totalStart = performance.now();
  const parseStart = performance.now();
  const resolution = options.resolver
    ? resolveResolverDocument(options.resolver, sources, options.resolverInput)
    : options.resolution;
  const effectiveSources = resolution?.sources ?? sources;
  const unresolved = effectiveSources.map((source) =>
    parseUnresolvedTokenDocument(
      source.content,
      source.file,
      source.origin ? { origin: source.origin } : {},
    ),
  );
  const documents = linkTokenDocuments(unresolved);
  const parseTime = performance.now() - parseStart;
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
  );
}

/** Assemble pre-parsed documents. Used by the incremental session to avoid reparsing unchanged files. */
export async function compileParsedDocuments(
  documents: readonly ParsedTokenDocument[],
  options: CompileDocumentsOptions = {},
  parseTime = 0,
  totalStart = performance.now(),
): Promise<CompilationResult> {
  const semanticDocuments = relinkParsedTokenDocuments(documents);
  const canReuseIncrementalState = semanticDocuments === documents;
  const graphStart = performance.now();
  const graph =
    canReuseIncrementalState && options.graph !== undefined
      ? options.graph
      : new TokenGraph(semanticDocuments.flatMap((document) => document.tokens));
  const graphTime = performance.now() - graphStart;
  const checkStart = performance.now();
  const contextTokens = options.checkTokens
    ? [...options.checkTokens].flatMap((id) => {
        const token = graph.getToken(id);
        return token ? [token] : [];
      })
    : graph.tokens;
  const diagnostics = [
    ...(options.resolverDiagnostics ?? []),
    ...(options.resolution?.diagnostics ?? []),
    ...(options.additionalDiagnostics ?? []),
    ...semanticDocuments.flatMap((document) => document.diagnostics),
    ...(options.allowTokenOverrides || options.skipDuplicateCheck
      ? []
      : duplicateDiagnostics(semanticDocuments)),
    ...checkTokenGraph(graph, options.checkTokens),
    ...checkContexts(contextTokens, options.contexts ?? {}),
  ];
  const checkTime = performance.now() - checkStart;
  const resolver = new TokenResolver(
    graph,
    options.contexts ?? {},
    canReuseIncrementalState ? options.resolverSeed : undefined,
  );
  const compilation = new Compilation({
    graph,
    diagnostics,
    contexts: options.contexts ?? {},
    resolver,
    ...(options.resolution ? { resolution: options.resolution } : {}),
  });
  const emitStart = performance.now();
  const outputs = compilation.success
    ? (
        await Promise.all(
          (options.outputs ?? []).map((backend) => Promise.resolve(backend.emit(compilation))),
        )
      ).flat()
    : [];
  const emitTime = performance.now() - emitStart;
  const references = graph.tokens.reduce((count, token) => count + token.dependencies.length, 0);
  const stats: CompilationStats = {
    tokens: graph.size,
    references,
    contexts: compilation.availableContexts.length,
    ...(options.affectedTokens ? { affectedTokens: options.affectedTokens.size } : {}),
    ...(options.checkTokens ? { checkedTokens: options.checkTokens.size } : {}),
    timings: {
      parse: parseTime,
      graph: graphTime,
      check: checkTime,
      emit: emitTime,
      total: performance.now() - totalStart,
    },
  };
  return { success: compilation.success, diagnostics, graph, compilation, outputs, stats };
}

/** High-level programmatic compiler API using configured source globs. */
export async function compile(config: CompilerConfig): Promise<CompilationResult> {
  const loadedSources = await loadTokenFiles(config.source, config.cwd);
  let sources = loadedSources;
  let resolver: ResolverDocument | undefined;
  let resolverDiagnostics: readonly Diagnostic[] = [];
  if (config.resolver) {
    const resolverFile = resolvePath(config.cwd ?? process.cwd(), config.resolver.source);
    const parsed = parseResolverDocument(await readFile(resolverFile, "utf8"), resolverFile);
    resolver = parsed.document;
    resolverDiagnostics = parsed.diagnostics;
    if (resolver) {
      const loadedByFile = new Map(
        loadedSources.map((source) => [resolvePath(source.file), source]),
      );
      for (const file of resolverSourceFiles(resolver)) {
        if (loadedByFile.has(resolvePath(file))) continue;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Resolver references are loaded once before compilation.
          const content = await readFile(file, "utf8");
          loadedByFile.set(resolvePath(file), { file: resolvePath(file), content });
        } catch {
          // Semantic resolution emits a source-located missing-file diagnostic.
        }
      }
      sources = [...loadedByFile.values()];
    }
  }
  return compileDocuments(sources, {
    ...(config.contexts ? { contexts: config.contexts } : {}),
    ...(config.outputs ? { outputs: config.outputs } : {}),
    ...(resolver ? { resolver } : {}),
    ...(config.resolver?.input ? { resolverInput: config.resolver.input } : {}),
    ...(resolverDiagnostics.length > 0 ? { resolverDiagnostics } : {}),
  });
}
