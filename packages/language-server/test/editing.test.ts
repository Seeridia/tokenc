import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ALL_TOKEN_TYPES,
  SymbolAllocator,
  createDiagnostic,
  documentContentDigest,
  type CompilerSessionConfiguration,
  type Diagnostic,
  type TokenBackend,
} from "@tokenc/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { LSPErrorCodes } from "vscode-languageserver/node.js";

import { diagnosticToLsp, type DiagnosticSourceDocument } from "../src/diagnostics.js";
import { EditingProvider } from "../src/editing.js";
import { WorkspaceManager, type WorkspaceProjectLoader } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

function position(content: string, needle: string, inside = 1) {
  const offset = content.indexOf(needle) + inside;
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function projectLoader(
  root: string,
  sources: Readonly<Record<string, string>>,
  config: CompilerSessionConfiguration = {},
): WorkspaceProjectLoader {
  return {
    async load() {
      return {
        configPath: join(root, "tokenc.config.mjs"),
        config,
        documents: Object.entries(sources).map(([identity, content]) => ({ identity, content })),
        documentLoader: {
          async load(request) {
            const content = sources[request.specifier];
            if (content === undefined) throw new Error(`Unknown document: ${request.specifier}`);
            return { identity: request.specifier, content };
          },
        },
        includesDocument: (identity: string) => identity in sources,
      };
    },
    async readDocument(identity) {
      const content = sources[identity];
      if (content === undefined) throw new Error(`Unknown document: ${identity}`);
      return { identity, content };
    },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function namingBackend(): TokenBackend {
  return {
    id: "names",
    capabilities: {
      tokenTypes: ALL_TOKEN_TYPES,
      referenceStrategies: new Set(["resolve"]),
      contextMode: "none",
      colorSpaces: "preserve",
      composite: "native",
    },
    prepare(ir) {
      const allocation = new SymbolAllocator().allocate({
        backendId: "names",
        requests: ir.sourceTokens.map((token) => ({
          id: String(token.id),
          token,
          namespace: {
            name: "test",
            caseSensitive: false,
            normalize: "NFC",
            reserved: new Set<string>(),
            pattern: /^[a-z][a-z0-9]*$/iu,
          },
          name: String(token.id).replaceAll(/[.-]/gu, ""),
        })),
      });
      return {
        backendId: "names",
        diagnostics: allocation.diagnostics,
        symbols: allocation.symbols,
        artifacts: [],
        data: null,
      };
    },
    emit: () => [],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("EditingProvider", () => {
  it("returns versioned atomic rename edits and surfaces Core collision diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-editing-rename-"));
    temporaryDirectories.push(root);
    const declaration = join(root, "declaration.json");
    const usage = join(root, "usage.json");
    const declarationContent = JSON.stringify({
      group: {
        source: { $type: "number", $value: 1 },
        taken: { $type: "number", $value: 2 },
        fooBar: { $type: "number", $value: 3 },
      },
    });
    const usageContent = JSON.stringify({
      alias: { $type: "number", $value: "{group.source}" },
    });
    const manager = new WorkspaceManager({
      projectLoader: projectLoader(
        root,
        {
          [declaration]: declarationContent,
          [usage]: usageContent,
        },
        { backends: [namingBackend()] },
      ),
    });
    await manager.add({ name: "fixture", uri: pathToFileURL(root).href }, { trusted: true });
    const editing = new EditingProvider(manager);
    const usageUri = pathToFileURL(usage).href;
    manager.openDocument(usageUri, usageContent, 4);
    await manager.idle();

    await expect(
      editing.prepareRename({
        textDocument: { uri: usageUri },
        position: position(usageContent, "{group.source}"),
      }),
    ).resolves.toMatchObject({ placeholder: "group.source" });
    await expect(
      editing.rename({
        textDocument: { uri: usageUri },
        position: position(usageContent, "{group.source}"),
        newName: "group.renamed",
      }),
    ).resolves.toMatchObject({
      documentChanges: [
        {
          textDocument: { uri: pathToFileURL(declaration).href, version: null },
          edits: [{ newText: '"renamed"' }],
        },
        {
          textDocument: { uri: usageUri, version: 4 },
          edits: [{ newText: "{group.renamed}" }],
        },
      ],
    });
    await expect(
      editing.rename({
        textDocument: { uri: usageUri },
        position: position(usageContent, "{group.source}"),
        newName: "group.taken",
      }),
    ).rejects.toMatchObject({
      code: LSPErrorCodes.RequestFailed,
      data: { status: "rejected", diagnostics: [{ code: "TOKEN_DUPLICATE_ID" }] },
    });
    await expect(
      editing.rename({
        textDocument: { uri: usageUri },
        position: position(usageContent, "{group.source}"),
        newName: "group.foo-bar",
      }),
    ).rejects.toMatchObject({
      code: LSPErrorCodes.RequestFailed,
      data: { status: "rejected", diagnostics: [{ code: "BACKEND_SYMBOL_COLLISION" }] },
    });
    await manager.close();
  });

  it("withholds rename edits when the workspace changes during Backend preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-editing-stale-"));
    temporaryDirectories.push(root);
    const source = join(root, "tokens.json");
    const content = JSON.stringify({ source: { $type: "number", $value: 1 } });
    const started = deferred();
    const release = deferred();
    const backend: TokenBackend = {
      id: "slow",
      capabilities: {
        tokenTypes: new Set(["number"]),
        referenceStrategies: new Set(["resolve"]),
        contextMode: "none",
        colorSpaces: "preserve",
        composite: "native",
      },
      async prepare() {
        started.resolve();
        await release.promise;
        return { backendId: "slow", diagnostics: [], symbols: [], artifacts: [], data: null };
      },
      emit: () => [],
    };
    const manager = new WorkspaceManager({
      projectLoader: projectLoader(root, { [source]: content }, { backends: [backend] }),
    });
    await manager.add({ name: "fixture", uri: pathToFileURL(root).href }, { trusted: true });
    const editing = new EditingProvider(manager);
    const uri = pathToFileURL(source).href;
    const pending = editing.rename({
      textDocument: { uri },
      position: position(content, '"source"'),
      newName: "renamed",
    });
    await started.promise;
    manager.openDocument(uri, content.replace("1", "2"), 1);
    release.resolve();

    await expect(pending).rejects.toMatchObject({ code: LSPErrorCodes.ContentModified });
    await manager.close();
  });

  it("exposes only current registry-approved fixes with version and digest guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-editing-fix-"));
    temporaryDirectories.push(root);
    const source = join(root, "tokens.json");
    const content = JSON.stringify({ value: { $type: "number", $value: 1 } });
    const valueOffset = content.lastIndexOf("1");
    const edit = {
      document: source,
      range: { line: 1, column: valueOffset + 1, offset: valueOffset, length: 1 },
      expectedDocumentDigest: documentContentDigest(content),
    };
    const diagnostic = createDiagnostic({
      code: "TOKEN_UNKNOWN_REFERENCE",
      message: "Choose a replacement value",
      parameters: { target: "missing" },
      source: { file: source, line: 1, column: valueOffset + 1, offset: valueOffset, length: 1 },
      fixes: [
        { title: "Use 2", applicability: "safe", edits: [{ ...edit, newText: "2" }] },
        {
          title: "Use 3",
          applicability: "requires-review",
          edits: [{ ...edit, newText: "3" }],
        },
      ],
    });
    const forbidden: Diagnostic = {
      ...diagnostic,
      code: "TOKEN_INVALID_JSON",
      fingerprint: "forged-forbidden-fix",
      message: "A registry-forbidden fix must not escape",
    };
    const config: CompilerSessionConfiguration & {
      readonly additionalDiagnostics: readonly Diagnostic[];
    } = {
      additionalDiagnostics: [diagnostic, forbidden],
    };
    const manager = new WorkspaceManager({
      projectLoader: projectLoader(root, { [source]: content }, config),
    });
    const workspace = await manager.add(
      { name: "fixture", uri: pathToFileURL(root).href },
      { trusted: true },
    );
    const editing = new EditingProvider(manager);
    const uri = pathToFileURL(source).href;
    const sources: readonly DiagnosticSourceDocument[] = [
      { source, identity: source, uri, content },
    ];
    const protocolDiagnostic = diagnosticToLsp(diagnostic, sources)!;
    const forbiddenProtocolDiagnostic = diagnosticToLsp(forbidden, sources)!;
    const params = {
      textDocument: { uri },
      range: protocolDiagnostic.range,
      context: { diagnostics: [protocolDiagnostic, forbiddenProtocolDiagnostic] },
    };

    expect(await editing.codeActions(params)).toMatchObject([
      {
        title: "Use 2",
        kind: "quickfix",
        isPreferred: true,
        edit: { documentChanges: [{ textDocument: { uri, version: null } }] },
      },
      {
        title: "Use 3",
        kind: "quickfix",
        isPreferred: false,
        edit: { documentChanges: [{ textDocument: { uri, version: null } }] },
      },
    ]);
    expect(
      await editing.codeActions({ ...params, context: { ...params.context, only: ["refactor"] } }),
    ).toEqual([]);

    workspace.openDocument(uri, content.replace("1", "10"), 7);
    await workspace.idle();
    expect(await editing.codeActions(params)).toEqual([]);
    await manager.close();
  });
});
