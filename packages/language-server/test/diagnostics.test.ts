import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileDocuments, createDiagnostic } from "@tokenc/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DiagnosticSeverity, type PublishDiagnosticsParams } from "vscode-languageserver/node.js";

import {
  DiagnosticPublisher,
  diagnosticToLsp,
  offsetRangeToLspRange,
  offsetToPosition,
  type DiagnosticSourceDocument,
} from "../src/diagnostics.js";
import { WorkspaceCoordinator } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Diagnostic v1 LSP projection", () => {
  it("maps exact UTF-16/CRLF ranges, identity, documentation, and related locations", () => {
    const file = "/workspace/tokens.json";
    const content = "😀x\r\nyz";
    const sources: readonly DiagnosticSourceDocument[] = [
      {
        source: file,
        identity: "tokens.json",
        uri: pathToFileURL(file).href,
        content,
      },
    ];
    const diagnostic = createDiagnostic({
      code: "TOKEN_DUPLICATE_ID",
      message: "Duplicate token value",
      parameters: { token: "value" },
      source: { file, line: 1, column: 3, offset: 2, length: 4 },
      related: [
        {
          message: "First declared here",
          source: { file, line: 2, column: 1, offset: 5, length: 1 },
        },
      ],
    });

    expect(offsetToPosition(content, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetRangeToLspRange(content, diagnostic.source!.range)).toEqual({
      start: { line: 0, character: 2 },
      end: { line: 1, character: 1 },
    });
    expect(diagnosticToLsp(diagnostic, sources)).toEqual({
      range: {
        start: { line: 0, character: 2 },
        end: { line: 1, character: 1 },
      },
      severity: DiagnosticSeverity.Error,
      code: diagnostic.code,
      codeDescription: { href: diagnostic.documentationUrl },
      source: "tokenc",
      message: diagnostic.message,
      relatedInformation: [
        {
          location: {
            uri: pathToFileURL(file).href,
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 1 },
            },
          },
          message: "First declared here",
        },
      ],
      data: {
        schemaVersion: "1",
        fingerprint: diagnostic.fingerprint,
        parameters: diagnostic.parameters,
        fixes: [],
      },
    });
  });

  it("preserves CLI/Core diagnostic facts before transport formatting", async () => {
    const file = "/workspace/invalid.json";
    const snapshot = await compileDocuments([{ file, content: '{\r\n  "value":' }]);
    const source = snapshot.documents[0]!;
    const sources: readonly DiagnosticSourceDocument[] = [
      { ...source, uri: pathToFileURL(file).href },
    ];

    const projected = snapshot.diagnostics.map((diagnostic) => ({
      core: diagnostic,
      lsp: diagnosticToLsp(diagnostic, sources),
    }));

    expect(projected.length).toBeGreaterThan(0);
    for (const { core, lsp } of projected) {
      expect(lsp).toMatchObject({
        code: core.code,
        message: core.message,
        codeDescription: { href: core.documentationUrl },
        data: { schemaVersion: "1", fingerprint: core.fingerprint },
      });
    }
  });
});

describe("DiagnosticPublisher", () => {
  it("publishes current document versions, recovers, and clears removed documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-diagnostics-"));
    temporaryDirectories.push(root);
    const token = join(root, "tokens.json");
    await Promise.all([
      writeFile(
        join(root, "tokenc.config.mjs"),
        'export default { source: ["*.json"] };\n',
        "utf8",
      ),
      writeFile(token, '{"value":{"$type":"number","$value":1}}', "utf8"),
    ]);
    const publications: PublishDiagnosticsParams[] = [];
    const sendDiagnostics = vi.fn<(params: PublishDiagnosticsParams) => Promise<void>>(
      async (params) => {
        publications.push(params);
      },
    );
    const publisher = new DiagnosticPublisher({ sendDiagnostics });
    let workspace!: WorkspaceCoordinator;
    workspace = new WorkspaceCoordinator({
      folder: { name: "fixture", uri: pathToFileURL(root).href },
      trusted: true,
      onSnapshot: (snapshot, owner, revision) => publisher.publish(snapshot, owner, revision),
    });
    await workspace.initialize();
    await publisher.idle();

    const tokenUri = pathToFileURL(token).href;
    workspace.openDocument(tokenUri, '{\r\n  "value":', 1);
    await workspace.idle();
    await publisher.idle();
    expect(publications.at(-1)).toEqual(
      expect.objectContaining({
        uri: tokenUri,
        version: 1,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "TOKEN_INVALID_JSON" }),
        ]),
      }),
    );

    workspace.changeDocument(tokenUri, '{"value":{"$type":"number","$value":2}}', 2);
    await workspace.idle();
    await publisher.idle();
    expect(publications.at(-1)).toEqual({ uri: tokenUri, version: 2, diagnostics: [] });

    const draftUri = pathToFileURL(join(root, "draft.json")).href;
    workspace.openDocument(draftUri, '{"draft":', 1);
    await workspace.idle();
    await publisher.idle();
    expect(
      publications.some(
        (publication) =>
          publication.uri === draftUri &&
          publication.version === 1 &&
          publication.diagnostics.some((diagnostic) => diagnostic.code === "TOKEN_INVALID_JSON"),
      ),
    ).toBe(true);
    workspace.closeDocument(draftUri);
    await workspace.idle();
    await publisher.idle();
    expect(publications).toContainEqual({ uri: draftUri, diagnostics: [] });

    await workspace.close();
  });

  it("discards a superseded invalid revision before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-latest-"));
    temporaryDirectories.push(root);
    const token = join(root, "tokens.json");
    await Promise.all([
      writeFile(
        join(root, "tokenc.config.mjs"),
        'export default { source: ["tokens.json"] };\n',
        "utf8",
      ),
      writeFile(token, '{"value":{"$type":"number","$value":1}}', "utf8"),
    ]);
    const publications: PublishDiagnosticsParams[] = [];
    const publisher = new DiagnosticPublisher({
      sendDiagnostics: async (params) => {
        publications.push(params);
      },
    });
    let workspace!: WorkspaceCoordinator;
    workspace = new WorkspaceCoordinator({
      folder: { name: "fixture", uri: pathToFileURL(root).href },
      trusted: true,
      onSnapshot: (snapshot, owner, revision) => publisher.publish(snapshot, owner, revision),
    });
    await workspace.initialize();
    await publisher.idle();
    publications.length = 0;

    const uri = pathToFileURL(token).href;
    workspace.openDocument(uri, '{"value":', 1);
    workspace.changeDocument(uri, '{"value":{"$type":"number","$value":3}}', 2);
    await workspace.idle();
    await publisher.idle();

    expect(publications).toEqual([{ uri, version: 2, diagnostics: [] }]);
    expect(workspace.snapshot?.status).toBe("valid");
    expect(workspace.snapshot?.revision).toBe(2);
    await workspace.close();
  });
});
