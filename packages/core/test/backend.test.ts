import { describe, expect, it, vi } from "vite-plus/test";

import {
  ALL_TOKEN_TYPES,
  BackendContractError,
  SymbolAllocator,
  type BackendPlan,
  type SymbolNamespace,
  type TokenBackend,
} from "../src/backend.js";
import { compileDocuments } from "../src/compiler.js";
import type { TokenNode } from "../src/model.js";

const TEST_CAPABILITIES = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

const IDENTIFIER_NAMESPACE: SymbolNamespace = {
  name: "identifier",
  caseSensitive: false,
  normalize: "NFKC",
  reserved: new Set(["class"]),
  pattern: /^[A-Za-z_][A-Za-z0-9_]*$/u,
};

async function sourceTokens(): Promise<readonly TokenNode[]> {
  const result = await compileDocuments([
    {
      file: "tokens.json",
      content: '{"first":{"$type":"number","$value":1},"second":{"$type":"number","$value":2}}',
    },
  ]);
  if (result.status !== "valid") throw new Error("Expected a valid snapshot");
  return result.ir.sourceTokens;
}

function plan(backendId: string, artifactPath: string): BackendPlan {
  return {
    backendId,
    diagnostics: [],
    symbols: [],
    artifacts: [
      {
        id: "main",
        path: artifactPath,
        mediaType: "text/plain",
        tokenIds: [],
        payload: backendId,
      },
    ],
    data: null,
  };
}

function backend(id: string, artifactPath: string, emit: TokenBackend["emit"]): TokenBackend {
  return {
    id,
    capabilities: TEST_CAPABILITIES,
    prepare: () => plan(id, artifactPath),
    emit,
  };
}

describe("SymbolAllocator", () => {
  it("normalizes Unicode and case before detecting collisions", async () => {
    const [first, second] = await sourceTokens();
    const result = new SymbolAllocator().allocate({
      backendId: "test",
      requests: [
        { id: "first", token: first!, namespace: IDENTIFIER_NAMESPACE, name: "Ｆoo" },
        { id: "second", token: second!, namespace: IDENTIFIER_NAMESPACE, name: "foo" },
      ],
    });

    expect(result.symbols.map((symbol) => symbol.name)).toEqual(["Foo"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_SYMBOL_COLLISION" }),
    );
  });

  it("validates reserved names and patterns", async () => {
    const [first, second] = await sourceTokens();
    const result = new SymbolAllocator().allocate({
      backendId: "test",
      requests: [
        { id: "reserved", token: first!, namespace: IDENTIFIER_NAMESPACE, name: "CLASS" },
        { id: "invalid", token: second!, namespace: IDENTIFIER_NAMESPACE, name: "1value" },
      ],
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "BACKEND_SYMBOL_RESERVED",
      "BACKEND_SYMBOL_INVALID",
    ]);
  });

  it("uses explicit rename maps and keeps namespaces independent", async () => {
    const [first, second] = await sourceTokens();
    const otherNamespace = { ...IDENTIFIER_NAMESPACE, name: "other" };
    const result = new SymbolAllocator().allocate({
      backendId: "test",
      renameMap: { first: "renamed" },
      requests: [
        { id: "first", token: first!, namespace: IDENTIFIER_NAMESPACE, name: "same" },
        { id: "second", token: second!, namespace: IDENTIFIER_NAMESPACE, name: "same" },
        { id: "other", token: second!, namespace: otherNamespace, name: "renamed" },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.symbols.map((symbol) => [symbol.namespace, symbol.name])).toEqual([
      ["identifier", "renamed"],
      ["identifier", "same"],
      ["other", "renamed"],
    ]);
  });

  it("turns naming callback failures into diagnostics without partial symbols", async () => {
    const [first, second] = await sourceTokens();
    const result = new SymbolAllocator().allocate({
      backendId: "test",
      requests: [
        { id: "valid", token: second!, namespace: IDENTIFIER_NAMESPACE, name: "valid" },
        {
          id: "first",
          token: first!,
          namespace: IDENTIFIER_NAMESPACE,
          name: () => {
            throw new Error("boom");
          },
        },
      ],
    });

    expect(result.symbols).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_NAMING_FAILED",
        message: expect.stringContaining("boom"),
      }),
    );
  });
});

