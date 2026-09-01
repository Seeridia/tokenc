import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildImpactReport, compile, parseTokenId } from "@tokenc/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configFileChanged,
  isConfigFileEvent,
  shouldReloadConfigForEvent,
} from "../src/config-file.js";
import { loadConfig, runCli } from "../src/index.js";
import queryGolden from "./fixtures/query-v1.json" with { type: "json" };

const cwd = fileURLToPath(new URL("fixtures/basic", import.meta.url));
const output = fileURLToPath(new URL("fixtures/basic/dist", import.meta.url));
const resolverCwd = fileURLToPath(new URL("fixtures/resolver", import.meta.url));
const resolverOutput = fileURLToPath(new URL("fixtures/resolver/dist", import.meta.url));
const referencesCwd = fileURLToPath(new URL("fixtures/references", import.meta.url));
const backendLifecycleCwd = fileURLToPath(new URL("fixtures/backend-lifecycle", import.meta.url));
const backendLifecycleOutput = fileURLToPath(
  new URL("fixtures/backend-lifecycle/dist", import.meta.url),
);

function invokeAt(workingDirectory: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  return runCli(args, {
    cwd: workingDirectory,
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  }).then((code) => ({ code, stdout, stderr }));
}

const invoke = (args: readonly string[]) => invokeAt(cwd, args);

