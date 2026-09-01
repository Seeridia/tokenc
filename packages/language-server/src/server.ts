import type { CompilationContext } from "@tokenc/core";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  FileChangeType,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type InitializeParams,
  type InitializeResult,
  type WorkspaceFolder,
} from "vscode-languageserver/node.js";

import packageManifest from "../package.json" with { type: "json" };
import { DiagnosticPublisher } from "./diagnostics.js";
import { InsightProvider } from "./insight.js";
import { NavigationProvider } from "./navigation.js";
import {
  WorkspaceManager,
  type WorkspaceFileChange,
  type WorkspaceManagerOptions,
} from "./workspace.js";

export interface LanguageServerInitializationOptions {
  /** Fail-closed global trust opt-in for generic LSP clients. */
  readonly trusted?: boolean;
  /** Optional per-workspace overrides keyed by the exact workspace-folder URI. */
  readonly trustedWorkspaces?: Readonly<Record<string, boolean>>;
  /** Optional config path applied to every workspace folder. */
  readonly configPath?: string;
  /** Optional per-workspace config paths keyed by the exact workspace-folder URI. */
  readonly configPaths?: Readonly<Record<string, string>>;
  /** Active ordinary Context overrides shared by workspace folders without an override. */
  readonly context?: CompilationContext;
  /** Active Resolver input shared by workspace folders without an override. */
  readonly resolverInput?: CompilationContext;
  /** Per-folder query settings keyed by the exact workspace-folder URI. */
  readonly workspaceSettings?: Readonly<Record<string, LanguageServerWorkspaceSettings>>;
}

export interface LanguageServerWorkspaceSettings {
  readonly context?: CompilationContext;
  readonly resolverInput?: CompilationContext;
}

