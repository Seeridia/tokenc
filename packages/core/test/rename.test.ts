import { describe, expect, it } from "vite-plus/test";

import renamePlanSchema from "../schema/rename-plan-v1.schema.json" with { type: "json" };
import {
  ALL_TOKEN_TYPES,
  SymbolAllocator,
  type BackendPlan,
  type TokenBackend,
} from "../src/backend.js";
import { compileDocuments } from "../src/compiler.js";
import { planTokenRename } from "../src/rename.js";
import { parseTokenId } from "../src/token-id.js";
import { assertSchemaConformance } from "./support/schema-conformance.js";

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

function apply(
  content: string,
  edits: readonly { range: { offset: number; length: number }; newText: string }[],
) {
  let result = content;
  for (const edit of edits.toSorted((left, right) => right.range.offset - left.range.offset))
    result =
      result.slice(0, edit.range.offset) +
      edit.newText +
      result.slice(edit.range.offset + edit.range.length);
  return result;
}

function namingBackend(reserved: ReadonlySet<string> = new Set()): TokenBackend {
  return {
    id: "names",
    capabilities,
    prepare(ir): BackendPlan {
      const allocation = new SymbolAllocator().allocate({
        backendId: "names",
        requests: ir.sourceTokens.map((token) => ({
          id: String(token.id),
          token,
          namespace: {
            name: "test",
            caseSensitive: false,
            normalize: "NFC",
            reserved,
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

describe("planTokenRename", () => {
  it("rewrites a declaration plus curly and JSON Pointer references atomically", async () => {
    const file = "/workspace/tokens.json";
    const content = JSON.stringify({
      base: { $type: "number", $value: 1 },
      alias: { $type: "number", $value: "{base}" },
      pointer: { $type: "number", $ref: "#/base/$value" },
    });
    const snapshot = await compileDocuments([{ file, content }]);
    const plan = await planTokenRename(snapshot, parseTokenId("base"), "renamed", {
      backends: [namingBackend()],
    });

    expect(plan).toMatchObject({
      schemaVersion: "1",
      status: "ready",
      token: "base",
      replacement: "renamed",
      diagnostics: [],
      backendPreviews: [
        {
          backendId: "names",
          beforeSymbols: expect.arrayContaining(["base=test:base"]),
          afterSymbols: expect.arrayContaining(["renamed=test:renamed"]),
          diagnostics: [],
        },
      ],
    });
    expect(plan.edits.map((edit) => edit.newText)).toEqual([
      '"renamed"',
      "{renamed}",
      "#/renamed/$value",
    ]);
    expect(new Set(plan.edits.map((edit) => edit.expectedDocumentDigest))).toHaveLength(1);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.edits)).toBe(true);
    expect(snapshot.documents[0]?.content).toBe(content);
    expect(() => assertSchemaConformance(plan, renamePlanSchema)).not.toThrow();

    const renamed = await compileDocuments([{ file, content: apply(content, plan.edits) }]);
    if (renamed.status !== "valid") throw new Error("Expected renamed snapshot to be valid");
    expect(renamed.query.completions()).toEqual(["alias", "pointer", "renamed"]);
    expect(renamed.query.resolve(parseTokenId("alias"))?.value).toBe(1);
  });

  it("rewrites nested composite occurrences and preserves field paths", async () => {
    const file = "/workspace/gradient.json";
    const content = JSON.stringify({
      source: {
        $type: "gradient",
        $value: [
          {
            color: { colorSpace: "srgb", components: [1, 0, 0] },
            position: 0,
          },
        ],
      },
      combined: { $type: "gradient", $value: ["{source}"] },
    });
    const snapshot = await compileDocuments([{ file, content }]);
    const plan = await planTokenRename(snapshot, parseTokenId("source"), "palette");

    expect(plan.status).toBe("ready");
    expect(plan.edits.map((edit) => edit.newText)).toEqual(['"palette"', "{palette}"]);
    const renamed = await compileDocuments([{ file, content: apply(content, plan.edits) }]);
    expect(renamed.query.dependencies(parseTokenId("combined"))).toMatchObject([
      { to: "palette", kind: "composite-field", fieldPath: [0] },
    ]);
  });

  it("preserves JSON escaping and RFC 6901 escaping", async () => {
    const file = "/workspace/escaped.json";
    const content = JSON.stringify({
      "a/b~c": { $type: "number", $value: 1 },
      alias: { $type: "number", $value: "{a/b~c}" },
      pointer: { $type: "number", $ref: "#/a~1b~0c/$value" },
    });
    const snapshot = await compileDocuments([{ file, content }]);
    const plan = await planTokenRename(snapshot, parseTokenId("a/b~c"), "next/key~x");

    expect(plan.status).toBe("ready");
    expect(plan.edits.map((edit) => edit.newText)).toEqual([
      '"next/key~x"',
      "{next/key~x}",
      "#/next~1key~0x/$value",
    ]);
  });

  it.each([
    ["taken", "canonical"],
    ["TAKEN", "case-folded"],
    ["cafe\u0301", "Unicode-normalized"],
  ])("rejects %s collisions before exposing edits", async (replacement, kind) => {
    const snapshot = await compileDocuments([
      {
        file: "/workspace/collisions.json",
        content: JSON.stringify({
          source: { $type: "number", $value: 1 },
          taken: { $type: "number", $value: 2 },
          café: { $type: "number", $value: 3 },
        }),
      },
    ]);
    const plan = await planTokenRename(snapshot, parseTokenId("source"), replacement);

    expect(plan.status).toBe("rejected");
    expect(plan.edits).toEqual([]);
    expect(plan.diagnostics[0]).toMatchObject({
      code: "TOKEN_DUPLICATE_ID",
      message: expect.stringContaining(kind),
    });
  });

  it.each(["$root", "other.renamed", "", "bad..name"])(
    "rejects unsupported or invalid target %j",
    async (replacement) => {
      const snapshot = await compileDocuments([
        {
          file: "/workspace/invalid-name.json",
          content: JSON.stringify({ source: { $type: "number", $value: 1 } }),
        },
      ]);
      const plan = await planTokenRename(snapshot, parseTokenId("source"), replacement);
      expect(plan.status).toBe("rejected");
      expect(plan.edits).toEqual([]);
      expect(plan.diagnostics[0]?.code).toBe("DTCG_INVALID_TOKEN_NAME");
      expect(() => assertSchemaConformance(plan, renamePlanSchema)).not.toThrow();
    },
  );

  it("rejects Backend symbol collisions and reserved names without emitting", async () => {
    const snapshot = await compileDocuments([
      {
        file: "/workspace/backend.json",
        content: JSON.stringify({
          group: {
            source: { $type: "number", $value: 1 },
            fooBar: { $type: "number", $value: 2 },
          },
        }),
      },
    ]);
    const collision = await planTokenRename(
      snapshot,
      parseTokenId("group.source"),
      "group.foo-bar",
      { backends: [namingBackend()] },
    );
    const reserved = await planTokenRename(
      snapshot,
      parseTokenId("group.source"),
      "group.reserved",
      { backends: [namingBackend(new Set(["groupreserved"]))] },
    );

    expect(collision).toMatchObject({ status: "rejected", edits: [] });
    expect(collision.diagnostics.map((entry) => entry.code)).toContain("BACKEND_SYMBOL_COLLISION");
    expect(reserved).toMatchObject({ status: "rejected", edits: [] });
    expect(reserved.diagnostics.map((entry) => entry.code)).toContain("BACKEND_SYMBOL_RESERVED");
  });

  it("returns unavailable for invalid snapshots and missing tokens", async () => {
    const invalid = await compileDocuments([
      { file: "/workspace/invalid.json", content: '{"source":' },
    ]);
    const valid = await compileDocuments([
      {
        file: "/workspace/valid.json",
        content: JSON.stringify({ source: { $type: "number", $value: 1 } }),
      },
    ]);

    expect(await planTokenRename(invalid, parseTokenId("source"), "renamed")).toMatchObject({
      status: "unavailable",
      edits: [],
    });
    expect(await planTokenRename(valid, parseTokenId("missing"), "renamed")).toMatchObject({
      status: "unavailable",
      edits: [],
      diagnostics: [{ code: "TOKEN_UNKNOWN_REFERENCE" }],
    });
  });
});
