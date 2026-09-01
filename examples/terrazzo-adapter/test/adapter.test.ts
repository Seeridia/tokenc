import { readFile } from "node:fs/promises";

import { compileDocuments, parseTokenId } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import {
  BundledDtcgDocumentLoader,
  classifyTerrazzoBundleExtensions,
  compileTerrazzoBundle,
} from "../src/index.js";

const validBundle = JSON.stringify({
  value: {
    $type: "number",
    $value: 1,
    $extensions: {
      "org.example.metadata": { source: "Terrazzo" },
    },
  },
});

describe("Terrazzo bundled-DTCG adapter", () => {
  it("compiles one in-memory bundle through the public Loader and Session boundary", async () => {
    const identity = "/virtual/terrazzo/bundled.tokens.json";
    const result = await compileTerrazzoBundle({ content: validBundle, version: "fixture-1" });
    const direct = await compileDocuments([{ file: identity, content: validBundle }]);

    expect(result.snapshot.status).toBe("valid");
    expect(result.loaderRequests).toEqual([identity]);
    expect(result.snapshot.query.token(parseTokenId("value"))?.extensions).toEqual({
      "org.example.metadata": { source: "Terrazzo" },
    });
    expect(result.snapshot.query.token(parseTokenId("value"))).toEqual(
      direct.query.token(parseTokenId("value")),
    );
    expect(result.snapshot.query.graph()).toEqual(direct.query.graph());
    expect(result.snapshot.diagnostics).toEqual(direct.diagnostics);
    expect(result.extensions).toMatchObject({
      schemaVersion: "1",
      status: "unsupported",
      extensions: [
        {
          namespace: "org.example.metadata",
          pointer: "/value/$extensions/org.example.metadata",
          support: "preserved-unsupported",
        },
      ],
      issues: [],
    });
  });

  it("classifies interpreted, preserved-unsupported, and invalid extension data", () => {
    const classified = classifyTerrazzoBundleExtensions(
      JSON.stringify({
        token: {
          $type: "number",
          $value: 1,
          $extensions: {
            "org.example.transform": { operation: "custom" },
            "org.token-compiler.contexts": { "theme=dark": 2 },
          },
        },
      }),
    );
    expect(classified.extensions).toEqual([
      {
        namespace: "org.example.transform",
        pointer: "/token/$extensions/org.example.transform",
        support: "preserved-unsupported",
      },
      {
        namespace: "org.token-compiler.contexts",
        pointer: "/token/$extensions/org.token-compiler.contexts",
        support: "tokenc-interpreted",
      },
    ]);
    expect(classified.status).toBe("unsupported");

    expect(classifyTerrazzoBundleExtensions('{"token":{"$extensions":[]}}')).toMatchObject({
      status: "invalid",
      issues: [{ code: "invalid-extension-container", pointer: "/token/$extensions" }],
    });
    expect(classifyTerrazzoBundleExtensions("{")).toMatchObject({
      status: "invalid",
      issues: [{ code: "invalid-json", pointer: "" }],
    });
  });

  it("keeps an earlier Snapshot immutable when a later adapter compilation fails", async () => {
    const successful = await compileTerrazzoBundle({ content: validBundle });
    const before = successful.snapshot.query.token(parseTokenId("value"));
    const failed = await compileTerrazzoBundle({ content: "{" });

    expect(failed.snapshot.status).toBe("invalid");
    expect(successful.snapshot.status).toBe("valid");
    expect(successful.snapshot.query.token(parseTokenId("value"))).toEqual(before);
    expect(Object.isFrozen(successful.snapshot)).toBe(true);
  });

  it("rejects external loading and contains no network or Core deep-import path", async () => {
    const loader = new BundledDtcgDocumentLoader({ content: validBundle });
    await expect(loader.load({ specifier: "https://example.com/tokens.json" })).rejects.toThrow(
      "Bundle adapter cannot load external document",
    );

    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/from "@tokenc\/core"/u);
    expect(source).not.toMatch(/from "@tokenc\/core\//u);
    expect(source).not.toMatch(/node:https?|fetch\s*\(/u);
    expect(source).not.toMatch(/@terrazzo\//u);
  });
});
