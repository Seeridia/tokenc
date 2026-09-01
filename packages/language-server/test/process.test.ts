import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { TextDocument } from "vscode-languageserver-textdocument";
import { WorkspaceEdit, type TextDocumentEdit } from "vscode-languageserver/node.js";

interface RpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
}

function applyWorkspaceEdit(uri: string, content: string, edit: WorkspaceEdit): string {
  const changes = (edit.documentChanges ?? []).filter(
    (change): change is TextDocumentEdit =>
      "textDocument" in change && change.textDocument.uri === uri,
  );
  return changes.reduce(
    (current, change) =>
      TextDocument.applyEdits(TextDocument.create(uri, "json", 0, current), change.edits),
    content,
  );
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return typeof value === "object" && value !== null;
}

function position(content: string, needle: string, inside = 1) {
  const offset = content.indexOf(needle) + inside;
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

class StdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (message: RpcMessage) => void>();
  readonly #messages: RpcMessage[] = [];
  readonly #waiters: Array<{
    readonly predicate: (message: RpcMessage) => boolean;
    readonly resolve: (message: RpcMessage) => void;
  }> = [];
  #buffer = Buffer.alloc(0);
  #nextId = 1;

  constructor(cwd: string) {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/language-server/src/bin.ts", "--stdio"],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
  }

  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.#nextId++;
    const response = new Promise<RpcMessage>((resolveResponse) => {
      this.#pending.set(id, resolveResponse);
    });
    this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return response;
  }

  get messageCount(): number {
    return this.#messages.length;
  }

  waitFor(predicate: (message: RpcMessage) => boolean, afterMessage = 0): Promise<RpcMessage> {
    const existing = this.#messages.slice(afterMessage).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<RpcMessage>((resolveMessage) => {
      this.#waiters.push({ predicate, resolve: resolveMessage });
    });
  }

  #send(message: object): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
    this.child.stdin.write(payload);
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const length = /content-length:\s*(\d+)/iu.exec(header)?.[1];
      if (!length) throw new Error(`Missing Content-Length in ${header}`);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(length);
      if (this.#buffer.byteLength < bodyEnd) return;
      const parsed: unknown = JSON.parse(
        this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
      );
      if (!isRpcMessage(parsed)) throw new TypeError("Invalid JSON-RPC message");
      this.#buffer = this.#buffer.subarray(bodyEnd);
      this.#dispatch(parsed);
    }
  }

  #dispatch(message: RpcMessage): void {
    if (message.id !== undefined) {
      const resolveResponse = this.#pending.get(message.id);
      if (resolveResponse) {
        this.#pending.delete(message.id);
        resolveResponse(message);
        return;
      }
    }
    this.#messages.push(message);
    const index = this.#waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) return;
    const [waiter] = this.#waiters.splice(index, 1);
    waiter?.resolve(message);
  }
}

