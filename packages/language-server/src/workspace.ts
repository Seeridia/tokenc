import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import { createSessionConfiguration, loadConfigFile } from "@tokenc/cli";
import {
  CompilerSession,
  createCompilerSession,
  FileSystemDocumentLoader,
  loadTokenFiles,
  type CompilationSnapshot,
  type CompilerSessionConfiguration,
  type DocumentChange,
  type DocumentLoader,
  type LoadedDocument,
} from "@tokenc/core";
import micromatch from "micromatch";

import { LatestWorkScheduler } from "./scheduler.js";
import { fileUriToDocumentIdentity, isDocumentInsideWorkspace } from "./uri.js";

export interface WorkspaceFolderIdentity {
  readonly name: string;
  readonly uri: string;
}

export interface LoadedWorkspaceProject {
  readonly configPath: string;
  readonly config: CompilerSessionConfiguration;
  readonly documents: readonly LoadedDocument[];
  readonly documentLoader: DocumentLoader;
  readonly includesDocument: (identity: string) => boolean;
}

export interface WorkspaceProjectLoader {
  load(
    root: string,
    explicitConfigPath: string | undefined,
    signal: AbortSignal,
  ): Promise<LoadedWorkspaceProject>;
  readDocument(identity: string, signal: AbortSignal): Promise<LoadedDocument>;
}

export class NodeWorkspaceProjectLoader implements WorkspaceProjectLoader {
  async load(
    root: string,
    explicitConfigPath: string | undefined,
    signal: AbortSignal,
  ): Promise<LoadedWorkspaceProject> {
    signal.throwIfAborted();
    const loaded = await loadConfigFile(root, explicitConfigPath);
    signal.throwIfAborted();
    const projectRoot = loaded.config.cwd ?? root;
    const documentLoader = new FileSystemDocumentLoader(projectRoot);
    const [sources, config] = await Promise.all([
      loadTokenFiles(loaded.config.source, projectRoot, signal),
      createSessionConfiguration(loaded.config, documentLoader, signal),
    ]);
    signal.throwIfAborted();
    return {
      configPath: loaded.path,
      config,
      documents: sources.map((source) => ({ identity: source.file, content: source.content })),
      documentLoader,
      includesDocument: (identity) => {
        if (!isDocumentInsideWorkspace(identity, projectRoot)) return false;
        const relativeIdentity = relative(projectRoot, identity).split(sep).join("/");
        return micromatch.isMatch(relativeIdentity, loaded.config.source, { dot: true });
      },
    };
  }

  async readDocument(identity: string, signal: AbortSignal): Promise<LoadedDocument> {
    const content = await readFile(identity, { encoding: "utf8", signal });
    return { identity, content };
  }
}

export type WorkspaceStatus = "untrusted" | "loading" | "ready" | "configuration-error" | "closed";

export type WorkspaceFileChange = "created" | "changed" | "deleted";

export interface WorkspaceCoordinatorOptions {
  readonly folder: WorkspaceFolderIdentity;
  readonly trusted: boolean;
  readonly explicitConfigPath?: string;
  readonly projectLoader?: WorkspaceProjectLoader;
  readonly createSession?: typeof createCompilerSession;
  readonly onError?: (error: unknown, workspace: WorkspaceCoordinator) => void;
  readonly onSnapshot?: (snapshot: CompilationSnapshot, workspace: WorkspaceCoordinator) => void;
}

interface OpenDocument {
  readonly content: string;
  readonly version: number;
}

/** One isolated compiler lifecycle for one LSP workspace folder. */
export class WorkspaceCoordinator {
  readonly folder: WorkspaceFolderIdentity;
  readonly trusted: boolean;
  readonly root: string | undefined;
  readonly #explicitConfigPath: string | undefined;
  readonly #projectLoader: WorkspaceProjectLoader;
  readonly #createSession: typeof createCompilerSession;
  readonly #onError: NonNullable<WorkspaceCoordinatorOptions["onError"]>;
  readonly #onSnapshot: NonNullable<WorkspaceCoordinatorOptions["onSnapshot"]>;
  readonly #scheduler: LatestWorkScheduler;
  readonly #overlays = new Map<string, OpenDocument>();
  #diskDocuments = new Map<string, LoadedDocument>();
  #sourceIdentities = new Set<string>();
  #appliedContents = new Map<string, string>();
  #session: CompilerSession | undefined;
  #configPath: string | undefined;
  #includesDocument: ((identity: string) => boolean) | undefined;
  #status: WorkspaceStatus;

