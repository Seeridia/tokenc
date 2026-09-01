import type { TokenBackend } from "./backend.js";
import { CompilationSnapshotBuilder, type CompilationOptions } from "./compiler.js";
import { createDiagnostic } from "./diagnostic.js";
import { resolverSourceFiles } from "./dtcg/resolver-document.js";
import type {
  DocumentLoader,
  DocumentRequest,
  LoadedDocument,
  TokenSourceInput,
} from "./loader.js";
import type { CompilationContext } from "./model.js";
import {
  publishSessionMetrics,
  SessionCompilationCache,
  type SessionMetrics,
} from "./session-cache.js";
import type { CompilationSnapshot, ValidCompilationSnapshot } from "./snapshot.js";

export type {
  SessionInvalidationReason,
  SessionMetrics,
  SessionStageMetrics,
} from "./session-cache.js";

export type DocumentChange =
  | {
      readonly kind: "add" | "update";
      readonly document: LoadedDocument;
      readonly request?: never;
    }
  | {
      readonly kind: "add" | "update";
      readonly request: DocumentRequest;
      readonly document?: never;
    }
  | {
      readonly kind: "remove";
      readonly identity: string;
    };

export interface SessionTransaction {
  readonly documents?: readonly DocumentChange[];
  /** Replaces the complete semantic compiler configuration. */
  readonly config?: CompilerSessionConfiguration;
  /** Convenience override for the active Resolver input. */
  readonly resolverInput?: CompilationContext;
}

export interface CompilerSessionOptions {
  readonly loader?: DocumentLoader;
  readonly config?: CompilerSessionConfiguration;
}

export interface CompilerSessionConfiguration extends CompilationOptions {
  readonly backends?: readonly TokenBackend[];
}

export interface SessionApplyOptions {
  readonly signal?: AbortSignal;
}

export class CompilerSessionError extends Error {
  readonly code: "SESSION_CLOSED";

  constructor() {
    super("CompilerSession is closed");
    this.name = "CompilerSessionError";
    this.code = "SESSION_CLOSED";
  }
}

function cloneDocument(document: LoadedDocument): LoadedDocument {
  return Object.freeze({
    identity: document.identity,
    content: document.content,
    ...(document.origin ? { origin: Object.freeze({ ...document.origin }) } : {}),
    ...(document.version === undefined ? {} : { version: document.version }),
  });
}

