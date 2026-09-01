import { describe, expect, it } from "vite-plus/test";

import policySchema from "../schema/breaking-policy-v1.schema.json" with { type: "json" };
import { evaluateSnapshotPolicy, serializePolicyEvaluation } from "../src/breaking-policy.js";
import { compileDocuments } from "../src/compiler.js";
import { compareSnapshots, type SnapshotDiffV1 } from "../src/snapshot-diff.js";
import { assertSchemaConformance } from "./support/schema-conformance.js";

const contexts = { theme: { default: "light", values: ["light", "dark"] } } as const;

function source(value: unknown) {
  return {
    file: "tokens.json",
    content: typeof value === "string" ? value : JSON.stringify(value),
  };
}

async function changedDiff(): Promise<SnapshotDiffV1> {
  const [base, head] = await Promise.all([
    compileDocuments(
      [
        source({
          removed: { $type: "number", $value: 1 },
          value: { $type: "number", $value: 1 },
          alias: { $type: "number", $value: "{value}" },
        }),
      ],
      { contexts },
    ),
    compileDocuments(
      [
        source({
          value: { $type: "number", $value: 2 },
          alias: { $type: "number", $value: "{value}" },
        }),
      ],
      { contexts },
    ),
  ]);
  return compareSnapshots(base, head, { context: { theme: "dark" } });
}

describe("Breaking-change Policy v1", () => {
  it("publishes a schema for authored policy inputs", () => {
    expect(() =>
      assertSchemaConformance(
        {
          schemaVersion: "1",
          rules: { "token-removal": { severity: "warning", context: { theme: "dark" } } },
          allow: [{ changeId: "stable-change-id", reason: "intentional migration" }],
        },
        policySchema,
      ),
    ).not.toThrow();
  });

  it("applies documented defaults without mutating the underlying diff", async () => {
    const diff = await changedDiff();
    const before = serializePolicyEvaluation(
      evaluateSnapshotPolicy(diff, {
        schemaVersion: "1",
        rules: { "token-removal": { severity: "warning" } },
      }),
    );
    const evaluation = evaluateSnapshotPolicy(diff, { schemaVersion: "1" });

    expect(evaluation.diff).toBe(diff);
    expect(evaluation.verdict).toBe("fail");
    expect(evaluation.findings.map(({ ruleId, severity }) => [ruleId, severity])).toEqual([
      ["token-removal", "error"],
      ["direct-value-change", "warning"],
      ["propagated-value-change", "warning"],
    ]);
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(serializePolicyEvaluation(evaluation)).toBe(serializePolicyEvaluation(evaluation));
    expect(before).toContain('"severity": "warning"');
    expect(diff.changes.find((change) => change.kind === "removed")).toBeDefined();
  });

  it("supports severity overrides, off, allow identity, and Context scope", async () => {
    const diff = await changedDiff();
    const removal = diff.changes.find((change) => change.kind === "removed")!;
    const evaluation = evaluateSnapshotPolicy(diff, {
      schemaVersion: "1",
      rules: {
        "token-removal": { severity: "error", context: { theme: "dark" } },
        "direct-value-change": { severity: "off" },
        "propagated-value-change": { severity: "info" },
      },
      allow: [
        {
          changeId: removal.changeId,
          reason: "consumer migration is staged",
          context: { theme: "dark" },
        },
      ],
    });

    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.findings).toEqual([
      expect.objectContaining({
        ruleId: "token-removal",
        allowed: true,
        allowReason: "consumer migration is staged",
      }),
      expect.objectContaining({ ruleId: "propagated-value-change", severity: "info" }),
    ]);
    expect(evaluation.findings[0]?.findingId).toBe(evaluation.findings[0]?.diagnostic.fingerprint);
  });

  it("fails closed for unknown rules, stale allow entries, and invalid Context scope", async () => {
    const diff = await changedDiff();
    const evaluation = evaluateSnapshotPolicy(diff, {
      schemaVersion: "1",
      rules: {
        unknown: { severity: "error" },
        "token-removal": { severity: "warning", context: { platform: "web" } },
      },
      allow: [{ changeId: "stale", reason: "old exception" }],
    });

    expect(evaluation.verdict).toBe("incomplete");
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "POLICY_UNKNOWN_RULE",
      "POLICY_INVALID_CONFIG",
      "POLICY_STALE_ALLOW",
    ]);
  });

  it("rejects unknown configuration properties at every level", async () => {
    const diff = await changedDiff();
    const evaluation = evaluateSnapshotPolicy(diff, {
      schemaVersion: "1",
      unexpected: true,
      rules: { "token-removal": { severity: "warning", typo: true } },
      allow: [{ changeId: diff.changes[0]!.changeId, reason: "temporary", typo: true }],
    });

    expect(evaluation.verdict).toBe("incomplete");
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.parameters.path)).toEqual([
      "$.unexpected",
      "$.rules.token-removal.typo",
      "$.allow[0].typo",
    ]);
  });

  it("gives incomplete comparison precedence and preserves compiler diagnostics", async () => {
    const [base, head] = await Promise.all([
      compileDocuments([source({ value: { $type: "number", $value: 1 } })], { contexts }),
      compileDocuments([source("{")], { contexts }),
    ]);
    const diff = await compareSnapshots(base, head, { context: { theme: "dark" } });
    const evaluation = evaluateSnapshotPolicy(diff, {
      schemaVersion: "1",
      allow: [{ changeId: "compiler-error", reason: "must not suppress diagnostics" }],
    });

    expect(evaluation.verdict).toBe("incomplete");
    expect(
      evaluation.diff.diagnostics.some(
        ({ diagnostic }) => diagnostic.code === "TOKEN_INVALID_JSON",
      ),
    ).toBe(true);
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "POLICY_STALE_ALLOW",
      "POLICY_INCOMPLETE_COMPARISON",
    ]);
  });

  it("classifies Backend removals only from BackendChangeV1 facts", async () => {
    const original = await changedDiff();
    const diff: SnapshotDiffV1 = {
      ...original,
      backends: [
        {
          changeId: "symbol-change",
          backendId: "css",
          kind: "symbol",
          identity: "value",
          before: "--old",
          after: "--new",
        },
        {
          changeId: "path-change",
          backendId: "css",
          kind: "artifact-path",
          identity: "main",
          before: "old.css",
          after: "new.css",
        },
        {
          changeId: "symbol-add",
          backendId: "css",
          kind: "symbol",
          identity: "added",
          after: "--added",
        },
      ],
    };
    const evaluation = evaluateSnapshotPolicy(diff, {
      schemaVersion: "1",
      rules: {
        "token-removal": { severity: "off" },
        "direct-value-change": { severity: "off" },
        "propagated-value-change": { severity: "off" },
      },
    });

    expect(evaluation.findings.map(({ ruleId, changeId }) => [ruleId, changeId])).toEqual([
      ["backend-symbol-removal", "symbol-change"],
      ["backend-artifact-path-removal", "path-change"],
    ]);
    expect(evaluation.verdict).toBe("fail");
  });
});