  constructor(options: WorkspaceCoordinatorOptions) {
    this.folder = Object.freeze({ ...options.folder });
    this.trusted = options.trusted;
    this.root = fileUriToDocumentIdentity(options.folder.uri);
    this.#explicitConfigPath = options.explicitConfigPath;
    this.#projectLoader = options.projectLoader ?? new NodeWorkspaceProjectLoader();
    this.#createSession = options.createSession ?? createCompilerSession;
    this.#onError = options.onError ?? (() => undefined);
    this.#onSnapshot = options.onSnapshot ?? (() => undefined);
    this.#status = options.trusted && this.root ? "loading" : "untrusted";
    this.#scheduler = new LatestWorkScheduler((error) => {
      this.#status = "configuration-error";
      this.#onError(error, this);
    });
  }

  get status(): WorkspaceStatus {
    return this.#status;
  }

  get session(): CompilerSession | undefined {
    return this.#session;
  }

  get snapshot(): CompilationSnapshot | undefined {
    return this.#session?.currentSnapshot;
  }

  get requestedRevision(): number {
    return this.#scheduler.requestedRevision;
  }

  get publishedRevision(): number {
    return this.#scheduler.publishedRevision;
  }

  get configPath(): string | undefined {
    return this.#configPath;
  }

  async initialize(): Promise<void> {
    if (!this.trusted || !this.root || this.#status === "closed") return;
    this.reload();
    await this.idle();
  }

  reload(): number {
    if (!this.trusted || !this.root || this.#status === "closed") return this.requestedRevision;
    this.#status = "loading";
    return this.#scheduler.schedule(async (signal) => {
      const project = await this.#projectLoader.load(this.root!, this.#explicitConfigPath, signal);
      signal.throwIfAborted();
      if (!this.#session)
        this.#session = this.#createSession({
          loader: project.documentLoader,
          config: project.config,
        });
      const diskDocuments = new Map(
        project.documents.map((document) => [document.identity, document]),
      );
      const sourceIdentities = new Set(diskDocuments.keys());
      for (const identity of this.#overlays.keys())
        if (project.includesDocument(identity)) sourceIdentities.add(identity);
      await this.#applyDesired(diskDocuments, sourceIdentities, project.config, signal);
      signal.throwIfAborted();
      this.#diskDocuments = diskDocuments;
      this.#sourceIdentities = sourceIdentities;
      this.#configPath = project.configPath;
      this.#includesDocument = project.includesDocument;
      this.#status = "ready";
    });
  }

  openDocument(uri: string, content: string, version: number): number {
    return this.#setOverlay(uri, content, version);
  }

  changeDocument(uri: string, content: string, version: number): number {
    return this.#setOverlay(uri, content, version);
  }

  closeDocument(uri: string): number {
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity || !this.#owns(identity) || !this.#overlays.delete(identity))
      return this.requestedRevision;
    if (!this.#diskDocuments.has(identity)) this.#sourceIdentities.delete(identity);
    return this.#scheduleCurrentDocuments();
  }

  watchedFile(uri: string, change: WorkspaceFileChange): number {
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity || !this.#owns(identity) || this.#status === "closed")
      return this.requestedRevision;
    if (
      identity === this.#configPath ||
      (!this.#sourceIdentities.has(identity) && !this.#includesDocument?.(identity))
    )
      return this.reload();
    return this.#scheduler.schedule(async (signal) => {
      const diskDocuments = new Map(this.#diskDocuments);
      const sourceIdentities = new Set(this.#sourceIdentities);
      if (change === "deleted") {
        diskDocuments.delete(identity);
        if (!this.#overlays.has(identity)) sourceIdentities.delete(identity);
      } else {
        const document = await this.#projectLoader.readDocument(identity, signal);
        signal.throwIfAborted();
        diskDocuments.set(identity, document);
        sourceIdentities.add(identity);
      }
      await this.#applyDesired(diskDocuments, sourceIdentities, undefined, signal);
      signal.throwIfAborted();
      this.#diskDocuments = diskDocuments;
      this.#sourceIdentities = sourceIdentities;
      this.#status = "ready";
    });
  }

  documentVersion(uri: string): number | undefined {
    const identity = fileUriToDocumentIdentity(uri);
    return identity ? this.#overlays.get(identity)?.version : undefined;
  }

  async idle(): Promise<void> {
    await this.#scheduler.idle();
  }

  async close(): Promise<void> {
    if (this.#status === "closed") return;
    this.#status = "closed";
    await this.#scheduler.close();
    await this.#session?.close();
  }

  #owns(identity: string): boolean {
    return this.root !== undefined && isDocumentInsideWorkspace(identity, this.root);
  }

  #setOverlay(uri: string, content: string, version: number): number {
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity || !this.#owns(identity) || this.#status === "closed")
      return this.requestedRevision;
    const previous = this.#overlays.get(identity);
    if (previous && version <= previous.version) return this.requestedRevision;
    this.#overlays.set(identity, { content, version });
    if (this.#includesDocument?.(identity)) this.#sourceIdentities.add(identity);
    return this.#scheduleCurrentDocuments();
  }

  #scheduleCurrentDocuments(): number {
    if (!this.#session || this.#status === "untrusted" || this.#status === "closed")
      return this.requestedRevision;
    return this.#scheduler.schedule(async (signal) => {
      await this.#applyDesired(
        new Map(this.#diskDocuments),
        new Set(this.#sourceIdentities),
        undefined,
        signal,
      );
      if (!signal.aborted) this.#status = "ready";
    });
  }

  async #applyDesired(
    diskDocuments: ReadonlyMap<string, LoadedDocument>,
    sourceIdentities: ReadonlySet<string>,
    config: CompilerSessionConfiguration | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const desired = new Map<string, string>();
    for (const identity of sourceIdentities) {
      const overlay = this.#overlays.get(identity);
      const disk = diskDocuments.get(identity);
      if (overlay) desired.set(identity, overlay.content);
      else if (disk) desired.set(identity, disk.content);
    }
    const changes: DocumentChange[] = [];
    for (const identity of this.#appliedContents.keys())
      if (!desired.has(identity)) changes.push({ kind: "remove", identity });
    for (const [identity, content] of desired) {
      const previous = this.#appliedContents.get(identity);
      if (previous === content) continue;
      changes.push({
        kind: previous === undefined ? "add" : "update",
        document: {
          identity,
          content,
          ...(this.#overlays.has(identity)
            ? { version: String(this.#overlays.get(identity)!.version) }
            : {}),
        },
      });
    }
    if (changes.length === 0 && !config) return;
    const snapshot = await session.apply(
      { documents: changes, ...(config ? { config } : {}) },
      { signal },
    );
    signal.throwIfAborted();
    this.#appliedContents = desired;
    this.#onSnapshot(snapshot, this);
  }
}

export interface WorkspaceManagerOptions {
  readonly projectLoader?: WorkspaceProjectLoader;
  readonly createSession?: typeof createCompilerSession;
  readonly onError?: WorkspaceCoordinatorOptions["onError"];
  readonly onSnapshot?: WorkspaceCoordinatorOptions["onSnapshot"];
}

export interface AddWorkspaceOptions {
  readonly trusted: boolean;
  readonly explicitConfigPath?: string;
}

/** Routes protocol events to the most specific workspace root. */
export class WorkspaceManager {
  readonly #options: WorkspaceManagerOptions;
  readonly #workspaces = new Map<string, WorkspaceCoordinator>();

  constructor(options: WorkspaceManagerOptions = {}) {
    this.#options = options;
  }

  get size(): number {
    return this.#workspaces.size;
  }

  get all(): readonly WorkspaceCoordinator[] {
    return Object.freeze([...this.#workspaces.values()]);
  }

  get(uri: string): WorkspaceCoordinator | undefined {
    return this.#workspaces.get(uri);
  }

  async add(
    folder: WorkspaceFolderIdentity,
    options: AddWorkspaceOptions,
  ): Promise<WorkspaceCoordinator> {
    const existing = this.#workspaces.get(folder.uri);
    if (existing) return existing;
    const workspace = new WorkspaceCoordinator({
      folder,
      trusted: options.trusted,
      ...(options.explicitConfigPath ? { explicitConfigPath: options.explicitConfigPath } : {}),
      ...(this.#options.projectLoader ? { projectLoader: this.#options.projectLoader } : {}),
      ...(this.#options.createSession ? { createSession: this.#options.createSession } : {}),
      ...(this.#options.onError ? { onError: this.#options.onError } : {}),
      ...(this.#options.onSnapshot ? { onSnapshot: this.#options.onSnapshot } : {}),
    });
    this.#workspaces.set(folder.uri, workspace);
    await workspace.initialize();
    return workspace;
  }

  async remove(uri: string): Promise<void> {
    const workspace = this.#workspaces.get(uri);
    if (!workspace) return;
    this.#workspaces.delete(uri);
    await workspace.close();
  }

  workspaceForDocument(uri: string): WorkspaceCoordinator | undefined {
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity) return undefined;
    return this.all
      .filter(
        (workspace): workspace is WorkspaceCoordinator & { readonly root: string } =>
          workspace.root !== undefined && isDocumentInsideWorkspace(identity, workspace.root),
      )
      .toSorted((left, right) => right.root.length - left.root.length)[0];
  }

  openDocument(uri: string, content: string, version: number): number | undefined {
    return this.workspaceForDocument(uri)?.openDocument(uri, content, version);
  }

  changeDocument(uri: string, content: string, version: number): number | undefined {
    return this.workspaceForDocument(uri)?.changeDocument(uri, content, version);
  }

  closeDocument(uri: string): number | undefined {
    return this.workspaceForDocument(uri)?.closeDocument(uri);
  }

  watchedFile(uri: string, change: WorkspaceFileChange): number | undefined {
    return this.workspaceForDocument(uri)?.watchedFile(uri, change);
  }

  async idle(): Promise<void> {
    await Promise.all(this.all.map((workspace) => workspace.idle()));
  }

  async close(): Promise<void> {
    const workspaces = this.all;
    this.#workspaces.clear();
    await Promise.all(workspaces.map((workspace) => workspace.close()));
  }
}
