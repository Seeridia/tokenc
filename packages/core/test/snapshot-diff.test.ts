import { describe, expect, it, vi } from "vite-plus/test";

import snapshotDiffExample from "../../../docs/schemas/examples/snapshot-diff-v1.example.json" with { type: "json" };
import snapshotDiffSchema from "../schema/snapshot-diff-v1.schema.json" with { type: "json" };
import { ALL_TOKEN_TYPES, type BackendPlan, type TokenBackend } from "../src/backend.js";
import { compileDocuments } from "../src/compiler.js";
import { compareSnapshots, serializeSnapshotDiff } from "../src/snapshot-diff.js";
import { assertSchemaConformance } from "./support/schema-conformance.js";

const contexts = { theme: { default: "light", values: ["light", "dark"] } } as const;

function source(value: unknown, file = "tokens.json") {
  return { file, content: typeof value === "string" ? value : JSON.stringify(value) };
}

async function snapshots(base: unknown, head: unknown) {
  return Promise.all([
    compileDocuments([source(base)], { contexts }),
    compileDocuments([source(head)], { contexts }),
  ]);
}

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

function plannedBackend(
  id: string,
  symbolPrefix: string,
  path: string,
  emit = vi.fn<TokenBackend["emit"]>(() => []),
): TokenBackend {
  return {
    id,
    capabilities,
    prepare: (ir): BackendPlan => ({
      backendId: id,
      diagnostics: [],
      symbols: ir.sourceTokens.map((token) => ({
        id: String(token.id),
        token: token.id,
        namespace: "test",
        name: `${symbolPrefix}${token.id}`,
        source: token.source,
      })),
      artifacts: [
        {
          id: "main",
          path,
          mediaType: "text/plain",
          tokenIds: ir.tokens.map((token) => token.id),
          payload: null,
        },
      ],
      data: null,
    }),
    emit,
  };
}

