import { describe, expect, it } from "vite-plus/test";

import { ALL_TOKEN_TYPES, type BackendPlan, type TokenBackend } from "../src/backend.js";
import {
  compileDocuments as compileSnapshot,
  defineConfig,
  type CompilationOptions,
} from "../src/compiler.js";
import { createDiagnostic } from "../src/diagnostic.js";
import type { TokenSourceInput } from "../src/loader.js";
import type {
  ColorValue,
  CompiledToken,
  CompilationStageTimings,
  OutputFile,
  TokenNode,
} from "../src/model.js";
import { parseTokenId } from "../src/token-id.js";

const PIPELINE_STAGES = ["parse", "link", "graph", "check", "resolve", "emit"] as const;
const TIMING_STAGES = [...PIPELINE_STAGES, "total"] as const;
const TEST_CAPABILITIES = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

function outputPlan(
  backendId: string,
  path: string,
  content: string,
  diagnostics = [] as BackendPlan["diagnostics"],
): BackendPlan {
  return {
    backendId,
    diagnostics,
    symbols: [],
    artifacts: [{ id: "main", path, mediaType: "text/plain", tokenIds: [], payload: content }],
    data: null,
  };
}

function emitPlan(plan: BackendPlan) {
  return plan.artifacts.map((artifact) => ({
    id: artifact.id,
    path: artifact.path,
    content: String(artifact.payload),
  }));
}

async function compileDocuments(
  sources: readonly TokenSourceInput[],
  options: CompilationOptions & {
    readonly outputs?: readonly TokenBackend[];
    readonly emit?: boolean;
  } = {},
) {
  const snapshot = await compileSnapshot(sources, options);
  const operation =
    snapshot.status === "valid"
      ? options.emit === false
        ? await snapshot.prepare(options.outputs ?? [])
        : await snapshot.emit(options.outputs ?? [])
      : { success: false, diagnostics: [], outputs: [] };
  const diagnostics = [...snapshot.diagnostics, ...operation.diagnostics];
  const outputs: readonly OutputFile[] = "outputs" in operation ? operation.outputs : [];
  return {
    success: snapshot.status === "valid" && operation.success,
    diagnostics,
    outputs,
    stats: snapshot.stats,
    compilation: {
      success: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
      tokensOfType: <T extends TokenNode["type"]>(type: T): readonly CompiledToken<T>[] =>
        snapshot.status === "valid"
          ? snapshot.ir.tokens.filter((token): token is CompiledToken<T> => token.type === type)
          : [],
      getDefinition: (id: Parameters<typeof snapshot.query.definition>[0]) =>
        snapshot.query.definition(id),
      getTokenAtSourcePosition: (document: string, offset: number) =>
        snapshot.query.tokenAt(document, offset),
      getCompletionCandidates: (prefix: string) => snapshot.query.completions(prefix),
    },
  };
}

function expectValidTimings(timings: CompilationStageTimings): void {
  expect(Object.keys(timings)).toEqual(TIMING_STAGES);
  for (const stage of TIMING_STAGES) {
    expect(Number.isFinite(timings[stage])).toBe(true);
    expect(timings[stage]).toBeGreaterThanOrEqual(0);
  }
  for (const stage of PIPELINE_STAGES) expect(timings.total).toBeGreaterThanOrEqual(timings[stage]);
}

