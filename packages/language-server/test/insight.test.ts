import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { InsightProvider } from "../src/insight.js";
import { NavigationProvider } from "../src/navigation.js";
import { WorkspaceManager } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

function position(content: string, needle: string, inside = 1) {
  const offset = content.indexOf(needle) + inside;
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hoverData(hover: Awaited<ReturnType<InsightProvider["hover"]>>): Record<string, unknown> {
  expect(hover).not.toBeNull();
  const contents = hover?.contents;
  expect(contents).toBeTypeOf("object");
  if (!isRecord(contents) || typeof contents.value !== "string") return {};
  const serialized = /```json\n([\s\S]+)\n```/u.exec(contents.value)?.[1];
  expect(serialized).toBeDefined();
  const parsed: unknown = JSON.parse(serialized!);
  expect(parsed).toBeTypeOf("object");
  return isRecord(parsed) ? parsed : {};
}

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `tokenc-lsp-insight-${name}-`));
  temporaryDirectories.push(root);
  const token = join(root, "tokens.json");
  const content = JSON.stringify({
    base: {
      $type: "number",
      $value: 1,
      $extensions: { "org.token-compiler.contexts": { "theme=dark": 2 } },
    },
    brand: { accent: { $type: "number", $value: 3 } },
    alias: { $type: "number", $value: "{base}" },
    conditional: {
      $type: "number",
      $value: 4,
      $extensions: { "org.token-compiler.contexts": { "theme=dark": "{base}" } },
    },
  });
  await Promise.all([
    writeFile(
      join(root, "tokenc.config.mjs"),
      'export default { source: ["tokens.json"], contexts: { theme: { default: "light", values: ["light", "dark"] } } };\n',
      "utf8",
    ),
    writeFile(token, content, "utf8"),
  ]);
  return { root, token, uri: pathToFileURL(token).href, content };
}

