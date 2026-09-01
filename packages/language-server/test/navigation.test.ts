import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { NavigationProvider } from "../src/navigation.js";
import { WorkspaceManager } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

function position(content: string, needle: string, inside = 1) {
  const offset = content.indexOf(needle) + inside;
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NavigationProvider", () => {
  it("projects every Core reference role and symbol query with exact deterministic locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-navigation-"));
    temporaryDirectories.push(root);
    const declarationsPath = join(root, "declarations.json");
    const usagesPath = join(root, "usages.json");
    const declarations =
      '{\r\n  "base😀": { "$type": "number", "$value": 1 },\r\n  "pointer": { "$type": "number", "$ref": "#/base😀/$value" },\r\n  "palette": { "source": { "$type": "gradient", "$value": [{ "color": { "colorSpace": "srgb", "components": [1, 0, 0] }, "position": 0 }] } },\r\n  "foundation": { "value": { "$type": "number", "$value": 2 } }\r\n}\r\n';
    const usages = JSON.stringify({
      alias: { $type: "number", $value: "{base😀}" },
      combined: { $type: "gradient", $value: ["{palette.source}"] },
      inherited: { $extends: "{foundation}" },
    });
    await Promise.all([
      writeFile(
        join(root, "tokenc.config.mjs"),
        'export default { source: ["*.json"] };\n',
        "utf8",
      ),
      writeFile(declarationsPath, declarations, "utf8"),
      writeFile(usagesPath, usages, "utf8"),
    ]);
    const manager = new WorkspaceManager();
    await manager.add({ name: "fixture", uri: pathToFileURL(root).href }, { trusted: true });
    const navigation = new NavigationProvider(manager);
    const declarationsUri = pathToFileURL(declarationsPath).href;
    const usagesUri = pathToFileURL(usagesPath).href;

    const definitions = [
      [usagesUri, usages, "{base😀}", '"base😀"'],
      [declarationsUri, declarations, "#/base😀/$value", '"base😀"'],
      [usagesUri, usages, "{palette.source}", '"source"'],
      [usagesUri, usages, "{foundation}", '"foundation"'],
    ] as const;
    const definitionResults = await Promise.all(
      definitions.map(([requestUri, requestContent, needle]) =>
        navigation.definition({
          textDocument: { uri: requestUri },
          position: position(requestContent, needle),
        }),
      ),
    );
    for (const [index, definition] of definitionResults.entries()) {
      const expectedNeedle = definitions[index]![3];
      expect(definition).toMatchObject({
        uri: declarationsUri,
        range: { start: position(declarations, expectedNeedle, 0) },
      });
    }

    const references = await navigation.references({
      textDocument: { uri: declarationsUri },
      position: position(declarations, '"base😀"'),
      context: { includeDeclaration: true },
    });
    expect(references).toEqual([
      expect.objectContaining({ uri: declarationsUri }),
      expect.objectContaining({ uri: declarationsUri }),
      expect.objectContaining({ uri: usagesUri }),
    ]);
    expect(references.map((entry) => entry.range.start)).toEqual([
      position(declarations, '"base😀"', 0),
      position(declarations, "#/base😀/$value", 0),
      position(usages, "{base😀}", 0),
    ]);

    const documentSymbols = await navigation.documentSymbols({
      textDocument: { uri: declarationsUri },
    });
    expect(documentSymbols.map((symbol) => symbol.name)).toEqual([
      "base😀",
      "pointer",
      "palette",
      "foundation",
    ]);
    expect(documentSymbols[2]?.children?.map((symbol) => symbol.name)).toEqual(["source"]);
    expect(documentSymbols[3]?.children?.map((symbol) => symbol.name)).toEqual(["value"]);

    const workspaceSymbols = await navigation.workspaceSymbols({ query: "base" });
    expect(workspaceSymbols).toMatchObject([
      { name: "base😀", location: { uri: declarationsUri } },
    ]);
    await manager.close();
  });

  it("uses only the settled current snapshot for invalid and removed documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenc-lsp-navigation-current-"));
    temporaryDirectories.push(root);
    const tokenPath = join(root, "tokens.json");
    const disk = JSON.stringify({ disk: { $type: "number", $value: 1 } });
    await Promise.all([
      writeFile(
        join(root, "tokenc.config.mjs"),
        'export default { source: ["*.json"] };\n',
        "utf8",
      ),
      writeFile(tokenPath, disk, "utf8"),
    ]);
    const manager = new WorkspaceManager();
    await manager.add({ name: "fixture", uri: pathToFileURL(root).href }, { trusted: true });
    const navigation = new NavigationProvider(manager);
    const uri = pathToFileURL(tokenPath).href;
    const invalid = '{"current":{"$type":"number","$value":';
    manager.openDocument(uri, invalid, 1);

    expect(
      (await navigation.documentSymbols({ textDocument: { uri } })).map((symbol) => symbol.name),
    ).toEqual(["current"]);
    expect(await navigation.workspaceSymbols({ query: "disk" })).toEqual([]);

    manager.closeDocument(uri);
    await manager.idle();
    await rm(tokenPath);
    manager.watchedFile(uri, "deleted");
    expect(await navigation.documentSymbols({ textDocument: { uri } })).toEqual([]);
    expect(await navigation.workspaceSymbols({ query: "disk" })).toEqual([]);
    await manager.close();
  });
});