describe("compareSnapshots", () => {
  it("accepts the authored Snapshot Diff v1 example", () => {
    expect(() => assertSchemaConformance(snapshotDiffExample, snapshotDiffSchema)).not.toThrow();
  });

  it("returns a deeply frozen, byte-stable empty diff", async () => {
    const [base, head] = await snapshots(
      { stable: { $type: "number", $value: 1 } },
      { stable: { $type: "number", $value: 1 } },
    );

    const first = await compareSnapshots(base, head, {
      context: { theme: "light" },
      baseLabel: "main",
      headLabel: "worktree",
    });
    const second = await compareSnapshots(base, head, {
      context: { theme: "light" },
      baseLabel: "main",
      headLabel: "worktree",
    });

    expect(first).toMatchObject({
      schemaVersion: "1",
      status: "complete",
      base: { label: "main", status: "valid" },
      head: { label: "worktree", status: "valid" },
      changes: [],
      renameCandidates: [],
      impact: { changed: [], directlyAffected: [], indirectlyAffected: [] },
      backends: [],
      diagnostics: [],
    });
    expect(serializeSnapshotDiff(first)).toBe(serializeSnapshotDiff(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.coverage.compared)).toBe(true);
    expect(() => assertSchemaConformance(first, snapshotDiffSchema)).not.toThrow();
  });

  it("classifies structural, direct, and propagated facts in deterministic order", async () => {
    const [base, head] = await snapshots(
      {
        removed: { $type: "number", $value: 30 },
        value: { $type: "number", $value: 1 },
        consumer: { $type: "number", $value: "{value}" },
        typed: { $type: "number", $value: 8 },
        metadata: { $type: "number", $value: 1, $description: "Before" },
        first: { $type: "number", $value: 5 },
        second: { $type: "number", $value: 5 },
        dependency: { $type: "number", $value: "{first}" },
        contextual: { $type: "number", $value: 1 },
      },
      {
        added: { $type: "number", $value: 40 },
        value: { $type: "number", $value: 2 },
        consumer: { $type: "number", $value: "{value}" },
        typed: { $type: "dimension", $value: { value: 8, unit: "px" } },
        metadata: { $type: "number", $value: 1, $description: "After" },
        first: { $type: "number", $value: 5 },
        second: { $type: "number", $value: 5 },
        dependency: { $type: "number", $value: "{second}" },
        contextual: {
          $type: "number",
          $value: 1,
          $extensions: { "org.token-compiler.contexts": { "theme=dark": 2 } },
        },
      },
    );

    const diff = await compareSnapshots(base, head, { context: { theme: "dark" } });
    expect(diff.changes.map(({ token, kind }) => `${token}:${kind}`)).toEqual([
      "added:added",
      "consumer:propagated-value",
      "contextual:direct-value",
      "contextual:context-coverage",
      "dependency:direct-value",
      "dependency:dependency",
      "metadata:metadata",
      "removed:removed",
      "typed:direct-value",
      "typed:type",
      "value:direct-value",
    ]);
    expect(diff.impact.changed.map((entry) => entry.token)).toEqual([
      "added",
      "contextual",
      "dependency",
      "metadata",
      "removed",
      "typed",
      "value",
    ]);
    expect(diff.impact.directlyAffected.map((entry) => entry.token)).toContain("consumer");
    expect(() => assertSchemaConformance(diff, snapshotDiffSchema)).not.toThrow();
  });

  it("inverts add/remove facts and before/after states", async () => {
    const [base, head] = await snapshots(
      { old: { $type: "number", $value: 1 } },
      { next: { $type: "number", $value: 2 } },
    );
    const forward = await compareSnapshots(base, head, { context: { theme: "light" } });
    const inverse = await compareSnapshots(head, base, { context: { theme: "light" } });

    expect(forward.changes.map(({ token, kind }) => `${token}:${kind}`)).toEqual([
      "next:added",
      "old:removed",
    ]);
    expect(inverse.changes.map(({ token, kind }) => `${token}:${kind}`)).toEqual([
      "next:removed",
      "old:added",
    ]);
    expect(forward.changes[0]?.after).toEqual(inverse.changes[0]?.before);
    expect(forward.changes[1]?.before).toEqual(inverse.changes[1]?.after);
  });

  it("keeps rename candidates advisory and exposes ties", async () => {
    const [base, unambiguousHead] = await snapshots(
      { old: { $type: "number", $value: 8 } },
      { next: { $type: "number", $value: 8 } },
    );
    const unambiguous = await compareSnapshots(base, unambiguousHead, {
      context: { theme: "light" },
    });
    expect(unambiguous.renameCandidates).toEqual([
      expect.objectContaining({
        removed: "old",
        added: "next",
        ambiguity: "unambiguous",
        score: 1,
      }),
    ]);

    const [, ambiguousHead] = await snapshots(
      { old: { $type: "number", $value: 8 } },
      {
        nextA: { $type: "number", $value: 8 },
        nextB: { $type: "number", $value: 8 },
      },
    );
    const ambiguous = await compareSnapshots(base, ambiguousHead, {
      context: { theme: "light" },
    });
    expect(
      ambiguous.renameCandidates.map(({ added, ambiguity }) => ({ added, ambiguity })),
    ).toEqual([
      { added: "nextA", ambiguity: "ambiguous" },
      { added: "nextB", ambiguity: "ambiguous" },
    ]);
  });

  it("keeps base-only and head-only dependency impact with side provenance", async () => {
    const [base, head] = await snapshots(
      {
        root: { $type: "number", $value: 1 },
        oldConsumer: { $type: "number", $value: "{root}" },
      },
      {
        root: { $type: "number", $value: 2 },
        oldConsumer: { $type: "number", $value: 1 },
        newConsumer: { $type: "number", $value: "{root}" },
      },
    );
    const diff = await compareSnapshots(base, head, { context: { theme: "light" } });

    expect(diff.impact.directlyAffected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "oldConsumer", sides: ["base"] }),
        expect.objectContaining({ token: "newConsumer", sides: ["head"] }),
      ]),
    );
  });

  it("does not leak impact across mutually exclusive Contexts", async () => {
    const document = {
      light: { $type: "number", $value: 1 },
      dark: { $type: "number", $value: 9 },
      alias: {
        $type: "number",
        $value: "{light}",
        $extensions: { "org.token-compiler.contexts": { "theme=dark": "{dark}" } },
      },
    };
    const [base, head] = await snapshots(document, {
      ...document,
      light: { $type: "number", $value: 2 },
    });

    const light = await compareSnapshots(base, head, { context: { theme: "light" } });
    const dark = await compareSnapshots(base, head, { context: { theme: "dark" } });
    expect(light.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "alias", kind: "propagated-value" }),
      ]),
    );
    expect(light.impact.directlyAffected.map((entry) => entry.token)).toContain("alias");
    expect(dark.changes.map((change) => change.token)).toEqual(["light"]);
    expect(dark.impact.directlyAffected).toEqual([]);
  });

  it("returns incomplete evidence for an invalid side", async () => {
    const [base, head] = await snapshots('{"broken":', { valid: { $type: "number", $value: 1 } });
    const diff = await compareSnapshots(base, head, { context: { theme: "light" } });

    expect(diff.status).toBe("incomplete");
    expect(diff.coverage.compared).toEqual([]);
    expect(diff.coverage.omitted.map((entry) => entry.reason)).toContain("invalid-base");
    expect(diff.diagnostics.every((entry) => entry.side === "base")).toBe(true);
    expect(diff.diagnostics.length).toBeGreaterThan(0);
    expect(() => assertSchemaConformance(diff, snapshotDiffSchema)).not.toThrow();
  });

  it("compares Backend symbols and artifact paths without emitting", async () => {
    const [base, head] = await snapshots(
      { token: { $type: "number", $value: 1 } },
      { token: { $type: "number", $value: 1 } },
    );
    const baseEmit = vi.fn<TokenBackend["emit"]>(() => []);
    const headEmit = vi.fn<TokenBackend["emit"]>(() => []);
    const baseBackend = plannedBackend("test", "--", "dist/tokens.css", baseEmit);
    const headBackend = plannedBackend("test", "--next-", "dist/theme.css", headEmit);
    const diff = await compareSnapshots(base, head, {
      context: { theme: "light" },
      backends: [{ id: "test", base: baseBackend, head: headBackend }],
    });

    expect(diff.backends.map(({ kind, before, after }) => ({ kind, before, after }))).toEqual([
      { kind: "artifact-path", before: "dist/tokens.css", after: "dist/theme.css" },
      { kind: "symbol", before: "--token", after: "--next-token" },
    ]);
    expect(baseEmit).not.toHaveBeenCalled();
    expect(headEmit).not.toHaveBeenCalled();
  });
});
