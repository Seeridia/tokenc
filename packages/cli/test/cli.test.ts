import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/index.js";

const cwd = fileURLToPath(new URL("fixtures/basic", import.meta.url));
const output = fileURLToPath(new URL("fixtures/basic/dist", import.meta.url));

function invoke(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  return runCli(args, {
    cwd,
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  }).then((code) => ({ code, stdout, stderr }));
}

afterEach(async () => rm(output, { recursive: true, force: true }));

describe("tokenc CLI", () => {
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
    expect(result.stdout).toContain("✓ 5 tokens checked");
    await expect(readFile(`${output}/tokens.css`, "utf8")).rejects.toThrow(/ENOENT/u);
  });

  it("emits machine-readable diagnostics", async () => {
    const result = await invoke(["check", "--config", "../invalid/tokenc.config.ts", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      errors: [{ code: "TOKEN_UNKNOWN_REFERENCE" }],
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

  it("renders a complete multi-level text dependency tree", async () => {
    const result = await invoke(["graph", "button.primary.background"]);
    expect(result.stdout).toBe(
      "button.primary.background\n└─ color.brand.default\n   └─ color.blue.600\n",
    );
  });
});
