import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createCompilerSession, parseTokenId } from "@tokenc/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  NodeWorkspaceProjectLoader,
  WorkspaceCoordinator,
  WorkspaceManager,
  type WorkspaceProjectLoader,
} from "../src/workspace.js";

const temporaryDirectories: string[] = [];

async function fixture(value: number): Promise<{ readonly root: string; readonly token: string }> {
  const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-workspace-"));
  temporaryDirectories.push(root);
  const token = join(root, "tokens.json");
  await Promise.all([
    writeFile(
      join(root, "tokenc.config.mjs"),
      'export default { source: ["tokens.json"] };\n',
      "utf8",
    ),
    writeFile(token, JSON.stringify({ value: { $type: "number", $value: value } }), "utf8"),
  ]);
  return { root, token };
}

function resolvedValue(workspace: WorkspaceCoordinator): unknown {
  const snapshot = workspace.snapshot;
  expect(snapshot?.status).toBe("valid");
  if (!snapshot || snapshot.status !== "valid") return undefined;
  return snapshot.query.resolve(parseTokenId("value"))?.value;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspaceCoordinator", () => {
  it("fails closed without executing a project loader for an untrusted workspace", async () => {
    const load = vi.fn<WorkspaceProjectLoader["load"]>();
    const workspace = new WorkspaceCoordinator({
      folder: { name: "untrusted", uri: pathToFileURL("/workspace/untrusted").href },
      trusted: false,
      projectLoader: {
        load,
        readDocument: vi.fn<WorkspaceProjectLoader["readDocument"]>(),
      },
    });

    await workspace.initialize();

    expect(workspace.status).toBe("untrusted");
    expect(workspace.session).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    await workspace.close();
  });

  it("keeps one Session while overlays win over disk and close restores disk", async () => {
    const { root, token } = await fixture(1);
    const createSession = vi.fn<typeof createCompilerSession>(createCompilerSession);
    const snapshots: number[] = [];
    const workspace = new WorkspaceCoordinator({
      folder: { name: "tokens", uri: pathToFileURL(root).href },
      trusted: true,
      createSession,
      onSnapshot: (snapshot) => snapshots.push(snapshot.revision),
    });
    await workspace.initialize();
    expect(resolvedValue(workspace)).toBe(1);

    const uri = pathToFileURL(token).href;
    workspace.openDocument(uri, JSON.stringify({ value: { $type: "number", $value: 2 } }), 1);
    workspace.changeDocument(uri, JSON.stringify({ value: { $type: "number", $value: 3 } }), 2);
    await workspace.idle();
    expect(resolvedValue(workspace)).toBe(3);
    expect(workspace.publishedRevision).toBe(3);

    workspace.changeDocument(uri, JSON.stringify({ value: { $type: "number", $value: 99 } }), 1);
    await workspace.idle();
    expect(resolvedValue(workspace)).toBe(3);

    await writeFile(token, JSON.stringify({ value: { $type: "number", $value: 4 } }), "utf8");
    workspace.watchedFile(uri, "changed");
    await workspace.idle();
    expect(resolvedValue(workspace)).toBe(3);

    workspace.closeDocument(uri);
    await workspace.idle();
    expect(resolvedValue(workspace)).toBe(4);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(snapshots).toEqual([1, 2, 2, 3]);
    await workspace.close();
  });

  it("accepts an unsaved new source when its identity matches the configured glob", async () => {
    const { root } = await fixture(1);
    await writeFile(
      join(root, "tokenc.config.mjs"),
      'export default { source: ["*.json"] };\n',
      "utf8",
    );
    const workspace = new WorkspaceCoordinator({
      folder: { name: "tokens", uri: pathToFileURL(root).href },
      trusted: true,
    });
    await workspace.initialize();
    const draftUri = pathToFileURL(join(root, "draft.json")).href;
    workspace.openDocument(draftUri, JSON.stringify({ draft: { $type: "number", $value: 8 } }), 1);
    await workspace.idle();

    expect(workspace.snapshot?.query.token(parseTokenId("draft"))).toBeDefined();
    workspace.closeDocument(draftUri);
    await workspace.idle();
    expect(workspace.snapshot?.query.token(parseTokenId("draft"))).toBeUndefined();
    await workspace.close();
  });

  it("aborts superseded file loading without committing or publishing its revision", async () => {
    const { root, token } = await fixture(1);
    const baseLoader = new NodeWorkspaceProjectLoader();
    const started = deferred();
    let aborted = false;
    const projectLoader: WorkspaceProjectLoader = {
      load: (workspaceRoot, configPath, signal) =>
        baseLoader.load(workspaceRoot, configPath, signal),
      readDocument: (_identity, signal) =>
        new Promise((_resolveDocument, rejectDocument) => {
          started.resolve();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              rejectDocument(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const publishedWorkspaceRevisions: number[] = [];
    const workspace = new WorkspaceCoordinator({
      folder: { name: "tokens", uri: pathToFileURL(root).href },
      trusted: true,
      projectLoader,
      onSnapshot: (_snapshot, _workspace, revision) => publishedWorkspaceRevisions.push(revision),
    });
    await workspace.initialize();

    const uri = pathToFileURL(token).href;
    workspace.watchedFile(uri, "changed");
    await started.promise;
    workspace.changeDocument(uri, JSON.stringify({ value: { $type: "number", $value: 9 } }), 1);
    await workspace.idle();

    expect(aborted).toBe(true);
    expect(resolvedValue(workspace)).toBe(9);
    expect(workspace.snapshot?.revision).toBe(2);
    expect(workspace.requestedRevision).toBe(3);
    expect(workspace.publishedRevision).toBe(3);
    expect(publishedWorkspaceRevisions).toEqual([1, 3]);
    await workspace.close();
  });

  it("reloads configuration conservatively for unknown watched files", async () => {
    const { root } = await fixture(1);
    const second = join(root, "second.json");
    await writeFile(second, JSON.stringify({ second: { $type: "number", $value: 2 } }), "utf8");
    const workspace = new WorkspaceCoordinator({
      folder: { name: "tokens", uri: pathToFileURL(root).href },
      trusted: true,
    });
    await workspace.initialize();
    expect(workspace.snapshot?.query.token(parseTokenId("second"))).toBeUndefined();

    await writeFile(
      join(root, "tokenc.config.mjs"),
      'export default { source: ["tokens.json", "second.json"] };\n',
      "utf8",
    );
    workspace.watchedFile(pathToFileURL(join(root, "tokenc.config.mjs")).href, "changed");
    await workspace.idle();

    expect(workspace.status).toBe("ready");
    expect(workspace.snapshot?.query.token(parseTokenId("second"))).toBeDefined();
    await workspace.close();
  });
});

describe("WorkspaceManager", () => {
  it("isolates equal relative paths in two workspace folders", async () => {
    const alpha = await fixture(1);
    const beta = await fixture(2);
    const manager = new WorkspaceManager({ projectLoader: new NodeWorkspaceProjectLoader() });
    const [alphaWorkspace, betaWorkspace] = await Promise.all([
      manager.add({ name: "alpha", uri: pathToFileURL(alpha.root).href }, { trusted: true }),
      manager.add({ name: "beta", uri: pathToFileURL(beta.root).href }, { trusted: true }),
    ]);

    expect(resolvedValue(alphaWorkspace)).toBe(1);
    expect(resolvedValue(betaWorkspace)).toBe(2);
    manager.openDocument(
      pathToFileURL(alpha.token).href,
      JSON.stringify({ value: { $type: "number", $value: 7 } }),
      1,
    );
    await manager.idle();

    expect(resolvedValue(alphaWorkspace)).toBe(7);
    expect(resolvedValue(betaWorkspace)).toBe(2);
    expect(alphaWorkspace.session).not.toBe(betaWorkspace.session);
    await manager.close();
  });
});
