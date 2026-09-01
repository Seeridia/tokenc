import { describe, expect, it, vi } from "vite-plus/test";

import { ALL_TOKEN_TYPES, type TokenBackend } from "../src/backend.js";
import type { DocumentLoader, LoadedDocument } from "../src/loader.js";
import { CompilerSessionError, createCompilerSession } from "../src/session.js";
import { parseTokenId } from "../src/token-id.js";

const document = (identity: string, body: unknown): LoadedDocument => ({
  identity,
  content: typeof body === "string" ? body : JSON.stringify(body),
});

const contextDocument = (dark: number) => ({
  base: {
    $type: "number",
    $value: 1,
    $extensions: { "org.token-compiler.contexts": { "theme=dark": dark } },
  },
  alias: { $type: "number", $value: "{base}" },
});

const emptyBackend = (id: string): TokenBackend => ({
  id,
  capabilities: {
    tokenTypes: ALL_TOKEN_TYPES,
    referenceStrategies: new Set(["resolve"]),
    contextMode: "none",
    colorSpaces: "preserve",
    composite: "native",
  },
  prepare: () => ({ backendId: id, diagnostics: [], symbols: [], artifacts: [], data: null }),
  emit: () => [],
});

describe("CompilerSession", () => {
  it("publishes multi-document add, update, remove, and reconfigure transactions atomically", async () => {
    const session = createCompilerSession();
    const first = await session.apply({
      documents: [
        {
          kind: "add",
          document: document("/tokens/base.json", {
            base: { $type: "number", $value: 1 },
          }),
        },
        {
          kind: "add",
          document: document("/tokens/alias.json", {
            alias: { $type: "number", $value: "{base}" },
          }),
        },
      ],
    });
    const second = await session.apply({
      documents: [
        {
          kind: "update",
          document: document("/tokens/base.json", {
            base: { $type: "number", $value: 2 },
          }),
        },
        { kind: "remove", identity: "/tokens/alias.json" },
        {
          kind: "add",
          document: document("/tokens/other.json", {
            other: { $type: "number", $value: 3 },
          }),
        },
      ],
      config: { contexts: { theme: { default: "light", values: ["light", "dark"] } } },
    });

    expect(first).toMatchObject({ status: "valid", revision: 1, graphRevision: 1 });
    expect(second).toMatchObject({ status: "valid", revision: 2, graphRevision: 2 });
    expect(second.query.completions()).toEqual(["base", "other"]);
    expect(second.configurationIdentity).not.toBe(first.configurationIdentity);
    expect(session.currentSnapshot).toBe(second);
    expect(session.lastSuccessfulSnapshot).toBe(second);
    expect(session.metrics?.stages.parse.invalidations).toEqual([
      "document-added",
      "content-changed",
      "document-removed",
    ]);
  });

  it("publishes invalid source state without replacing the last successful snapshot", async () => {
    const session = createCompilerSession();
    const valid = await session.apply({
      documents: [
        {
          kind: "add",
          document: document("/tokens/value.json", {
            value: { $type: "number", $value: 1 },
          }),
        },
      ],
    });
    const retained = JSON.stringify(valid);
    const invalid = await session.apply({
      documents: [{ kind: "update", document: document("/tokens/value.json", "{") }],
    });

    expect(valid.status).toBe("valid");
    expect(invalid.status).toBe("invalid");
    expect(session.lastSuccessfulSnapshot).toBe(valid);
    expect(JSON.stringify(valid)).toBe(retained);
    const recovered = await session.apply({
      documents: [
        {
          kind: "update",
          document: document("/tokens/value.json", {
            value: { $type: "number", $value: 2 },
          }),
        },
      ],
    });
    expect(session.currentSnapshot).toBe(recovered);
    expect(recovered.status).toBe("valid");
    expect(recovered.revision).toBe(3);
    expect(session.lastSuccessfulSnapshot).toBe(recovered);
    expect(JSON.stringify(valid)).toContain('"revision":1');
  });

  it("serializes concurrent apply calls in FIFO order", async () => {
    let release: ((value: LoadedDocument) => void) | undefined;
    const loader: DocumentLoader = {
      load: vi.fn<DocumentLoader["load"]>(
        () =>
          new Promise<LoadedDocument>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const session = createCompilerSession({ loader });
    const firstPending = session.apply({
      documents: [{ kind: "add", request: { specifier: "first" } }],
    });
    const secondPending = session.apply({
      documents: [
        {
          kind: "add",
          document: document("second", { second: { $type: "number", $value: 2 } }),
        },
      ],
    });

    await Promise.resolve();
    expect(session.currentSnapshot).toBeUndefined();
    release?.(document("first", { first: { $type: "number", $value: 1 } }));
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.query.completions()).toEqual(["first", "second"]);
  });

  it("deduplicates identical load requests and diagnoses conflicting changes", async () => {
    const load = vi.fn<DocumentLoader["load"]>(async () =>
      document("canonical", { value: { $value: 1 } }),
    );
    const session = createCompilerSession({ loader: { load } });
    const snapshot = await session.apply({
      documents: [
        { kind: "add", request: { specifier: "same" } },
        { kind: "update", request: { specifier: "same" } },
      ],
    });

    expect(load).toHaveBeenCalledOnce();
    expect(snapshot.status).toBe("invalid");
    expect(snapshot.diagnostics.map((item) => item.code)).toContain("SESSION_CONFLICTING_CHANGE");
  });

  it("publishes Backend-only configuration changes without changing graph identity", async () => {
    const session = createCompilerSession({ config: { backends: [emptyBackend("first")] } });
    const first = await session.apply({
      documents: [
        {
          kind: "add",
          document: document("tokens", { value: { $type: "number", $value: 1 } }),
        },
      ],
    });
    const second = await session.apply({ config: { backends: [emptyBackend("second")] } });

    expect(second.revision).toBe(first.revision + 1);
    expect(second.graphRevision).toBe(first.graphRevision);
    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(session.backends.map((item) => item.id)).toEqual(["second"]);
  });

  it("reuses independent link components and only recomputes the affected resolver closure", async () => {
    const session = createCompilerSession();
    await session.apply({
      documents: [
        {
          kind: "add",
          document: document("independent", {
            independent: { $type: "number", $value: 0 },
          }),
        },
        {
          kind: "add",
          document: document("primitive", { base: { $type: "number", $value: 1 } }),
        },
        {
          kind: "add",
          document: document("semantic", {
            alias: { $type: "number", $value: "{base}" },
          }),
        },
      ],
    });

    const snapshot = await session.apply({
      documents: [
        {
          kind: "update",
          document: document("primitive", { base: { $type: "number", $value: 2 } }),
        },
      ],
    });

    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    expect(snapshot.query.resolve(parseTokenId("alias"))?.value).toBe(2);
    expect(session.metrics).toMatchObject({
      revision: 2,
      documents: 3,
      changedTokens: 1,
      affectedTokens: 2,
      stages: {
        parse: { hits: 2, misses: 1, reused: 2, recomputed: 1 },
        link: { hits: 1, misses: 1, reused: 1, recomputed: 2 },
        graph: { hits: 0, misses: 1, reused: 0, recomputed: 3 },
        resolve: { hits: 1, misses: 2, reused: 1, recomputed: 2 },
        backendPlan: {
          enabled: false,
          hits: 0,
          misses: 0,
          reused: 0,
          recomputed: 0,
          invalidations: ["cache-disabled"],
        },
      },
    });
    expect(session.metrics?.stages.parse.invalidations).toEqual(["content-changed"]);
    expect(session.metrics?.stages.link.invalidations).toEqual(["component-changed"]);
    expect(session.metrics?.stages.graph.invalidations).toEqual(["linked-document-changed"]);
    expect(session.metrics?.stages.resolve.invalidations).toEqual(["graph-changed"]);
    expect(Object.isFrozen(session.metrics)).toBe(true);

    const backendOnly = await session.apply({ config: { backends: [emptyBackend("next")] } });
    expect(backendOnly.graphRevision).toBe(snapshot.graphRevision);
    expect(session.metrics).toMatchObject({
      revision: 3,
      changedTokens: 0,
      affectedTokens: 0,
      stages: {
        parse: { hits: 3, misses: 0, reused: 3, recomputed: 0, invalidations: [] },
        link: { hits: 2, misses: 0, reused: 3, recomputed: 0, invalidations: [] },
        graph: { hits: 1, misses: 0, reused: 3, recomputed: 0, invalidations: [] },
        resolve: { hits: 3, misses: 0, reused: 3, recomputed: 0, invalidations: [] },
      },
    });
  });

  it("retains cached resolutions whose Context does not intersect an override edit", async () => {
    const session = createCompilerSession({
      config: { contexts: { theme: { default: "light", values: ["light", "dark"] } } },
    });
    const first = await session.apply({
      documents: [{ kind: "add", document: document("tokens", contextDocument(2)) }],
    });
    if (first.status !== "valid") throw new Error("Expected a valid snapshot");
    expect(first.query.resolve(parseTokenId("alias"), { theme: "dark" })?.value).toBe(2);

    const second = await session.apply({
      documents: [{ kind: "update", document: document("tokens", contextDocument(3)) }],
    });
    if (second.status !== "valid") throw new Error("Expected a valid snapshot");
    expect(second.query.resolve(parseTokenId("alias"), { theme: "light" })?.value).toBe(1);
    expect(second.query.resolve(parseTokenId("alias"), { theme: "dark" })?.value).toBe(3);
    expect(session.metrics).toMatchObject({
      changedTokens: 1,
      affectedTokens: 2,
      stages: {
        resolve: { hits: 2, misses: 2, reused: 2, recomputed: 2 },
      },
    });
  });

  it("does not publish cancellation and remains usable", async () => {
    const loader: DocumentLoader = {
      load: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const session = createCompilerSession({ loader });
    const initial = await session.apply({
      documents: [
        {
          kind: "add",
          document: document("initial", { value: { $type: "number", $value: 1 } }),
        },
      ],
    });
    const initialMetrics = session.metrics;
    const controller = new AbortController();
    const cancelled = session.apply(
      { documents: [{ kind: "update", request: { specifier: "initial" } }] },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(session.currentSnapshot).toBe(initial);
    expect(session.metrics).toBe(initialMetrics);
    const recovered = await session.apply({
      documents: [
        {
          kind: "update",
          document: document("initial", { value: { $type: "number", $value: 2 } }),
        },
      ],
    });
    expect(recovered.revision).toBe(2);
    expect(recovered.query.resolve(parseTokenId("value"))).toMatchObject({ value: 2 });
  });

  it("closes idempotently and rejects later transactions", async () => {
    const session = createCompilerSession();
    await session.close();
    await session.close();
    await expect(session.apply({})).rejects.toBeInstanceOf(CompilerSessionError);
    await expect(session.apply({})).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });
});
