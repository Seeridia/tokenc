import { readFile } from "node:fs/promises";

import {
  createDiagnostic,
  documentContentDigest,
  parseTokenId,
  type Diagnostic,
} from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { assertSchemaConformance } from "../../core/test/support/schema-conformance.js";
import reportSchema from "../schema/report-v1.schema.json" with { type: "json" };
import {
  createCheckReport,
  renderReportText,
  reportDocumentPath,
  serializeReportJson,
  serializeReportSarif,
} from "../src/report.js";
import sarifGolden from "./fixtures/check-report-v1.sarif.json" with { type: "json" };

function diagnostic(): Diagnostic {
  const document = "/workspace/project/tokens/base token.json";
  return createDiagnostic({
    code: "TOKEN_UNKNOWN_REFERENCE",
    message: "Unknown token `missing`",
    parameters: { target: "missing" },
    source: { file: document, line: 3, column: 12, offset: 42, length: 9 },
    anchor: { kind: "field", token: parseTokenId("alias"), path: [] },
    related: [
      {
        message: "External definition",
        source: {
          file: "/private/tmp/tokenc-materialized/source.json",
          line: 2,
          column: 4,
          offset: 8,
          length: 3,
        },
      },
    ],
    fixes: [
      {
        title: "Replace reference",
        applicability: "safe",
        edits: [
          {
            document,
            range: { line: 3, column: 12, offset: 42, length: 9 },
            newText: "{present}",
            expectedDocumentDigest: documentContentDigest("source"),
          },
        ],
      },
    ],
  });
}

function assertIndependentSarif(value: unknown): void {
  expect(value).toMatchObject({
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: { driver: { name: "tokenc", rules: [{ id: "TOKEN_UNKNOWN_REFERENCE" }] } },
        results: [
          {
            ruleId: "TOKEN_UNKNOWN_REFERENCE",
            level: "error",
            partialFingerprints: { "tokenc/v1": expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "tokens/base%20token.json" },
                  region: { startLine: 3, startColumn: 12, charOffset: 42, charLength: 9 },
                },
              },
            ],
            relatedLocations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "_external/source.json" },
                  region: { startLine: 2, startColumn: 4, charOffset: 8, charLength: 3 },
                },
              },
            ],
            fixes: [
              {
                artifactChanges: [
                  {
                    artifactLocation: { uri: "tokens/base%20token.json" },
                    replacements: [
                      {
                        deletedRegion: {
                          startLine: 3,
                          startColumn: 12,
                          charOffset: 42,
                          charLength: 9,
                        },
                        insertedContent: { text: "{present}" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("Report v1", () => {
  it("publishes the report schema as an explicit package subpath", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({
      exports: { "./report-v1.schema.json": "./schema/report-v1.schema.json" },
    });
  });

  it("normalizes paths against an explicit root and redacts external materialization paths", () => {
    expect(reportDocumentPath("/workspace/project/tokens/base.json", "/workspace/project")).toBe(
      "tokens/base.json",
    );
    expect(
      reportDocumentPath("/private/tmp/tokenc-materialized/source.json", "/workspace/project"),
    ).toBe("_external/source.json");
  });

  it("builds one deeply immutable report accepted by the public JSON schema", () => {
    const report = createCheckReport({
      root: "/workspace/project",
      tokens: 2,
      references: 1,
      success: false,
      diagnostics: [diagnostic()],
    });

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.diagnostics[0]?.diagnostic.fixes[0]?.edits)).toBe(true);
    expect(report.diagnostics[0]?.diagnostic.source?.document).toBe("tokens/base token.json");
    expect(report.diagnostics[0]?.diagnostic.related[0]?.source?.document).toBe(
      "_external/source.json",
    );
    expect(() => assertSchemaConformance(report, reportSchema)).not.toThrow();
    expect(serializeReportJson(report)).toBe(serializeReportJson(report));
  });

  it("preserves code, severity, location, and fingerprint across text, JSON, and SARIF", () => {
    const original = diagnostic();
    const report = createCheckReport({
      root: "/workspace/project",
      tokens: 2,
      references: 1,
      success: false,
      diagnostics: [original],
    });
    const text = renderReportText(report);
    const json = JSON.parse(serializeReportJson(report));
    const sarif = JSON.parse(serializeReportSarif(report));

    expect(text).toContain(
      `tokens/base token.json:3:12 [error] ${original.code} ${original.fingerprint}`,
    );
    expect(json.diagnostics[0].diagnostic).toMatchObject({
      code: original.code,
      severity: original.severity,
      fingerprint: original.fingerprint,
      source: { document: "tokens/base token.json", range: { line: 3, column: 12 } },
    });
    assertIndependentSarif(sarif);
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: original.code,
      level: "error",
      partialFingerprints: { "tokenc/v1": original.fingerprint },
    });
    expect(sarif).toEqual(sarifGolden);
    expect(JSON.stringify(sarif)).not.toContain("/private/tmp");
  });

  it("keeps renderer source free of compilation and policy evaluation", async () => {
    const source = await readFile(new URL("../src/report.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/compileSnapshots?|compareSnapshots|evaluateSnapshotPolicy/u);
  });
});
