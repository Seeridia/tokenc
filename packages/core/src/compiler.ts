import { performance } from "node:perf_hooks";

import { checkTokenGraph } from "./checker.js";
import { checkContexts, contextKey, defaultContext } from "./context.js";
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
  TokenId,
  TokenNode,
} from "./model.js";
import { parseTokenDocument } from "./parser.js";
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
}

export interface CompileDocumentsOptions {
  readonly contexts?: ContextDefinition;
  readonly outputs?: readonly TokenBackend[];
  readonly affectedTokens?: ReadonlySet<TokenId>;
  readonly resolverSeed?: Iterable<ResolvedToken>;
}

/** Public, backend-facing IR. Backends never parse or validate source documents. */
export class Compilation {
  readonly graph: TokenGraph;
  readonly diagnostics: readonly Diagnostic[];
  readonly tokens: readonly CompiledToken[];
  readonly contexts: ContextDefinition;
  readonly availableContexts: readonly CompilationContext[];
  readonly resolver: TokenResolver;

  constructor(args: {
    graph: TokenGraph;
    diagnostics: readonly Diagnostic[];
    contexts: ContextDefinition;
    resolver: TokenResolver;
  }) {
    this.graph = args.graph;
    this.diagnostics = args.diagnostics;
    this.contexts = args.contexts;
    this.resolver = args.resolver;
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
  resolveToken(id: TokenId, context: CompilationContext = {}): ResolvedToken | undefined {
    return this.resolver.resolve(id, context);
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
  const documents = sources.map((source) => parseTokenDocument(source.content, source.file));
  const parseTime = performance.now() - parseStart;
  return compileParsedDocuments(documents, options, parseTime, totalStart);
}

/** Assemble pre-parsed documents. Used by the incremental session to avoid reparsing unchanged files. */
export async function compileParsedDocuments(
  documents: readonly ParsedTokenDocument[],
  options: CompileDocumentsOptions = {},
  parseTime = 0,
  totalStart = performance.now(),
): Promise<CompilationResult> {
  const graphStart = performance.now();
  const graph = new TokenGraph(documents.flatMap((document) => document.tokens));
  const graphTime = performance.now() - graphStart;
  const checkStart = performance.now();
  const diagnostics = [
    ...documents.flatMap((document) => document.diagnostics),
    ...duplicateDiagnostics(documents),
    ...checkTokenGraph(graph),
    ...checkContexts(graph.tokens, options.contexts ?? {}),
  ];
  const checkTime = performance.now() - checkStart;
  const resolver = new TokenResolver(graph, options.contexts ?? {}, options.resolverSeed);
  const compilation = new Compilation({
    graph,
    diagnostics,
    contexts: options.contexts ?? {},
    resolver,
  });
  const emitStart = performance.now();
  const outputs = compilation.success
    ? (
        await Promise.all((options.outputs ?? []).map((backend) => backend.emit(compilation)))
      ).flat()
    : [];
  const emitTime = performance.now() - emitStart;
  const references = graph.tokens.reduce((count, token) => count + token.dependencies.length, 0);
  const stats: CompilationStats = {
    tokens: graph.size,
    references,
    contexts: compilation.availableContexts.length,
    ...(options.affectedTokens ? { affectedTokens: options.affectedTokens.size } : {}),
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
  const sources = await loadTokenFiles(config.source, config.cwd);
  return compileDocuments(sources, {
    ...(config.contexts ? { contexts: config.contexts } : {}),
    ...(config.outputs ? { outputs: config.outputs } : {}),
  });
}
