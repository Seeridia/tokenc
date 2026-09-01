import { join } from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

import {
  configuredProfiles,
  createConfigurationSettings,
  createInitializationOptions,
  stringMap,
  type FolderConfiguration,
  type StringMap,
} from "./configuration.js";
import { ClientLifecycle, type LifecycleClient } from "./lifecycle.js";

const CONFIGURATION_SECTION = "tokenc";
const SERVER_NAME = "tokenc Language Server";

interface ManagedLanguageClient extends LifecycleClient {
  readonly languageClient: LanguageClient;
}

const lifecycle = new ClientLifecycle<ManagedLanguageClient>();
const selectedContexts = new Map<string, StringMap>();
const selectedResolverInputs = new Map<string, StringMap>();
let extensionContext: vscode.ExtensionContext | undefined;

function readFolderConfiguration(
  folder: vscode.WorkspaceFolder | undefined,
  contextOverrides = selectedContexts,
  resolverOverrides = selectedResolverInputs,
): FolderConfiguration {
  const scope = folder?.uri;
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, scope);
  const configPath = configuration.get<string>("configPath")?.trim();
  const uri = scope?.toString() ?? "";
  return {
    uri,
    ...(configPath ? { configPath } : {}),
    context: contextOverrides.get(uri) ?? stringMap(configuration.get("context")),
    resolverInput: resolverOverrides.get(uri) ?? stringMap(configuration.get("resolverInput")),
  };
}

function readServerConfiguration(): {
  readonly defaults: FolderConfiguration;
  readonly folders: readonly FolderConfiguration[];
} {
  const defaults = readFolderConfiguration(undefined, new Map(), new Map());
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    readFolderConfiguration(folder),
  );
  return { defaults, folders };
}

function initializationOptions() {
  const { defaults, folders } = readServerConfiguration();
  return createInitializationOptions(vscode.workspace.isTrusted, defaults, folders);
}

function runtimeSettings() {
  const { defaults, folders } = readServerConfiguration();
  return createConfigurationSettings(defaults, folders);
}

function createClient(context: vscode.ExtensionContext): ManagedLanguageClient {
  const serverModule = context.asAbsolutePath(join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const watchers = [
    vscode.workspace.createFileSystemWatcher("**/*.json"),
    vscode.workspace.createFileSystemWatcher("**/tokenc.config.{ts,mts,js,mjs}"),
  ];
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: "json", scheme: "file" },
      { language: "jsonc", scheme: "file" },
    ],
    initializationOptions,
    synchronize: { fileEvents: watchers },
  };
  const languageClient = new LanguageClient("tokenc", SERVER_NAME, serverOptions, clientOptions);
  return {
    languageClient,
    start: () => languageClient.start(),
    stop: async () => {
      for (const watcher of watchers) watcher.dispose();
      if (languageClient.needsStop()) await languageClient.stop();
    },
  };
}

async function restartServer(showConfirmation = false): Promise<void> {
  const context = extensionContext;
  if (!context) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Restarting ${SERVER_NAME}` },
    () => lifecycle.restart(() => createClient(context)),
  );
  if (showConfirmation) await vscode.window.showInformationMessage(`${SERVER_NAME} restarted.`);
}

async function sendConfiguration(): Promise<void> {
  const client = lifecycle.client?.languageClient;
  if (!client || lifecycle.state !== "running") return;
  await client.sendNotification("workspace/didChangeConfiguration", {
    settings: runtimeSettings(),
  });
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await vscode.window.showWarningMessage("Open a tokenc workspace before selecting a profile.");
    return undefined;
  }
  const activeFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : undefined;
  if (folders.length === 1 || activeFolder) return activeFolder ?? folders[0];
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, folder })),
    { placeHolder: "Select a tokenc workspace folder" },
  );
  return selected?.folder;
}

async function selectProfile(kind: "context" | "resolverInput"): Promise<void> {
  const folder = await selectWorkspaceFolder();
  if (!folder) return;
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, folder.uri);
  const setting = kind === "context" ? "contextProfiles" : "resolverInputProfiles";
  const profiles = configuredProfiles(configuration.get(setting));
  const names = Object.keys(profiles);
  if (names.length === 0) {
    await vscode.window.showWarningMessage(
      `Configure tokenc.${setting} before using this command.`,
    );
    return;
  }
  const selected = await vscode.window.showQuickPick(
    [
      { label: "$(circle-slash) Configured default", name: undefined },
      ...names.map((name) => ({ label: name, name })),
    ],
    { placeHolder: `Select ${kind === "context" ? "Context" : "Resolver input"} profile` },
  );
  if (!selected) return;
  const overrides = kind === "context" ? selectedContexts : selectedResolverInputs;
  const uri = folder.uri.toString();
  if (selected.name) overrides.set(uri, profiles[selected.name]!);
  else overrides.delete(uri);
  await sendConfiguration();
  await vscode.window.showInformationMessage(
    `${kind === "context" ? "Context" : "Resolver input"} for ${folder.name}: ${selected.name ?? "configured default"}`,
  );
}

async function showStatus(): Promise<void> {
  const trust = vscode.workspace.isTrusted ? "trusted" : "untrusted (config execution disabled)";
  await vscode.window.showInformationMessage(
    `${SERVER_NAME}: ${lifecycle.state}; workspace: ${trust}.`,
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenc.restartLanguageServer", () => restartServer(true)),
    vscode.commands.registerCommand("tokenc.selectContext", () => selectProfile("context")),
    vscode.commands.registerCommand("tokenc.selectResolverInput", () =>
      selectProfile("resolverInput"),
    ),
    vscode.commands.registerCommand("tokenc.showLanguageServerStatus", showStatus),
    vscode.workspace.onDidGrantWorkspaceTrust(() => restartServer()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIGURATION_SECTION)) return;
      selectedContexts.clear();
      selectedResolverInputs.clear();
      void restartServer();
    }),
    { dispose: () => void lifecycle.stop() },
  );
  await restartServer();
}

export async function deactivate(): Promise<void> {
  extensionContext = undefined;
  await lifecycle.stop();
}
