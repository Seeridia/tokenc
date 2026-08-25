import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { compileDocuments, defineConfig, type TokenBackend } from "../src/compiler.js";
import type { ColorValue } from "../src/model.js";
import { parseTokenId } from "../src/token-id.js";

describe("compiler pipeline", () => {
  it("produces backend-facing IR and stats", async () => {
    const backend: TokenBackend = {
      name: "test",
      emit: (compilation) => [
        { path: "tokens.txt", content: compilation.tokens.map((token) => token.id).join("\n") },
      ],
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
  });

  it("suppresses all artifacts when an error exists", async () => {
    const backend: TokenBackend = { name: "never", emit: () => [{ path: "bad", content: "bad" }] };
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
      name: "validated",
      validate: (compilation) => [
        {
          code: "BACKEND_TEST_ERROR",
          severity: "error",
          message: "Backend cannot represent this token",
          source: compilation.tokens[0]!.source,
        },
      ],
      emit: () => {
        emitted = true;
        return [{ path: "bad", content: "bad" }];
      },
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [backend] },
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("BACKEND_TEST_ERROR");
    expect(result.compilation.diagnostics).toEqual(result.diagnostics);
    expect(result.compilation.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(emitted).toBe(false);
  });

  it("does not validate backends when frontend diagnostics already contain an error", async () => {
    let validated = false;
    const backend: TokenBackend = {
      name: "never",
      validate: () => {
        validated = true;
        return [];
      },
      emit: () => [],
    };
    await compileDocuments(
      [{ file: "bad.json", content: '{"a":{"$type":"color","$value":"{missing}"}}' }],
      { outputs: [backend] },
    );
    expect(validated).toBe(false);
  });

  it("validates configured backends without emitting when emission is disabled", async () => {
    let validated = false;
    let emitted = false;
    const backend: TokenBackend = {
      name: "check-only",
      validate: () => {
        validated = true;
        return [];
      },
      emit: () => {
        emitted = true;
        return [{ path: "should-not-exist.txt", content: "bad" }];
      },
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [backend], emit: false },
    );
    expect(result.success).toBe(true);
    expect(validated).toBe(true);
    expect(emitted).toBe(false);
    expect(result.outputs).toEqual([]);
  });

  it("rejects colliding normalized output paths before returning artifacts", async () => {
    const outputRoot = resolve(process.cwd(), "virtual-output-root");
    const first: TokenBackend = {
      name: "first",
      emit: () => [{ path: resolve(outputRoot, "dist/shared.txt"), content: "first" }],
    };
    const second: TokenBackend = {
      name: "second",
      emit: () => [{ path: "dist/nested/../shared.txt", content: "second" }],
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [first, second], outputRoot },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_OUTPUT_PATH_COLLISION",
        severity: "error",
        message: expect.stringMatching(/`second`.*`first`/u),
      }),
    );
    expect(result.compilation.diagnostics).toEqual(result.diagnostics);
    expect(result.compilation.success).toBe(false);
  });

  it("conservatively rejects output paths that differ only by case", async () => {
    const outputRoot = resolve(process.cwd(), "virtual-output-root");
    const first: TokenBackend = {
      name: "uppercase",
      emit: () => [{ path: resolve(outputRoot, "dist/Tokens.CSS"), content: "first" }],
    };
    const second: TokenBackend = {
      name: "lowercase",
      emit: () => [{ path: "DIST/tokens.css", content: "second" }],
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [first, second], outputRoot },
    );

    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BACKEND_OUTPUT_PATH_COLLISION",
    );
  });

  it("rejects canonically equivalent Unicode output paths", async () => {
    const first: TokenBackend = {
      name: "composed",
      emit: () => [{ path: "dist/R\u00e9sum\u00e9.css", content: "first" }],
    };
    const second: TokenBackend = {
      name: "decomposed",
      emit: () => [{ path: "dist/RE\u0301SUME\u0301.css", content: "second" }],
    };
    const result = await compileDocuments(
      [{ file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' }],
      { outputs: [first, second] },
    );

    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "BACKEND_OUTPUT_PATH_COLLISION",
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