describe("Backend plan conformance", () => {
  it("runs zero emits after a cross-Backend artifact collision", async () => {
    const firstEmit = vi.fn<TokenBackend["emit"]>(() => []);
    const secondEmit = vi.fn<TokenBackend["emit"]>(() => []);
    const snapshot = await compileDocuments([
      { file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' },
    ]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const result = await snapshot.emit([
      backend("first", "dist/Tokens.css", firstEmit),
      backend("second", "DIST/tokens.css", secondEmit),
    ]);

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_ARTIFACT_COLLISION" }),
    );
    expect(firstEmit).not.toHaveBeenCalled();
    expect(secondEmit).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([]);
  });

  it("collects capability and plan errors before every emit", async () => {
    const emit = vi.fn<TokenBackend["emit"]>(() => []);
    const unsupported: TokenBackend = {
      id: "unsupported",
      capabilities: { ...TEST_CAPABILITIES, tokenTypes: new Set() },
      prepare: () => plan("unsupported", "../escape.txt"),
      emit,
    };
    const snapshot = await compileDocuments([
      { file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' },
    ]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const result = await snapshot.emit([unsupported]);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "BACKEND_UNSUPPORTED_TYPE",
      "BACKEND_ARTIFACT_INVALID_PATH",
    ]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects references when a Backend declares no reference strategy", async () => {
    const emit = vi.fn<TokenBackend["emit"]>(() => []);
    const unsupported: TokenBackend = {
      id: "no-references",
      capabilities: { ...TEST_CAPABILITIES, referenceStrategies: new Set() },
      prepare: () => ({ ...plan("no-references", "dist/value.txt"), artifacts: [] }),
      emit,
    };
    const snapshot = await compileDocuments([
      {
        file: "tokens.json",
        content:
          '{"base":{"$type":"number","$value":1},"alias":{"$type":"number","$value":"{base}"}}',
      },
    ]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const result = await snapshot.emit([unsupported]);

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_UNSUPPORTED_REFERENCE_STRATEGY" }),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing output",
      emit: () => [],
    },
    {
      name: "extra output",
      emit: () => [
        { id: "main", path: "dist/a.txt", content: "a" },
        { id: "extra", path: "dist/b.txt", content: "b" },
      ],
    },
    {
      name: "changed path",
      emit: () => [{ id: "main", path: "dist/other.txt", content: "a" }],
    },
    {
      name: "changed identity",
      emit: () => [{ id: "other", path: "dist/a.txt", content: "a" }],
    },
  ])("throws BackendContractError for $name", async ({ emit }) => {
    await expect(
      compileDocuments([
        { file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' },
      ]).then((snapshot) => {
        if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
        return snapshot.emit([backend("broken", "dist/a.txt", emit)]);
      }),
    ).rejects.toBeInstanceOf(BackendContractError);
  });

  it("passes only the immutable IR to prepare", async () => {
    const prepare = vi.fn<TokenBackend["prepare"]>((ir) => {
      expect(Object.isFrozen(ir)).toBe(true);
      expect(Object.isFrozen(ir.tokens)).toBe(true);
      expect("graph" in ir).toBe(false);
      expect("resolver" in ir).toBe(false);
      return plan("reference", "dist/reference.txt");
    });
    const reference = backend("reference", "dist/reference.txt", (value) => [
      { id: "main", path: value.artifacts[0]!.path, content: "reference" },
    ]);
    const configured = { ...reference, prepare };
    const snapshot = await compileDocuments([
      { file: "tokens.json", content: '{"a":{"$type":"number","$value":1}}' },
    ]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const result = await snapshot.emit([configured]);

    expect(result.success).toBe(true);
    expect(result.outputs).toEqual([
      { id: "main", path: "dist/reference.txt", content: "reference" },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
  });
});
