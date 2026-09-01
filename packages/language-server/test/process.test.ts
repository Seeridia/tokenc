import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

interface RpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly params?: unknown;
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return typeof value === "object" && value !== null;
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

  waitFor(predicate: (message: RpcMessage) => boolean): Promise<RpcMessage> {
    const existing = this.#messages.find(predicate);
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
    const content = JSON.stringify({ value: { $type: "number", $value: 1 } });
    await Promise.all([
      writeFile(
        join(project, "tokenc.config.mjs"),
        'export default { source: ["tokens.json"] };\n',
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
      capabilities: { workspace: { workspaceFolders: true } },
      workspaceFolders: [{ name: "fixture", uri: pathToFileURL(project).href }],
      initializationOptions: { trusted: true },
    });
    expect(initialize.result).toMatchObject({
      capabilities: {
        textDocumentSync: { change: 2, openClose: true },
        workspace: { workspaceFolders: { supported: true } },
      },
    });

    client.notify("initialized", {});
    const openContent = JSON.stringify({ value: { $type: "number", $value: 2 } });
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(token).href,
        languageId: "json",
        version: 1,
        text: openContent,
      },
    });
    await client.waitFor(
      (message) =>
        message.method === "window/logMessage" &&
        JSON.stringify(message.params).includes("snapshot 2 (valid)"),
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