const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("stdio language server", () => {
  it("initializes, compiles an open buffer, shuts down, and exits without leaked handles", async () => {
    const project = await mkdtemp(join(tmpdir(), "tokenc-lsp-process-"));
    temporaryDirectories.push(project);
    const token = join(project, "tokens.json");
    const content =
      '{\r\n  "base😀": { "$type": "number", "$value": 1, "$extensions": { "org.token-compiler.contexts": { "theme=dark": 2 } } },\r\n  "alias": { "$type": "number", "$value": "{base😀}" }\r\n}\r\n';
    await Promise.all([
      writeFile(
        join(project, "tokenc.config.mjs"),
        'export default { source: ["tokens.json"], contexts: { theme: { default: "light", values: ["light", "dark"] } } };\n',
        "utf8",
      ),
      writeFile(token, content, "utf8"),
    ]);
    const client = new StdioClient(resolve(import.meta.dirname, "../../.."));
    children.push(client.child);
    let stderr = "";
    client.child.stderr.setEncoding("utf8");
    client.child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const initialize = await client.request("initialize", {
      processId: process.pid,
      capabilities: {
        workspace: { workspaceFolders: true, workspaceEdit: { documentChanges: true } },
      },
      workspaceFolders: [{ name: "fixture", uri: pathToFileURL(project).href }],
      initializationOptions: { trusted: true, context: { theme: "dark" } },
    });
    expect(initialize.result).toMatchObject({
      capabilities: {
        textDocumentSync: { change: 2, openClose: true },
        completionProvider: { triggerCharacters: ["{"] },
        hoverProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: { codeActionKinds: ["quickfix"] },
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        workspace: { workspaceFolders: { supported: true } },
      },
    });

    client.notify("initialized", {});
    const tokenUri = pathToFileURL(token).href;
    const definition = await client.request("textDocument/definition", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}"),
    });
    expect(definition.result).toMatchObject({
      uri: tokenUri,
      range: { start: position(content, '"base😀"', 0) },
    });
    const references = await client.request("textDocument/references", {
      textDocument: { uri: tokenUri },
      position: position(content, '"base😀"'),
      context: { includeDeclaration: true },
    });
    expect(references.result).toMatchObject([
      { uri: tokenUri, range: { start: position(content, '"base😀"', 0) } },
      { uri: tokenUri, range: { start: position(content, "{base😀}", 0) } },
    ]);
    const documentSymbols = await client.request("textDocument/documentSymbol", {
      textDocument: { uri: tokenUri },
    });
    expect(documentSymbols.result).toMatchObject([{ name: "base😀" }, { name: "alias" }]);
    const workspaceSymbols = await client.request("workspace/symbol", { query: "BASE" });
    expect(workspaceSymbols.result).toMatchObject([
      { name: "base😀", location: { uri: tokenUri } },
    ]);
    const completion = await client.request("textDocument/completion", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}", 2),
    });
    expect(completion.result).toMatchObject({
      isIncomplete: false,
      items: [{ label: "base😀", detail: "number", textEdit: { newText: "base😀" } }],
    });
    const darkHover = await client.request("textDocument/hover", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}"),
    });
    expect(JSON.stringify(darkHover.result)).toContain('\\"theme\\": \\"dark\\"');
    expect(JSON.stringify(darkHover.result)).toContain('\\"resolvedValue\\": 2');
    client.notify("workspace/didChangeConfiguration", {
      settings: { tokenc: { context: { theme: "light" } } },
    });
    const lightHover = await client.request("textDocument/hover", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}"),
    });
    expect(JSON.stringify(lightHover.result)).toContain('\\"theme\\": \\"light\\"');
    expect(JSON.stringify(lightHover.result)).toContain('\\"resolvedValue\\": 1');

    const preparedRename = await client.request("textDocument/prepareRename", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}"),
    });
    expect(preparedRename.result).toMatchObject({ placeholder: "base😀" });
    const collision = await client.request("textDocument/rename", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}"),
      newName: "alias",
    });
    expect(collision.error).toMatchObject({
      data: { status: "rejected", diagnostics: [{ code: "TOKEN_DUPLICATE_ID" }] },
    });
    const rename = await client.request("textDocument/rename", {
      textDocument: { uri: tokenUri },
      position: position(content, "{base😀}"),
      newName: "renamed😀",
    });
    if (!WorkspaceEdit.is(rename.result)) throw new TypeError("Expected a WorkspaceEdit response");
    const renamedContent = applyWorkspaceEdit(tokenUri, content, rename.result);
    expect(renamedContent).toContain('"renamed😀"');
    expect(renamedContent).toContain("{renamed😀}");
    expect(await readFile(token, "utf8")).toBe(content);

    const openContent = renamedContent.replace('"$value": 1', '"$value": 2');
    let marker = client.messageCount;
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: tokenUri,
        languageId: "json",
        version: 1,
        text: openContent,
      },
    });
    await client.waitFor(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        JSON.stringify(message.params).includes('"version":1') &&
        JSON.stringify(message.params).includes('"diagnostics":[]'),
      marker,
    );
    const renamedDefinition = await client.request("textDocument/definition", {
      textDocument: { uri: tokenUri },
      position: position(openContent, "{renamed😀}"),
    });
    expect(renamedDefinition.result).toMatchObject({
      uri: tokenUri,
      range: { start: position(openContent, '"renamed😀"', 0) },
    });

    marker = client.messageCount;
    client.notify("textDocument/didChange", {
      textDocument: { uri: tokenUri, version: 2 },
      contentChanges: [{ text: '{\r\n  "value":' }],
    });
    const invalid = await client.waitFor(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        JSON.stringify(message.params).includes('"version":2') &&
        JSON.stringify(message.params).includes("TOKEN_INVALID_JSON"),
      marker,
    );
    const invalidJson = JSON.stringify(invalid.params);
    expect(invalidJson).toContain('"version":2');
    expect(invalidJson).toContain('"code":"TOKEN_INVALID_JSON"');
    expect(invalidJson).toContain('"codeDescription":{"href":');
    expect(invalidJson).toContain('"data":{"schemaVersion":"1","fingerprint":');

    marker = client.messageCount;
    client.notify("textDocument/didChange", {
      textDocument: { uri: tokenUri, version: 3 },
      contentChanges: [{ text: content }],
    });
    await client.waitFor(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        JSON.stringify(message.params).includes('"version":3') &&
        JSON.stringify(message.params).includes('"diagnostics":[]'),
      marker,
    );

    marker = client.messageCount;
    client.notify("textDocument/didClose", {
      textDocument: { uri: tokenUri },
    });
    await client.waitFor(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        JSON.stringify(message.params).includes(tokenUri) &&
        !JSON.stringify(message.params).includes('"version"') &&
        JSON.stringify(message.params).includes('"diagnostics":[]'),
      marker,
    );

    const shutdown = await client.request("shutdown");
    expect(shutdown.result).toBeNull();
    client.notify("exit");
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(
        () => rejectExit(new Error(`Server did not exit: ${stderr}`)),
        5_000,
      );
      client.child.once("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  }, 10_000);
});