afterEach(async () => {
  await Promise.all(
    [output, resolverOutput, backendLifecycleOutput].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("tokenc CLI", () => {
  it("tracks the actual default and explicit dev config paths", () => {
    const defaultConfig = resolve(cwd, "tokenc.config.ts");
    expect(isConfigFileEvent(defaultConfig, defaultConfig, cwd)).toBe(true);
    expect(isConfigFileEvent("tokenc.config.ts", defaultConfig, cwd)).toBe(true);

    const customConfig = resolve(cwd, "configurations/custom.ts");
    const customRoot = dirname(customConfig);
    expect(isConfigFileEvent("custom.ts", customConfig, customRoot)).toBe(true);
    expect(isConfigFileEvent(defaultConfig, customConfig, customRoot)).toBe(false);
  });

  it("detects backend-only edits to a custom dev config", () => {
    const path = resolve(cwd, "custom.ts");
    const previous = {
      path,
      source: 'outputs: [css({ output: "dist/old.css" })]',
    };
    const next = {
      path,
      source: 'outputs: [css({ output: "dist/new.css" })]',
    };
    expect(configFileChanged(previous, next)).toBe(true);
    expect(configFileChanged(next, next)).toBe(false);
    expect(configFileChanged(next, { ...next, path: resolve(cwd, "tokenc.config.ts") })).toBe(true);
  });

  it("reloads modular configs without looping on generated outputs", () => {
    const configPath = resolve(cwd, "custom.ts");
    const tokenPath = resolve(cwd, "tokens/base.json");
    const outputPath = resolve(cwd, "generated/tokens.ts");
    const files = {
      configPath,
      tokenPaths: new Set([tokenPath]),
      outputPaths: new Set([outputPath]),
      watchRoot: cwd,
    };

    expect(shouldReloadConfigForEvent(resolve(cwd, "outputs.ts"), files)).toBe(true);
    expect(shouldReloadConfigForEvent(tokenPath, files)).toBe(false);
    expect(shouldReloadConfigForEvent(outputPath, files)).toBe(false);
  });

  it("builds configured artifacts", async () => {
    const result = await invoke(["build"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("✓ 5 tokens parsed");
    expect(await readFile(`${output}/tokens.css`, "utf8")).toContain(
      "--button-primary-background: var(--color-brand-default);",
    );
  });

  it("checks without writing outputs", async () => {
    const result = await invoke(["check"]);
    expect(result.stdout).toContain("tokenc check report v1\nVerdict: pass\nTokens: 5");
    await expect(readFile(`${output}/tokens.css`, "utf8")).rejects.toThrow(/ENOENT/u);
  });

  it("runs backend validation during check without invoking emit", async () => {
    const valid = await invokeAt(backendLifecycleCwd, [
      "check",
      "--config",
      "check-valid.config.ts",
    ]);
    expect(valid).toMatchObject({ code: 0, stderr: "" });

    const invalid = await invokeAt(backendLifecycleCwd, [
      "check",
      "--config",
      "check-invalid.config.ts",
      "--json",
    ]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      schemaVersion: "1",
      command: "check",
      verdict: "fail",
      diagnostics: [{ diagnostic: { code: "BACKEND_UNSUPPORTED_VALUE" } }],
    });
  });

  it("does not write artifacts when backend output paths collide", async () => {
    const result = await invokeAt(backendLifecycleCwd, [
      "build",
      "--config",
      "output-collision.config.ts",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "1",
      diagnostics: [{ code: "BACKEND_ARTIFACT_COLLISION" }],
    });
    await expect(readFile(`${backendLifecycleOutput}/shared.txt`, "utf8")).rejects.toThrow(
      /ENOENT/u,
    );
  });

  it("emits machine-readable diagnostics", async () => {
    const result = await invoke(["check", "--config", "../invalid/tokenc.config.ts", "--json"]);
    expect(result.code).toBe(1);
    const payload: unknown = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      schemaVersion: "1",
      command: "check",
      verdict: "fail",
      diagnostics: [{ diagnostic: { code: "TOKEN_UNKNOWN_REFERENCE" } }],
    });
    expect(payload).not.toHaveProperty("errors");
  });

  it("emits Diagnostic v1 findings through SARIF 2.1.0", async () => {
    const result = await invoke([
      "check",
      "--config",
      "../invalid/tokenc.config.ts",
      "--format=sarif",
    ]);
    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "tokenc", rules: [{ id: "TOKEN_UNKNOWN_REFERENCE" }] } },
          results: [
            {
              ruleId: "TOKEN_UNKNOWN_REFERENCE",
              level: "error",
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "tokens.json" },
                    region: { startLine: 14, startColumn: 26 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("explains the real dependency chain", async () => {
    const result = await invoke(["explain", "button.primary.background"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "button.primary.background\n└─ color.brand.default\n   └─ color.blue.600\n      └─ #0052D9",
    );
    expect(result.stdout).toContain("Reverse dependencies:\n  0");
  });

  it("queries direct and indirect usages from reverse graph edges", async () => {
    const result = await invoke(["usages", "color.blue.600"]);
    expect(result.stdout).toContain("Direct usages:\n\n└─ color.brand.default");
    expect(result.stdout).toContain("Indirect usages:\n\n└─ button.primary.background");
    expect(result.stdout).toContain("2 total dependent tokens");
  });

  it("renders dependency graphs as Mermaid", async () => {
    const result = await invoke(["graph", "--format", "mermaid"]);
    expect(result.stdout).toContain('"color.blue.600" --> "color.brand.default"');
  });

  it("limits rooted Mermaid graphs to the forward dependency closure", async () => {
    const result = await invoke(["graph", "button.primary.background", "--format", "mermaid"]);
    expect(result.stdout).toContain('"color.brand.default" --> "button.primary.background"');
    expect(result.stdout).toContain('"color.blue.600" --> "color.brand.default"');
  });

  it("renders a complete multi-level text dependency tree", async () => {
    const result = await invoke(["graph", "button.primary.background"]);
    expect(result.stdout).toBe(
      "Dependency graph v1\nbutton.primary.background\n└─ color.brand.default\n   └─ color.blue.600\n",
    );
  });

  it("emits deterministic Query and Trace v1 JSON matching golden fixtures", async () => {
    const explain = await invoke(["explain", "button.primary.background", "--json"]);
    const usages = await invoke(["usages", "color.blue.600", "--json"]);
    const graph = await invoke(["graph", "button.primary.background", "--json"]);

    expect(JSON.parse(explain.stdout)).toMatchObject(queryGolden.explain);
    expect(JSON.parse(usages.stdout)).toMatchObject(queryGolden.usages);
    expect(JSON.parse(graph.stdout)).toMatchObject(queryGolden.graph);
    expect(explain.stdout).toBe(
      (await invoke(["explain", "button.primary.background", "--json"])).stdout,
    );
    expect(usages.stdout).toBe((await invoke(["usages", "color.blue.600", "--json"])).stdout);
    expect(graph.stdout).toBe(
      (await invoke(["graph", "button.primary.background", "--json"])).stdout,
    );
  });

  it("matches direct Core diagnostics, traces, and Context query results", async () => {
    const config = await loadConfig(cwd);
    const snapshot = await compile(config);
    if (snapshot.status !== "valid") throw new Error("Expected valid direct-Core snapshot");
    const explainId = parseTokenId("button.primary.background");
    const usageId = parseTokenId("color.blue.600");

    const explain = await invoke(["explain", explainId, "--json"]);
    const usages = await invoke(["usages", usageId, "--json"]);
    const graph = await invoke(["graph", explainId, "--json"]);
    expect(JSON.parse(explain.stdout)).toEqual(snapshot.query.explain(explainId));
    expect(JSON.parse(usages.stdout)).toEqual({
      schemaVersion: "1",
      token: usageId,
      usages: snapshot.query.usages(usageId),
      impact: snapshot.query.impact([usageId]),
    });
    expect(JSON.parse(graph.stdout)).toEqual({
      schemaVersion: "1",
      roots: [explainId],
      edges: snapshot.query.graph([explainId]),
    });

    const invalidConfig = await loadConfig(cwd, "../invalid/tokenc.config.ts");
    const invalidSnapshot = await compile(invalidConfig);
    const invalid = await invoke(["check", "--config", "../invalid/tokenc.config.ts", "--json"]);
    expect(
      JSON.parse(invalid.stdout).diagnostics.map(
        (item: { diagnostic: { fingerprint: string } }) => item.diagnostic.fingerprint,
      ),
    ).toEqual(invalidSnapshot.diagnostics.map((item) => item.fingerprint));
  });

  it("reports source-to-Token impact with Core/CLI JSON parity", async () => {
    const config = await loadConfig(cwd);
    const snapshot = await compile(config);
    const document = snapshot.documents.find((entry) =>
      entry.identity.endsWith("/tokens/primitive.json"),
    )?.identity;
    if (!document) throw new Error("Expected primitive source document");

    const result = await invoke(["impact", "tokens/primitive.json", "--format", "json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(
      buildImpactReport(snapshot, { documents: [document] }),
    );
    expect(result.stdout).toBe(
      (await invoke(["impact", "tokens/primitive.json", "--format=json"])).stdout,
    );
  });

  it("renders impact text and distinguishes empty or unknown source paths", async () => {
    const text = await invoke(["impact", "tokens/primitive.json"]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain("Impact Report v1\nStatus: complete");
    expect(text.stdout).toContain("Directly changed:\n\n├─ color.blue.600");
    expect(text.stdout).toContain("Directly affected:\n\n├─ color.brand.default");
    expect(text.stdout).toContain("Transitively affected:\n\n└─ button.primary.background");

    const unknown = await invoke(["impact", "tokens/missing.json", "--format", "json"]);
    expect(unknown).toMatchObject({ code: 2, stderr: "" });
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      status: "incomplete",
      request: { sources: [{ status: "unknown", tokens: [] }] },
    });
  });

  it("accepts repeatable Context filters and fails closed for unsupported coverage", async () => {
    const result = await invokeAt(resolverCwd, [
      "impact",
      "tokens/base.json",
      "--context",
      "theme=dark",
      "--format=json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "complete",
      request: { context: { theme: "dark" } },
    });

    const invalid = await invokeAt(resolverCwd, [
      "impact",
      "tokens/base.json",
      "--context=theme=unknown",
      "--format=json",
    ]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      status: "incomplete",
      diagnostics: [{ diagnostic: { code: "TOKEN_CONTEXT_UNKNOWN_VALUE" } }],
    });
  });

  it("returns incomplete impact for an invalid Snapshot", async () => {
    const result = await invoke([
      "impact",
      "tokens.json",
      "--config",
      "../invalid/tokenc.config.ts",
      "--format=json",
    ]);
    expect(result).toMatchObject({ code: 2, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "incomplete",
      snapshot: { status: "invalid" },
      coverage: { compared: [], omitted: [{ reason: "invalid-head" }] },
      diagnostics: [{ side: "head", diagnostic: { code: "TOKEN_UNKNOWN_REFERENCE" } }],
    });
  });

  it("explains JSON Pointer components and inherited provenance", async () => {
    const pointer = await invokeAt(referencesCwd, ["explain", "firstX"]);
    expect(pointer).toMatchObject({ code: 0, stderr: "" });
    expect(pointer.stdout).toContain("JSON Pointer #/curve/$value/0 → curve");
    expect(pointer.stdout).toContain("Dependencies:\n  1");

    const inherited = await invokeAt(referencesCwd, ["explain", "derived.small"]);
    expect(inherited).toMatchObject({ code: 0, stderr: "" });
    expect(inherited.stdout).toContain("Inherited from:\n  base.small");
    expect(inherited.stdout).toContain("Base group:\n  base");
  });

  it("finds usages introduced by a JSON Pointer component", async () => {
    const result = await invokeAt(referencesCwd, ["usages", "curve"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Direct usages:\n\n└─ firstX");
  });

  it("builds and explains a DTCG resolver context selected by flags", async () => {
    const build = await invokeAt(resolverCwd, ["build", "--theme", "dark"]);
    expect(build).toMatchObject({ code: 0, stderr: "" });
    expect(await readFile(`${resolverOutput}/tokens.css`, "utf8")).toContain(
      "--color-brand-default: oklch(0.72 0.14 250);",
    );
    const explain = await invokeAt(resolverCwd, [
      "explain",
      "color.brand.default",
      "--theme",
      "dark",
    ]);
    expect(explain.code).toBe(0);
    expect(explain.stdout).toContain("Resolution:\n  foundation\n  → theme.dark");
    expect(explain.stdout).toContain("Context:\n  theme = dark");
  });
});