function cloneConfiguration(config: CompilerSessionConfiguration): CompilerSessionConfiguration {
  const { backends, ...semantic } = config;
  return {
    ...structuredClone(semantic),
    ...(backends ? { backends: Object.freeze([...backends]) } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") throw signal.reason;
  throw new DOMException("The compilation transaction was aborted", "AbortError");
}

function requestKey(request: DocumentRequest): string {
  return `${request.from ?? ""}\0${request.specifier}`;
}

/** Transactional compiler with Session-owned, oracle-gated stage caches. */
export class CompilerSession {
  readonly #loader: DocumentLoader | undefined;
  readonly #snapshotBuilder = new CompilationSnapshotBuilder();
  readonly #compilerCache = new SessionCompilationCache();
  #documents = new Map<string, LoadedDocument>();
  #configuration: CompilerSessionConfiguration;
  #currentSnapshot: CompilationSnapshot | undefined;
  #lastSuccessfulSnapshot: ValidCompilationSnapshot | undefined;
  #metrics: SessionMetrics | undefined;
  #queue: Promise<void> = Promise.resolve();
  #accepting = true;
  #closePromise: Promise<void> | undefined;

  constructor(options: CompilerSessionOptions = {}) {
    this.#loader = options.loader;
    this.#configuration = cloneConfiguration(options.config ?? {});
  }

  get currentSnapshot(): CompilationSnapshot | undefined {
    return this.#currentSnapshot;
  }

  get lastSuccessfulSnapshot(): ValidCompilationSnapshot | undefined {
    return this.#lastSuccessfulSnapshot;
  }

  get backends(): readonly TokenBackend[] {
    return this.#configuration.backends ?? [];
  }

  get metrics(): SessionMetrics | undefined {
    return this.#metrics;
  }

  apply(
    transaction: SessionTransaction,
    options: SessionApplyOptions = {},
  ): Promise<CompilationSnapshot> {
    if (!this.#accepting) return Promise.reject(new CompilerSessionError());
    const run = this.#queue.then(() => this.#apply(transaction, options));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#accepting = false;
    this.#closePromise = this.#queue;
    return this.#closePromise;
  }

  async #load(
    request: DocumentRequest,
    signal: AbortSignal | undefined,
    cache: Map<string, Promise<LoadedDocument>>,
  ): Promise<LoadedDocument> {
    if (!this.#loader) throw new TypeError("A DocumentLoader is required for document requests");
    const key = requestKey(request);
    let pending = cache.get(key);
    if (!pending) {
      throwIfAborted(signal);
      pending = this.#loader.load(Object.freeze({ ...request }), signal).then(cloneDocument);
      cache.set(key, pending);
    }
    const loaded = await pending;
    throwIfAborted(signal);
    return loaded;
  }

  async #apply(
    transaction: SessionTransaction,
    options: SessionApplyOptions,
  ): Promise<CompilationSnapshot> {
    const signal = options.signal;
    throwIfAborted(signal);
    const loadCache = new Map<string, Promise<LoadedDocument>>();
    const resolvedChanges = await Promise.all(
      (transaction.documents ?? []).map(async (change) => {
        if (change.kind === "remove") return change;
        const document = change.document
          ? cloneDocument(change.document)
          : await this.#load(change.request, signal, loadCache);
        return { kind: change.kind, document } as const;
      }),
    );
    throwIfAborted(signal);

    const identities = resolvedChanges.map((change) =>
      change.kind === "remove" ? change.identity : change.document.identity,
    );
    const conflicting = [
      ...new Set(identities.filter((id, index) => identities.indexOf(id) !== index)),
    ];
    if (conflicting.length > 0) {
      const diagnostics = conflicting.map((identity) =>
        createDiagnostic({
          code: "SESSION_CONFLICTING_CHANGE",
          message: `Transaction contains conflicting changes for \`${identity}\``,
          parameters: { document: identity },
        }),
      );
      const prepared = await this.#compilerCache.prepare(
        [...this.#documents.values()].map(toSource),
        { ...this.#configuration, additionalDiagnostics: diagnostics },
      );
      throwIfAborted(signal);
      const snapshot = this.#snapshotBuilder.publish(prepared.build, this.#configuration);
      prepared.commit();
      this.#currentSnapshot = snapshot;
      this.#metrics = publishSessionMetrics(prepared.metrics, snapshot.revision);
      return snapshot;
    }

    const nextDocuments = new Map(this.#documents);
    for (const change of resolvedChanges) {
      if (change.kind === "remove") nextDocuments.delete(change.identity);
      else nextDocuments.set(change.document.identity, change.document);
    }
    const nextConfiguration = cloneConfiguration(transaction.config ?? this.#configuration);
    if (transaction.resolverInput)
      Object.assign(nextConfiguration, {
        resolverInput: Object.freeze({ ...transaction.resolverInput }),
      });

    const sources = new Map(
      [...nextDocuments.values()].map((document) => [document.identity, toSource(document)]),
    );
    if (nextConfiguration.resolver && this.#loader) {
      for (const specifier of resolverSourceFiles(nextConfiguration.resolver)) {
        throwIfAborted(signal);
        if (sources.has(specifier)) continue;
        // oxlint-disable-next-line eslint/no-await-in-loop -- Resolver sources are loaded exactly once per transaction.
        const loaded = await this.#load({ specifier }, signal, loadCache);
        sources.set(loaded.identity, toSource(loaded));
      }
    }
    throwIfAborted(signal);
    const prepared = await this.#compilerCache.prepare([...sources.values()], nextConfiguration);
    throwIfAborted(signal);
    const snapshot = this.#snapshotBuilder.publish(prepared.build, nextConfiguration);
    prepared.commit();
    this.#documents = nextDocuments;
    this.#configuration = nextConfiguration;
    this.#currentSnapshot = snapshot;
    this.#metrics = publishSessionMetrics(prepared.metrics, snapshot.revision);
    if (snapshot.status === "valid") this.#lastSuccessfulSnapshot = snapshot;
    return snapshot;
  }
}

function toSource(document: LoadedDocument): TokenSourceInput {
  return {
    file: document.identity,
    content: document.content,
    ...(document.origin ? { origin: document.origin } : {}),
  };
}

export function createCompilerSession(options: CompilerSessionOptions = {}): CompilerSession {
  return new CompilerSession(options);
}
