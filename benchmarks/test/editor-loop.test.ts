import { readFile } from "node:fs/promises";

import { compileDocuments } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { BENCHMARK_CASES } from "../fixtures.js";

const corpusUrl = new URL("../fixtures/editor-protocol/corpus.v1.json", import.meta.url);
const editorSymbolSchemaUrl = new URL(
  "../../docs/schemas/drafts/editor-symbol-v1.schema.json",
  import.meta.url,
);
const renamePlanSchemaUrl = new URL(
  "../../docs/schemas/drafts/rename-plan-v1.schema.json",
  import.meta.url,
);

async function json(url: URL): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(url, "utf8"));
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new TypeError(`${label} must be an integer`);
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry) => string(entry, `${label} entry`));
}

function positionAt(
  text: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

describe("M3-00 editor-loop evidence", () => {
  it("maps every required IDE behavior to an authored protocol transcript", async () => {
    const corpus = record(await json(corpusUrl), "protocol corpus");
    const transcripts = array(corpus.transcripts, "transcripts").map((entry) =>
      record(entry, "transcript"),
    );
    const required = Object.keys(record(corpus.categoryFieldMap, "category field map")).toSorted();
    const covered = new Set(
      transcripts.flatMap((transcript) => strings(transcript.categories, "transcript categories")),
    );

    expect(corpus.schemaVersion).toBe("1");
    expect(corpus.positionEncoding).toBe("utf-16");
    expect(required.length).toBeGreaterThanOrEqual(20);
    expect(required.every((category) => covered.has(category))).toBe(true);
    expect(new Set(transcripts.map((entry) => string(entry.id, "transcript id"))).size).toBe(
      transcripts.length,
    );
    expect(
      transcripts.every((entry) => {
        expect(array(entry.steps, "transcript steps").length).toBeGreaterThan(0);
        expect(Object.keys(record(entry.expected, "transcript expected")).length).toBeGreaterThan(
          0,
        );
        return true;
      }),
    ).toBe(true);
  });

  it("pins workspace trust, normalized file URIs, and multi-root isolation", async () => {
    const corpus = record(await json(corpusUrl), "protocol corpus");
    const workspaces = array(corpus.workspaces, "workspaces").map((entry) =>
      record(entry, "workspace"),
    );
    expect(workspaces.map((entry) => entry.id)).toEqual(["alpha", "beta", "untrusted"]);
    expect(workspaces.map((entry) => entry.trusted)).toEqual([true, true, false]);
    for (const workspace of workspaces) {
      const rootUri = string(workspace.rootUri, "workspace root URI");
      expect(rootUri).toMatch(/^file:\/\/\/[a-z0-9/_-]+$/u);
      for (const uri of Object.keys(record(workspace.documents, "workspace documents")))
        expect(uri.startsWith(`${rootUri}/`)).toBe(true);
    }
  });

  it("locks UTF-16 offsets across CRLF and astral Unicode", async () => {
    const corpus = record(await json(corpusUrl), "protocol corpus");
    const workspaces = array(corpus.workspaces, "workspaces").map((entry) =>
      record(entry, "workspace"),
    );
    const workspaceById = new Map(workspaces.map((entry) => [entry.id, entry]));
    for (const fixtureValue of array(corpus.positionFixtures, "position fixtures")) {
      const fixture = record(fixtureValue, "position fixture");
      const workspace = workspaceById.get(fixture.workspace);
      if (!workspace) throw new Error(`Unknown fixture workspace: ${String(fixture.workspace)}`);
      const documents = record(workspace.documents, "workspace documents");
      const text = string(documents[string(fixture.uri, "fixture URI")], "fixture document");
      for (const anchorValue of array(fixture.anchors, "anchors")) {
        const anchor = record(anchorValue, "anchor");
        const needle = string(anchor.needle, "anchor needle");
        const occurrence = integer(anchor.occurrence, "anchor occurrence");
        let offset = -1;
        for (let index = 0; index < occurrence; index += 1)
          offset = text.indexOf(needle, offset + 1);
        string(anchor.id, "anchor id");
        expect(offset).toBe(anchor.offset);
        expect(needle.length).toBe(anchor.length);
        expect(positionAt(text, offset)).toEqual(anchor.position);
      }
    }
  });

  it("keeps invalid and recovered source states executable with current Core", async () => {
    const corpus = record(await json(corpusUrl), "protocol corpus");
    const alpha = array(corpus.workspaces, "workspaces")
      .map((entry) => record(entry, "workspace"))
      .find((entry) => entry.id === "alpha");
    if (!alpha) throw new Error("Missing alpha workspace");
    const documents = record(alpha.documents, "alpha documents");
    const firstDocument = Object.entries(documents)[0];
    if (!firstDocument) throw new Error("Missing alpha document");
    const [uri, contentValue] = firstDocument;
    const content = string(contentValue, "alpha source");
    const options = {
      contexts: { theme: { default: "light", values: ["light", "dark"] } },
    } as const;
    const valid = await compileDocuments([{ file: uri, content }], options);
    const invalid = await compileDocuments([{ file: uri, content: '{\r\n  "emoji😀":' }]);
    const recovered = await compileDocuments([{ file: uri, content }], options);

    expect(valid.status).toBe("valid");
    expect(invalid.status).toBe("invalid");
    expect(invalid.diagnostics.map((entry) => entry.code)).toContain("TOKEN_INVALID_JSON");
    expect(recovered.status).toBe("valid");
    expect(recovered.sourceRevision).toBe(valid.sourceRevision);
  });

  it("registers and executes all five pre-LSP editor-loop baselines", async () => {
    const cases = BENCHMARK_CASES.filter((entry) => entry.group === "editor-loop");
    expect(cases.map((entry) => entry.id)).toEqual([
      "m3/editor-cold-start/layered-1200",
      "m3/editor-one-file-update/layered-1200",
      "m3/editor-invalid-recovery/layered-1200",
      "m3/editor-high-fan-out/2000",
      "m3/editor-cancellation/active-load",
    ]);
    for (const benchmark of cases) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Baselines run sequentially to avoid interference.
      const result = await (await benchmark.createInvocation()).run();
      expect(benchmark.id).toMatch(/^m3\//u);
      expect(result.snapshot.status).toBe("valid");
    }
  }, 20_000);

  it("keeps both draft editor contracts strict and versioned", async () => {
    const schemas = await Promise.all([json(editorSymbolSchemaUrl), json(renamePlanSchemaUrl)]);
    for (const schemaValue of schemas) {
      const schema = record(schemaValue, "draft schema");
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(string(schema.$id, "schema id")).toContain("/schemas/drafts/");
      expect(strings(schema.required, "schema required")).toContain("schemaVersion");
      expect(record(schema.properties, "schema properties").schemaVersion).toEqual({ const: "1" });
    }
  });
});
