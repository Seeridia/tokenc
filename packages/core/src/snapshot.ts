import {
  emitBackendPlans,
  prepareBackends,
  type BackendEmissionResult,
  type BackendPreparationResult,
  type CompilationIR,
  type TokenBackend,
} from "./backend.js";
import type {
  CompilationStats,
  CompilationContext,
  Diagnostic,
  ExplainTraceV1,
  ResolvedToken,
  SourceLocation,
  TokenId,
  TokenNode,
} from "./model.js";
import {
  type CompilationQuery,
  type ImpactQueryV1,
  type QueryEdgeV1,
  type QueryRegion,
} from "./query.js";
import type { EditorSourceIndex, EditorSymbolV1 } from "./source-index.js";

export interface SnapshotDocument {
  /** Exact loader identity used by source locations and editor operations. */
  readonly source: string;
  /** Canonical repository-relative identity used by snapshots and reports. */
  readonly identity: string;
  readonly content: string;
  /** Canonical Token IDs owned by this document after linking and inheritance expansion. */
  readonly tokenIds: readonly TokenId[];
  readonly origin?: SourceLocation;
}

export interface UnavailableQueryResult {
  readonly status: "unavailable";
  readonly diagnostics: readonly Diagnostic[];
}

/** Graph-only query facade used when typing or checking made a snapshot invalid. */
export class InvalidCompilationQuery {
  readonly #query: CompilationQuery;
  readonly #unavailable: UnavailableQueryResult;

  constructor(query: CompilationQuery, diagnostics: readonly Diagnostic[]) {
    this.#query = query;
    this.#unavailable = Object.freeze({ status: "unavailable", diagnostics });
    Object.freeze(this);
  }

  token(id: TokenId): TokenNode | undefined {
    return this.#query.token(id);
  }

  definition(id: TokenId) {
    return this.#query.definition(id);
  }

  tokenAt(document: string, offset: number): TokenNode | undefined {
    return this.#query.tokenAt(document, offset);
  }

  symbolAt(document: string, offset: number): EditorSymbolV1 | undefined {
    return this.#query.symbolAt(document, offset);
  }

  documentSymbols(document: string): readonly EditorSymbolV1[] {
    return this.#query.documentSymbols(document);
  }

  occurrences(id: TokenId, region: QueryRegion = {}): readonly EditorSymbolV1[] {
    return this.#query.occurrences(id, region);
  }

  completions(prefix = ""): readonly TokenId[] {
    return this.#query.completions(prefix);
  }

  context(overrides: CompilationContext = {}): CompilationContext {
    return this.#query.context(overrides);
  }

  dependencies(id: TokenId, region: QueryRegion = {}): readonly QueryEdgeV1[] {
    return this.#query.dependencies(id, region);
  }

  usages(id: TokenId, region: QueryRegion = {}): readonly QueryEdgeV1[] {
    return this.#query.usages(id, region);
  }

  graph(roots?: readonly TokenId[], region: QueryRegion = {}): readonly QueryEdgeV1[] {
    return this.#query.graph(roots, region);
  }

  impact(changedIds: readonly TokenId[], region: QueryRegion = {}): ImpactQueryV1 {
    return this.#query.impact(changedIds, region);
  }

  resolve(_id: TokenId, _context: CompilationContext = {}): UnavailableQueryResult {
    return this.#unavailable;
  }

  explain(_id: TokenId, _context: CompilationContext = {}): UnavailableQueryResult {
    return this.#unavailable;
  }
}

export interface SnapshotBase {
  readonly revision: number;
  readonly graphRevision: number;
  readonly sourceRevision: string;
  readonly configurationIdentity: string;
  readonly documents: readonly SnapshotDocument[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: CompilationStats;
  readonly sourceIndex: EditorSourceIndex;
}

interface ValidSnapshotInit extends SnapshotBase {
  readonly query: CompilationQuery;
  readonly ir: CompilationIR;
}

interface InvalidSnapshotInit extends SnapshotBase {
  readonly query: InvalidCompilationQuery;
}

export class ValidCompilationSnapshot implements SnapshotBase {
  readonly status = "valid" as const;
  readonly revision: number;
  readonly graphRevision: number;
  readonly sourceRevision: string;
  readonly configurationIdentity: string;
  readonly documents: readonly SnapshotDocument[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: CompilationStats;
  readonly sourceIndex: EditorSourceIndex;
  readonly query: CompilationQuery;
  readonly ir: CompilationIR;

  constructor(init: ValidSnapshotInit) {
    this.revision = init.revision;
    this.graphRevision = init.graphRevision;
    this.sourceRevision = init.sourceRevision;
    this.configurationIdentity = init.configurationIdentity;
    this.documents = init.documents;
    this.diagnostics = init.diagnostics;
    this.stats = init.stats;
    this.sourceIndex = init.sourceIndex;
    this.query = init.query;
    this.ir = init.ir;
    Object.freeze(this);
  }

  prepare(backends: readonly TokenBackend[]): Promise<BackendPreparationResult> {
    return prepareBackends(this.ir, backends);
  }

  async emit(backends: readonly TokenBackend[]): Promise<BackendEmissionResult> {
    const preparation = await this.prepare(backends);
    return emitBackendPlans(backends, preparation);
  }
}

export class InvalidCompilationSnapshot implements SnapshotBase {
  readonly status = "invalid" as const;
  readonly revision: number;
  readonly graphRevision: number;
  readonly sourceRevision: string;
  readonly configurationIdentity: string;
  readonly documents: readonly SnapshotDocument[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: CompilationStats;
  readonly sourceIndex: EditorSourceIndex;
  readonly query: InvalidCompilationQuery;

  constructor(init: InvalidSnapshotInit) {
    this.revision = init.revision;
    this.graphRevision = init.graphRevision;
    this.sourceRevision = init.sourceRevision;
    this.configurationIdentity = init.configurationIdentity;
    this.documents = init.documents;
    this.diagnostics = init.diagnostics;
    this.stats = init.stats;
    this.sourceIndex = init.sourceIndex;
    this.query = init.query;
    Object.freeze(this);
  }
}

export type CompilationSnapshot = ValidCompilationSnapshot | InvalidCompilationSnapshot;

export type SnapshotResolveResult = ResolvedToken | UnavailableQueryResult | undefined;
export type SnapshotExplainResult = ExplainTraceV1 | UnavailableQueryResult | undefined;
