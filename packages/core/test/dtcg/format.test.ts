import { describe, expect, it } from "vite-plus/test";

import { compileDocuments } from "../../src/compiler.js";
import { parseTokenDocument } from "../../src/parser.js";

describe("DTCG 2025.10 format", () => {
  it("uses DTCG semantics in the high-level document compiler", async () => {
    const result = await compileDocuments([
      { file: "tokens.json", content: '{"a":{"$type":"color","$value":"red"}}' },
    ]);
    expect(result.success).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("DTCG_INVALID_COLOR");
  });

  it("supports the DTCG fontFamily type", () => {
    const result = parseTokenDocument(
      '{"font":{"$type":"fontFamily","$value":["Inter","sans-serif"]}}',
      "font.json",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens[0]).toMatchObject({ type: "fontFamily" });
  });

  it("retains deprecation metadata", () => {
    const result = parseTokenDocument(
      '{"old":{"$type":"number","$value":1,"$deprecated":"Use new"}}',
      "deprecated.json",
    );
    expect(result.tokens[0]?.deprecated).toBe("Use new");
  });

  it("parses reserved root tokens with their explicit canonical path", () => {
    const result = parseTokenDocument(
      '{"spacing":{"$type":"dimension","$root":{"$value":{"value":16,"unit":"px"}},"small":{"$value":{"value":8,"unit":"px"}}}}',
      "root.json",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => token.id)).toEqual(["spacing.$root", "spacing.small"]);
  });

  it("rejects objects that are simultaneously tokens and groups", () => {
    const result = parseTokenDocument(
      '{"invalid":{"$type":"number","$value":1,"child":{"$value":2}}}',
      "structure.json",
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: "DTCG_INVALID_TOKEN_STRUCTURE",
      related: [{ message: "Child `child` makes this object a group" }],
    });
  });

  it("reports a missing group extension target explicitly", () => {
    const result = parseTokenDocument(
      '{"derived":{"$extends":"{base}","value":{"$type":"number","$value":1}}}',
      "extends.json",
    );
    expect(result.diagnostics[0]?.code).toBe("DTCG_GROUP_EXTENDS_INVALID_TARGET");
  });

  it("validates standard metadata shapes", () => {
    const result = parseTokenDocument(
      '{"value":{"$type":"number","$value":1,"$description":2,"$extensions":[],"$deprecated":3}}',
      "metadata.json",
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "DTCG_INVALID_DESCRIPTION",
      "DTCG_INVALID_EXTENSIONS",
      "DTCG_INVALID_DEPRECATED",
    ]);
  });

  it("reports a missing JSON Pointer target", () => {
    const result = parseTokenDocument(
      '{"alias":{"$type":"number","$ref":"#/base/$value"}}',
      "pointer.json",
    );
    expect(result.diagnostics[0]?.code).toBe("DTCG_JSON_POINTER_NOT_FOUND");
  });
});