export interface LanguageServerOptions extends WorkspaceManagerOptions {
  readonly onExit?: (code: number) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function context(value: unknown): CompilationContext | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function workspaceSettings(value: unknown): LanguageServerWorkspaceSettings | undefined {
  if (!isRecord(value)) return undefined;
  const activeContext = context(value.context);
  const resolverInput = context(value.resolverInput);
  if (!activeContext && !resolverInput) return undefined;
  return {
    ...(activeContext ? { context: activeContext } : {}),
    ...(resolverInput ? { resolverInput } : {}),
  };
}

function initializationOptions(value: unknown): LanguageServerInitializationOptions {
  if (!isRecord(value)) return {};
  const trustedWorkspaces = isRecord(value.trustedWorkspaces)
    ? Object.fromEntries(
        Object.entries(value.trustedWorkspaces).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      )
    : undefined;
  const configPaths = isRecord(value.configPaths)
    ? Object.fromEntries(
        Object.entries(value.configPaths).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const activeContext = context(value.context);
  const resolverInput = context(value.resolverInput);
  const perWorkspaceSettings = isRecord(value.workspaceSettings)
    ? Object.fromEntries(
        Object.entries(value.workspaceSettings).flatMap(([uri, settings]) => {
          const parsed = workspaceSettings(settings);
          return parsed ? [[uri, parsed]] : [];
        }),
      )
    : undefined;
  return {
    ...(typeof value.trusted === "boolean" ? { trusted: value.trusted } : {}),
    ...(trustedWorkspaces ? { trustedWorkspaces } : {}),
    ...(typeof value.configPath === "string" ? { configPath: value.configPath } : {}),
    ...(configPaths ? { configPaths } : {}),
    ...(activeContext ? { context: activeContext } : {}),
    ...(resolverInput ? { resolverInput } : {}),
    ...(perWorkspaceSettings ? { workspaceSettings: perWorkspaceSettings } : {}),
  };
}

function configurationSettings(value: unknown): {
  readonly defaults: LanguageServerWorkspaceSettings;
  readonly workspaces: Readonly<Record<string, LanguageServerWorkspaceSettings>>;
} {
  const root = isRecord(value) && isRecord(value.tokenc) ? value.tokenc : value;
  if (!isRecord(root)) return { defaults: {}, workspaces: {} };
  const defaults = workspaceSettings(root) ?? {};
  const workspaces = isRecord(root.workspaces)
    ? Object.fromEntries(
        Object.entries(root.workspaces).flatMap(([uri, settings]) => {
          const parsed = workspaceSettings(settings);
          return parsed ? [[uri, parsed]] : [];
        }),
      )
    : {};
  return { defaults, workspaces };
}

function foldersFromInitialize(params: InitializeParams): readonly WorkspaceFolder[] {
  if (params.workspaceFolders) return params.workspaceFolders;
  if (params.rootUri) return [{ uri: params.rootUri, name: "workspace" }];
  return [];
}

function fileChange(type: FileChangeType): WorkspaceFileChange {
  if (type === FileChangeType.Created) return "created";
  if (type === FileChangeType.Deleted) return "deleted";
  return "changed";
}

export class TokencLanguageServer {
  readonly workspaces: WorkspaceManager;
  readonly #connection: Connection;
  readonly #documents = new TextDocuments(TextDocument);
  readonly #diagnostics: DiagnosticPublisher;
  readonly #insight: InsightProvider;
  readonly #navigation: NavigationProvider;
  readonly #onExit: (code: number) => void;
  #initialization: LanguageServerInitializationOptions = {};
  #shutdownRequested = false;
  #supportsWorkspaceFolders = false;
  #clientInitialized = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(connection: Connection, options: LanguageServerOptions = {}) {
    this.#connection = connection;
    this.#onExit = options.onExit ?? (() => undefined);
    this.#diagnostics = new DiagnosticPublisher(connection, {
      onError: (error) =>
        connection.console.error(
          `Diagnostic publication failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    this.workspaces = new WorkspaceManager({
      ...(options.projectLoader ? { projectLoader: options.projectLoader } : {}),
      ...(options.createSession ? { createSession: options.createSession } : {}),
      onError: (error, workspace) => {
        connection.console.error(
          `[${workspace.folder.name}] ${error instanceof Error ? error.message : String(error)}`,
        );
        this.#diagnostics.clear(workspace);
        options.onError?.(error, workspace);
      },
      onSnapshot: (snapshot, workspace, workspaceRevision) => {
        connection.console.log(
          `[${workspace.folder.name}] snapshot ${snapshot.revision} (${snapshot.status})`,
        );
        if (this.#clientInitialized)
          this.#diagnostics.publish(snapshot, workspace, workspaceRevision);
        options.onSnapshot?.(snapshot, workspace, workspaceRevision);
      },
    });
    this.#insight = new InsightProvider(this.workspaces);
    this.#navigation = new NavigationProvider(this.workspaces);
    this.#registerHandlers();
  }

  listen(): void {
    this.#documents.listen(this.#connection);
    this.#connection.listen();
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.#initialization = initializationOptions(params.initializationOptions);
    this.#supportsWorkspaceFolders = params.capabilities.workspace?.workspaceFolders === true;
    await Promise.all(foldersFromInitialize(params).map((folder) => this.#addWorkspace(folder)));
    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
        },
        definitionProvider: true,
        completionProvider: { triggerCharacters: ["{"] },
        hoverProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        workspace: {
          workspaceFolders: {
            supported: true,
            changeNotifications: true,
          },
        },
      },
      serverInfo: { name: "tokenc", version: packageManifest.version },
    };
  }

  async shutdown(): Promise<void> {
    this.#shutdownRequested = true;
    this.#shutdownPromise ??= this.workspaces.close();
    await this.#shutdownPromise;
    await this.#diagnostics.idle();
  }

  exit(): void {
    const code = this.#shutdownRequested ? 0 : 1;
    this.#shutdownPromise ??= this.workspaces.close();
    void this.#shutdownPromise.finally(() => {
      this.#connection.dispose();
      this.#onExit(code);
    });
  }

  #registerHandlers(): void {
    this.#connection.onInitialize((params) => this.initialize(params));
    this.#connection.onShutdown(() => this.shutdown());
    this.#connection.onExit(() => this.exit());
    this.#connection.onInitialized(() => {
      this.#clientInitialized = true;
      for (const workspace of this.workspaces.all) {
        const snapshot = workspace.snapshot;
        if (snapshot) this.#diagnostics.publish(snapshot, workspace, workspace.publishedRevision);
      }
      if (!this.#supportsWorkspaceFolders) return;
      this.#connection.workspace.onDidChangeWorkspaceFolders((event) => {
        void Promise.all([
          ...event.removed.map((folder) => this.#removeWorkspace(folder.uri)),
          ...event.added.map((folder) => this.#addWorkspace(folder)),
        ]);
      });
    });
    this.#connection.onDidChangeWatchedFiles((event) => {
      for (const change of event.changes)
        this.workspaces.watchedFile(change.uri, fileChange(change.type));
    });
    this.#connection.onDidChangeConfiguration(({ settings }) => {
      const configuration = configurationSettings(settings);
      for (const workspace of this.workspaces.all) {
        const scoped = configuration.workspaces[workspace.folder.uri];
        workspace.configure({ ...configuration.defaults, ...scoped });
      }
    });
    this.#connection.onCompletion((params) => this.#insight.completion(params));
    this.#connection.onHover((params) => this.#insight.hover(params));
    this.#connection.onDefinition((params) => this.#navigation.definition(params));
    this.#connection.onReferences((params) => this.#navigation.references(params));
    this.#connection.onDocumentSymbol((params) => this.#navigation.documentSymbols(params));
    this.#connection.onWorkspaceSymbol((params) => this.#navigation.workspaceSymbols(params));
    this.#documents.onDidOpen(({ document }) => {
      this.workspaces.openDocument(document.uri, document.getText(), document.version);
    });
    this.#documents.onDidChangeContent(({ document }) => {
      this.workspaces.changeDocument(document.uri, document.getText(), document.version);
    });
    this.#documents.onDidClose(({ document }) => {
      this.workspaces.closeDocument(document.uri);
    });
  }

  async #addWorkspace(folder: WorkspaceFolder): Promise<void> {
    const trusted =
      this.#initialization.trustedWorkspaces?.[folder.uri] ?? this.#initialization.trusted === true;
    const explicitConfigPath =
      this.#initialization.configPaths?.[folder.uri] ?? this.#initialization.configPath;
    const settings = this.#initialization.workspaceSettings?.[folder.uri];
    await this.workspaces.add(folder, {
      trusted,
      ...(explicitConfigPath ? { explicitConfigPath } : {}),
      ...((settings?.context ?? this.#initialization.context)
        ? { context: settings?.context ?? this.#initialization.context }
        : {}),
      ...((settings?.resolverInput ?? this.#initialization.resolverInput)
        ? { resolverInput: settings?.resolverInput ?? this.#initialization.resolverInput }
        : {}),
    });
  }

  async #removeWorkspace(uri: string): Promise<void> {
    const workspace = this.workspaces.get(uri);
    if (workspace) this.#diagnostics.clear(workspace);
    await this.workspaces.remove(uri);
  }
}

export function createLanguageServer(
  connection: Connection,
  options: LanguageServerOptions = {},
): TokencLanguageServer {
  return new TokencLanguageServer(connection, options);
}
