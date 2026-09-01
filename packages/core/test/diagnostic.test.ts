import { describe, expect, it } from "vite-plus/test";

import diagnosticSchema from "../schema/diagnostic-v1.schema.json" with { type: "json" };
import { compileDocumentsInternal as compileDocuments } from "../src/compiler.js";
import {
  createDiagnostic,
  diagnosticCodeRegistry,
  documentContentDigest,
} from "../src/diagnostic.js";
import type { SourceLocation } from "../src/model.js";
import { createCompilerSession } from "../src/session.js";
import { parseTokenId } from "../src/token-id.js";
import diagnosticGolden from "./fixtures/diagnostics/v1.json" with { type: "json" };
import { assertSchemaConformance } from "./support/schema-conformance.js";

const location = (offset: number, line: number): SourceLocation => ({
  file: "/workspace/tokens.json",
  line,
  column: 10,
  offset,
  length: 9,
  excerpt: '"{missing}"',
});

describe("Diagnostic v1", () => {
  it("constructs the complete versioned contract from the code registry", () => {
    const diagnostic = createDiagnostic({
      code: "TOKEN_UNKNOWN_REFERENCE",
      message: "Unknown token `missing`",
      parameters: { target: "missing" },
      source: location(20, 2),
      anchor: { kind: "field", token: parseTokenId("alias"), path: [] },
    });

    expect(diagnostic).toMatchObject({
      schemaVersion: "1",
      code: "TOKEN_UNKNOWN_REFERENCE",
      severity: "error",
      parameters: { target: "missing" },
      documentationUrl: expect.stringContaining("token-unknown-reference"),
      related: [],
      fixes: [],
    });
    expect(diagnostic.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(diagnosticCodeRegistry().find((entry) => entry.code === diagnostic.code)).toMatchObject({
      stage: "checker",
      defaultSeverity: "error",
      parameters: { target: { identity: true, required: true } },
    });
  });

  it("uses semantic identity rather than message, severity, or display range", () => {
    const base = {
      code: "TOKEN_UNKNOWN_REFERENCE",
      parameters: { target: "missing" },
      anchor: { kind: "field" as const, token: parseTokenId("alias"), path: ["color"] },
    };
    const first = createDiagnostic({ ...base, message: "First wording", source: location(20, 2) });
    const moved = createDiagnostic({
      ...base,
      severity: "warning",
      message: "Localized wording",
      source: location(200, 20),
    });
    const changed = createDiagnostic({
      ...base,
      parameters: { target: "other" },
      message: "First wording",
      source: location(20, 2),
    });

    expect(moved.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("keeps cold and incremental fingerprints equal, including after a line-only move", async () => {
    const source = {
      file: "/workspace/tokens.json",
      content: '{"alias":{"$type":"number","$value":"{missing}"}}',
    };
    const cold = await compileDocuments([source]);
    const compiler = createCompilerSession();
    const initial = await compiler.apply({
      documents: [
        {
          kind: "add",
          document: { identity: source.file, content: source.content },
        },
      ],
    });
    const moved = await compiler.apply({
      documents: [
        {
          kind: "update",
          document: { identity: source.file, content: `\n\n${source.content}` },
        },
      ],
    });

    expect(initial.diagnostics.map((item) => item.fingerprint)).toEqual(
      cold.diagnostics.map((item) => item.fingerprint),
    );
    expect(moved.diagnostics[0]?.fingerprint).toBe(cold.diagnostics[0]?.fingerprint);
    expect(moved.diagnostics[0]?.source?.range.line).not.toBe(
      cold.diagnostics[0]?.source?.range.line,
    );
  });

  it("orders edits, rejects overlaps, and carries a stale-content digest", () => {
    const digest = documentContentDigest("source");
    const edit = (offset: number, length: number, newText: string) => ({
      document: "tokens.json",
      range: { line: 1, column: offset + 1, offset, length },
      newText,
      expectedDocumentDigest: digest,
    });
    const diagnostic = createDiagnostic({
      code: "TOKEN_UNKNOWN_REFERENCE",
      message: "Unknown token",
      parameters: { target: "missing" },
      fixes: [
        {
          title: "Replace the reference",
          applicability: "safe",
          edits: [edit(10, 1, "b"), edit(2, 1, "a")],
        },
      ],
    });
    expect(diagnostic.fixes[0]?.edits.map((item) => item.range.offset)).toEqual([2, 10]);
    expect(diagnostic.fixes[0]?.edits[0]?.expectedDocumentDigest).toBe(digest);
    expect(() =>
      createDiagnostic({
        code: "TOKEN_UNKNOWN_REFERENCE",
        message: "Unknown token",
        parameters: { target: "missing" },
        fixes: [
          {
            title: "Overlap",
            applicability: "requires-review",
            edits: [edit(2, 4, "a"), edit(4, 1, "b")],
          },
        ],
      }),
    ).toThrow(/overlapping/u);
    expect(() =>
      createDiagnostic({
        code: "TOKEN_UNKNOWN_REFERENCE",
        message: "Unknown token",
        parameters: { target: "missing" },
        fixes: [
          {
            title: "Stale edit",
            applicability: "safe",
            edits: [{ ...edit(2, 1, "a"), expectedDocumentDigest: "not-a-digest" }],
          },
        ],
      }),
    ).toThrow(/invalid document digest/u);
  });

  it("ships a schema that requires the fixed CLI envelope and Diagnostic fields", () => {
    expect(diagnosticSchema.required).toEqual(["schemaVersion", "diagnostics"]);
    expect(diagnosticSchema.$defs.diagnostic.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "parameters",
        "fingerprint",
        "documentationUrl",
        "related",
        "fixes",
      ]),
    );
    expect(() =>
      assertSchemaConformance(
        { schemaVersion: "1", diagnostics: [diagnosticGolden] },
        diagnosticSchema,
      ),
    ).not.toThrow();
  });

  it("matches the committed Diagnostic v1 golden JSON", () => {
    const actual = createDiagnostic({
      code: "TOKEN_UNKNOWN_REFERENCE",
      message: "Unknown token missing",
      parameters: { target: "missing" },
      source: {
        file: "tokens.json",
        line: 2,
        column: 10,
        offset: 20,
        length: 9,
      },
      anchor: { kind: "field", token: parseTokenId("alias"), path: [] },
    });
    expect(actual).toEqual(diagnosticGolden);
  });
});
