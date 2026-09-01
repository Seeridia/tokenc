import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const packageRoot = resolve(import.meta.dirname, "..");

describe("thin VS Code client boundary", () => {
  it("keeps compiler semantics behind the language-server process", async () => {
    const extension = await readFile(resolve(packageRoot, "src/extension.ts"), "utf8");
    expect(extension).not.toMatch(/@tokenc\/(?:core|cli|backend-)/u);
    expect(extension).not.toMatch(/parseToken|createCompilerSession|planRename|Graph/u);

    const server = await readFile(resolve(packageRoot, "src/server.ts"), "utf8");
    expect(server).toContain('from "@tokenc/language-server"');
    expect(server).not.toMatch(/@tokenc\/(?:core|cli|backend-)/u);
  });

  it("does not activate for arbitrary JSON files", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null || !("activationEvents" in manifest))
      throw new TypeError("Extension manifest has no activationEvents");
    const activationEvents = manifest.activationEvents;
    if (
      !Array.isArray(activationEvents) ||
      !activationEvents.every((event) => typeof event === "string")
    )
      throw new TypeError("Extension activationEvents are invalid");
    expect(activationEvents).not.toContain("onLanguage:json");
    expect(activationEvents).toContain("workspaceContains:**/tokenc.config.ts");
  });
});