describe("compiler pipeline", () => {
  it("produces backend-facing IR and stats", async () => {
    const backend: TokenBackend = {
      id: "test",
      capabilities: TEST_CAPABILITIES,
      prepare: (ir) =>
        outputPlan("test", "tokens.txt", ir.tokens.map((token) => token.id).join("\n")),
      emit: emitPlan,
    };
    const result = await compileDocuments(
      [
        {
          file: "tokens.json",
          content:
            '{"base":{"$type":"number","$value":1},"alias":{"$type":"number","$value":"{base}"}}',
        },
      ],
      { outputs: [backend] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toBe("base\nalias");
    expect(result.stats).toMatchObject({ tokens: 2, references: 1, contexts: 1 });
    expectValidTimings(result.stats.timings);
  });

  it("suppresses all artifacts when an error exists", async () => {
    const backend: TokenBackend = {
      id: "never",
      capabilities: TEST_CAPABILITIES,
      prepare: () => outputPlan("never", "bad", "bad"),
      emit: emitPlan,
    };
    const result = await compileDocuments(
      [{ file: "bad.json", content: '{"a":{"$type":"color","$value":"{missing}"}}' }],
      { outputs: [backend] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
  });

  it("collects backend validation diagnostics before emitting artifacts", async () => {
    let emitted = false;
    const backend: TokenBackend = {
      id: "validated",
      capabilities: TEST_CAPABILITIES,
      prepare: (ir) =>
        outputPlan("validated", "bad", "bad", [
          createDiagnostic({
            code: "BACKEND_UNSUPPORTED_VALUE",
            severity: "error",
            message: "Backend cannot represent this token",
            source: ir.tokens[0]!.source,
            anchor: { kind: "token", token: ir.tokens[0]!.id },
          }),
        ]),
      emit: () => {
        emitted = true;
        return [{ id: "main", path: "bad", content: "bad" }];
      },
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [backend] },
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BACKEND_UNSUPPORTED_VALUE",
    );
    expect(result.compilation.diagnostics).toEqual(result.diagnostics);
    expect(result.compilation.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(emitted).toBe(false);
  });

  it("does not prepare backends when frontend diagnostics already contain an error", async () => {
    let prepared = false;
    const backend: TokenBackend = {
      id: "never",
      capabilities: TEST_CAPABILITIES,
      prepare: () => {
        prepared = true;
        return outputPlan("never", "bad", "bad");
      },
      emit: () => [],
    };
    await compileDocuments(
      [{ file: "bad.json", content: '{"a":{"$type":"color","$value":"{missing}"}}' }],
      { outputs: [backend] },
    );
    expect(prepared).toBe(false);
  });

  it("prepares configured backends without emitting when emission is disabled", async () => {
    let prepared = false;
    let emitted = false;
    const backend: TokenBackend = {
      id: "check-only",
      capabilities: TEST_CAPABILITIES,
      prepare: () => {
        prepared = true;
        return outputPlan("check-only", "should-not-exist.txt", "bad");
      },
      emit: () => {
        emitted = true;
        return [{ id: "main", path: "should-not-exist.txt", content: "bad" }];
      },
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [backend], emit: false },
    );
    expect(result.success).toBe(true);
    expect(prepared).toBe(true);
    expect(emitted).toBe(false);
    expect(result.outputs).toEqual([]);
  });

  it("rejects invalid output paths before emission", async () => {
    let emitted = false;
    const first: TokenBackend = {
      id: "first",
      capabilities: TEST_CAPABILITIES,
      prepare: () => outputPlan("first", "dist/nested/../shared.txt", "first"),
      emit: (plan) => {
        emitted = true;
        return emitPlan(plan);
      },
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [first] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_ARTIFACT_INVALID_PATH",
        severity: "error",
      }),
    );
    expect(emitted).toBe(false);
    expect(result.compilation.diagnostics).toEqual(result.diagnostics);
    expect(result.compilation.success).toBe(false);
  });

  it("conservatively rejects output paths that differ only by case", async () => {
    const first: TokenBackend = {
      id: "uppercase",
      capabilities: TEST_CAPABILITIES,
      prepare: () => outputPlan("uppercase", "dist/Tokens.CSS", "first"),
      emit: emitPlan,
    };
    const second: TokenBackend = {
      id: "lowercase",
      capabilities: TEST_CAPABILITIES,
      prepare: () => outputPlan("lowercase", "DIST/tokens.css", "second"),
      emit: emitPlan,
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [first, second] },
    );

    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BACKEND_ARTIFACT_COLLISION",
    );
  });

  it("rejects canonically equivalent Unicode output paths", async () => {
    const first: TokenBackend = {
      id: "composed",
      capabilities: TEST_CAPABILITIES,
      prepare: () => outputPlan("composed", "dist/R\u00e9sum\u00e9.css", "first"),
      emit: emitPlan,
    };
    const second: TokenBackend = {
      id: "decomposed",
      capabilities: TEST_CAPABILITIES,
      prepare: () => outputPlan("decomposed", "dist/RE\u0301SUME\u0301.css", "second"),
      emit: emitPlan,
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [first, second] },
    );

    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BACKEND_ARTIFACT_COLLISION",
    );
  });

  it("diagnoses duplicate canonical IDs across documents", async () => {
    const token = '{"a":{"$type":"number","$value":1}}';
    const result = await compileDocuments([
      { file: "one.json", content: token },
      { file: "two.json", content: token },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("TOKEN_DUPLICATE_ID");
  });

  it("diagnoses duplicate JSON properties that form the same canonical ID", async () => {
    const result = await compileDocuments([
      {
        file: "duplicate.json",
        content: '{"a":{"$type":"number","$value":1},"a":{"$type":"number","$value":2}}',
      },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("TOKEN_DUPLICATE_ID");
  });

  it("provides a type-directed backend view", async () => {
    const result = await compileDocuments([
      {
        file: "typed.json",
        content: JSON.stringify({
          brand: {
            $type: "color",
            $value: {
              colorSpace: "srgb",
              components: [0, 82 / 255, 217 / 255],
              alpha: 1,
              hex: "#0052D9",
            },
          },
        }),
      },
    ]);
    const value: ColorValue | undefined = result.compilation.tokensOfType("color")[0]?.value;
    expect(value).toMatchObject({ colorSpace: "srgb" });
    expect(result.compilation.tokensOfType("number")).toEqual([]);
  });

  it("exposes no compiler dialect configuration", () => {
    expect(defineConfig({ source: [] })).toEqual({ source: [] });
    void defineConfig({
      source: [],
      // @ts-expect-error -- tokenc compiles DTCG and no longer accepts a proprietary dialect.
      dialect: "tokenc",
    });
  });

  it("exposes source and completion queries for language tooling", async () => {
    const content =
      '{"color":{"$type":"number","blue":{"$value":1},"brand":{"$value":"{color.blue}"}}}';
    const result = await compileDocuments([{ file: "/tokens/lsp.json", content }]);
    const brand = parseTokenId("color.brand");
    const definition = result.compilation.getDefinition(brand);
    expect(definition?.file).toBe("/tokens/lsp.json");
    expect(
      result.compilation.getTokenAtSourcePosition("/tokens/lsp.json", definition?.offset ?? -1)?.id,
    ).toBe(brand);
    expect(result.compilation.getCompletionCandidates("color.b")).toEqual([
      "color.blue",
      "color.brand",
    ]);
  });
});