async function resolverFixture() {
  const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-insight-resolver-"));
  temporaryDirectories.push(root);
  const token = join(root, "foundation.json");
  const content = JSON.stringify({ alias: { $type: "number", $value: "{value}" } });
  await Promise.all([
    writeFile(
      join(root, "tokenc.config.mjs"),
      'export default { source: ["foundation.json"], contexts: { density: { default: "comfortable", values: ["comfortable", "compact"] } }, resolver: { source: "tokens.resolver.json", input: { theme: "light" } } };\n',
      "utf8",
    ),
    writeFile(
      join(root, "tokens.resolver.json"),
      JSON.stringify({
        version: "2025.10",
        sets: { foundation: { sources: [{ $ref: "foundation.json" }] } },
        modifiers: {
          theme: {
            contexts: {
              light: [{ $ref: "light.json" }],
              dark: [{ $ref: "dark.json" }],
            },
            default: "light",
          },
        },
        resolutionOrder: [{ $ref: "#/sets/foundation" }, { $ref: "#/modifiers/theme" }],
      }),
      "utf8",
    ),
    writeFile(
      join(root, "light.json"),
      JSON.stringify({ value: { $type: "number", $value: 1 } }),
      "utf8",
    ),
    writeFile(
      join(root, "dark.json"),
      JSON.stringify({ value: { $type: "number", $value: 2 } }),
      "utf8",
    ),
    writeFile(token, content, "utf8"),
  ]);
  return { root, token, uri: pathToFileURL(token).href, content };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("InsightProvider", () => {
  it("offers stable canonical completions only inside a Core-proven alias", async () => {
    const project = await fixture("completion");
    const manager = new WorkspaceManager();
    await manager.add(
      { name: "fixture", uri: pathToFileURL(project.root).href },
      { trusted: true },
    );
    const insight = new InsightProvider(manager);

    const completion = await insight.completion({
      textDocument: { uri: project.uri },
      position: position(project.content, "{base}", 2),
    });
    expect(completion).toMatchObject({
      isIncomplete: false,
      items: [
        {
          label: "base",
          detail: "number",
          textEdit: { newText: "base" },
        },
        {
          label: "brand.accent",
          detail: "number",
          textEdit: { newText: "brand.accent" },
        },
      ],
    });
    expect(
      await insight.completion({
        textDocument: { uri: project.uri },
        position: position(project.content, '"$type"'),
      }),
    ).toBeNull();
    await manager.close();
  });

  it("keeps active Context query-only, applies Resolver input transactionally, and isolates roots", async () => {
    const alpha = await fixture("alpha");
    const beta = await fixture("beta");
    const manager = new WorkspaceManager();
    const [alphaWorkspace, betaWorkspace] = await Promise.all([
      manager.add(
        { name: "alpha", uri: pathToFileURL(alpha.root).href },
        { trusted: true, context: { theme: "dark" } },
      ),
      manager.add(
        { name: "beta", uri: pathToFileURL(beta.root).href },
        { trusted: true, context: { theme: "light" } },
      ),
    ]);
    const insight = new InsightProvider(manager);
    const navigation = new NavigationProvider(manager);
    const alphaDark = hoverData(
      await insight.hover({
        textDocument: { uri: alpha.uri },
        position: position(alpha.content, "{base}"),
      }),
    );
    const betaLight = hoverData(
      await insight.hover({
        textDocument: { uri: beta.uri },
        position: position(beta.content, "{base}"),
      }),
    );
    expect(alphaDark).toMatchObject({
      token: "base",
      type: "number",
      expression: { kind: "literal", value: 2 },
      resolvedValue: 2,
      context: { theme: "dark" },
      provenance: { steps: [{ selection: "override" }] },
    });
    expect(betaLight).toMatchObject({
      token: "base",
      resolvedValue: 1,
      context: { theme: "light" },
    });
    expect(
      await navigation.references({
        textDocument: { uri: alpha.uri },
        position: position(alpha.content, '"base"'),
        context: { includeDeclaration: false },
      }),
    ).toHaveLength(2);

    const snapshot = alphaWorkspace.snapshot;
    const metrics = alphaWorkspace.session?.metrics;
    alphaWorkspace.configure({ context: { theme: "light" } });
    await alphaWorkspace.idle();
    expect(alphaWorkspace.snapshot).toBe(snapshot);
    expect(alphaWorkspace.session?.metrics).toBe(metrics);
    expect(
      await navigation.references({
        textDocument: { uri: alpha.uri },
        position: position(alpha.content, '"base"'),
        context: { includeDeclaration: false },
      }),
    ).toHaveLength(1);
    expect(
      hoverData(
        await insight.hover({
          textDocument: { uri: alpha.uri },
          position: position(alpha.content, "{base}"),
        }),
      ),
    ).toMatchObject({ resolvedValue: 1, context: { theme: "light" } });
    expect(betaWorkspace.effectiveContext()).toEqual({ theme: "light" });

    alphaWorkspace.configure({ resolverInput: { theme: "dark" } });
    await alphaWorkspace.idle();
    expect(alphaWorkspace.snapshot?.revision).toBe((snapshot?.revision ?? 0) + 1);
    expect(alphaWorkspace.effectiveContext()).toEqual({ theme: "light" });
    expect(alphaWorkspace.session?.metrics).toMatchObject({
      stages: {
        parse: { recomputed: 0 },
        link: { recomputed: 0 },
        graph: { recomputed: 0 },
      },
    });
    await manager.close();
  });

  it("preserves the latest desired Context and Resolver input across superseded configuration work", async () => {
    const project = await resolverFixture();
    const manager = new WorkspaceManager();
    const workspace = await manager.add(
      { name: "resolver", uri: pathToFileURL(project.root).href },
      { trusted: true },
    );
    const insight = new InsightProvider(manager);
    const value = async () =>
      hoverData(
        await insight.hover({
          textDocument: { uri: project.uri },
          position: position(project.content, "{value}"),
        }),
      );

    expect(await value()).toMatchObject({ resolvedValue: 1 });
    workspace.configure({ resolverInput: { theme: "dark" } });
    workspace.configure({ context: { density: "compact" } });
    await workspace.idle();
    expect(await value()).toMatchObject({
      resolvedValue: 2,
      context: { density: "compact" },
      provenance: { resolverSteps: [{ kind: "set" }, { context: "dark" }] },
    });

    workspace.configure({ context: { density: "comfortable" } });
    workspace.configure({ resolverInput: { theme: "light" } });
    await workspace.idle();
    expect(await value()).toMatchObject({
      resolvedValue: 1,
      context: { density: "comfortable" },
      provenance: { resolverSteps: [{ kind: "set" }, { context: "light" }] },
    });
    await manager.close();
  });
});
