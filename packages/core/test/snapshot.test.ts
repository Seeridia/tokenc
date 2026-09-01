import { describe, expect, it, vi } from "vite-plus/test";

import { ALL_TOKEN_TYPES, type BackendPlan, type TokenBackend } from "../src/backend.js";
import { CompilationSnapshotBuilder, compileDocuments } from "../src/compiler.js";
import { createDiagnostic } from "../src/diagnostic.js";
import { parseTokenId } from "../src/token-id.js";

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

const source = (value: number, prefix = "") => ({
  file: "/tokens/snapshot.json",
  content: `${prefix}${JSON.stringify({
    base: { $type: "number", $value: value },
    alias: { $type: "number", $value: "{base}" },
  })}`,
});

function backend(
  id: string,
  path: string,
  emit = vi.fn<TokenBackend["emit"]>((plan: BackendPlan) =>
    plan.artifacts.map((artifact) => ({
      id: artifact.id,
      path: artifact.path,
      content: String(artifact.payload),
    })),
  ),
): TokenBackend {
  return {
    id,
    capabilities,
    prepare: (ir) => ({
      backendId: id,
      diagnostics: [],
      symbols: [],
      artifacts: [
        {
          id: "main",
          path,
          mediaType: "text/plain",
          tokenIds: ir.tokens.map((token) => token.id),
          payload: ir.tokens
            .map((token) => `${token.id}=${JSON.stringify(token.value)}`)
            .join("\n"),
        },
      ],
      data: null,
    }),
    emit,
  };
}

describe("CompilationSnapshot", () => {
  it("increments revisions while preserving graphRevision for source-only changes", async () => {
    const builder = new CompilationSnapshotBuilder();
    const first = await builder.build([source(1)]);
    const moved = await builder.build([source(1, "\n\n")]);
    const changed = await builder.build([source(2)]);

    expect([first.revision, moved.revision, changed.revision]).toEqual([1, 2, 3]);
    expect(moved.graphRevision).toBe(first.graphRevision);
    expect(changed.graphRevision).toBe(first.graphRevision + 1);
    expect(moved.sourceRevision).not.toBe(first.sourceRevision);
    expect(moved.query.definition(parseTokenId("base"))?.line).toBe(3);
  });

  it("keeps a retained snapshot byte-identical after later builds", async () => {
    const builder = new CompilationSnapshotBuilder();
    const first = await builder.build([source(1)]);
    if (first.status !== "valid") throw new Error("Expected a valid snapshot");
    const before = JSON.stringify(first);
    const firstValue = first.query.resolve(parseTokenId("alias"));

    await builder.build([source(2)]);

    expect(first.query.resolve(parseTokenId("alias"))).toEqual(firstValue);
    expect(first.query.resolve(parseTokenId("alias"))?.value).toBe(1);
    expect(JSON.stringify(first)).toBe(before);
  });

  it("supports deterministic concurrent reads and emissions", async () => {
    const snapshot = await compileDocuments([source(1)]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const output = backend("text", "dist/tokens.txt");
    const id = parseTokenId("alias");

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => ({
        resolved: snapshot.query.resolve(id),
        trace: snapshot.query.explain(id),
        usages: snapshot.query.usages(parseTokenId("base")),
        emission: await snapshot.emit([output]),
      })),
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(Object.isFrozen(results[0]?.resolved)).toBe(true);
    expect(Object.isFrozen(results[0]?.resolved?.context)).toBe(true);
    expect(Object.isFrozen(results[0]?.usages[0]?.condition)).toBe(true);
    expect(Object.isFrozen(snapshot.ir.tokens[0]?.context)).toBe(true);
    expect(Object.isFrozen(results[0]?.emission.outputs[0])).toBe(true);
  });

  it("keeps concurrent high-fan-out queries deterministic", async () => {
    const dependentCount = 1_024;
    const snapshot = await compileDocuments([
      {
        file: "/tokens/fan-out.json",
        content: JSON.stringify({
          root: { $type: "number", $value: 1 },
          ...Object.fromEntries(
            Array.from({ length: dependentCount }, (_, index) => [
              `dependent${String(index).padStart(4, "0")}`,
              { $type: "number", $value: "{root}" },
            ]),
          ),
        }),
      },
    ]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const root = parseTokenId("root");

    const results = await Promise.all(
      Array.from({ length: 16 }, async () => ({
        usages: snapshot.query.usages(root),
        impact: snapshot.query.impact([root]),
        graph: snapshot.query.graph(),
        resolved: snapshot.query.resolve(parseTokenId("dependent0512")),
      })),
    );

    expect(results[0]?.usages).toHaveLength(dependentCount);
    expect(results[0]?.impact.directlyAffected).toHaveLength(dependentCount);
    expect(results[0]?.graph).toHaveLength(dependentCount);
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  }, 20_000);

  it("exposes graph queries but no IR or emit operation when invalid", async () => {
    const snapshot = await compileDocuments([
      {
        file: "/tokens/invalid.json",
        content: '{"alias":{"$type":"number","$value":"{missing}"}}',
      },
    ]);

    expect(snapshot.status).toBe("invalid");
    if (snapshot.status !== "invalid") throw new Error("Expected an invalid snapshot");
    expect("ir" in snapshot).toBe(false);
    expect("emit" in snapshot).toBe(false);
    expect(snapshot.query.token(parseTokenId("alias"))?.id).toBe("alias");
    expect(snapshot.query.resolve(parseTokenId("alias"))).toEqual({
      status: "unavailable",
      diagnostics: snapshot.diagnostics,
    });
    expect(snapshot.query.explain(parseTokenId("alias"))).toEqual({
      status: "unavailable",
      diagnostics: snapshot.diagnostics,
    });
  });

  it("keeps Backend diagnostics outside fixed snapshot diagnostics", async () => {
    const snapshot = await compileDocuments([source(1)]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const diagnosticsBefore = snapshot.diagnostics;
    const failing: TokenBackend = {
      ...backend("failing", "dist/tokens.txt"),
      prepare: (ir) => ({
        backendId: "failing",
        diagnostics: [
          createDiagnostic({
            code: "BACKEND_UNSUPPORTED_VALUE",
            message: "Cannot emit this value",
            source: ir.sourceTokens[0]!.source,
            anchor: { kind: "token", token: ir.sourceTokens[0]!.id },
          }),
        ],
        symbols: [],
        artifacts: [],
        data: null,
      }),
    };

    const operation = await snapshot.emit([failing]);

    expect(operation.success).toBe(false);
    expect(operation.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics).toBe(diagnosticsBefore);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("prevents all emits when otherwise-valid Backend plans collide", async () => {
    const snapshot = await compileDocuments([source(1)]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const firstEmit = vi.fn<TokenBackend["emit"]>(() => []);
    const secondEmit = vi.fn<TokenBackend["emit"]>(() => []);

    const operation = await snapshot.emit([
      backend("first", "dist/Tokens.txt", firstEmit),
      backend("second", "DIST/tokens.txt", secondEmit),
    ]);

    expect(operation.success).toBe(false);
    expect(operation.outputs).toEqual([]);
    expect(operation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BACKEND_ARTIFACT_COLLISION",
    );
    expect(firstEmit).not.toHaveBeenCalled();
    expect(secondEmit).not.toHaveBeenCalled();
  });
});
