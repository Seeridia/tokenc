import { describe, expect, it } from "vite-plus/test";

import {
  configuredProfiles,
  createConfigurationSettings,
  createInitializationOptions,
  stringMap,
} from "../src/configuration.js";

describe("VS Code configuration projection", () => {
  it("sanitizes maps and profiles without interpreting compiler semantics", () => {
    expect(stringMap({ z: "last", invalid: 1, a: "first" })).toEqual({
      a: "first",
      z: "last",
    });
    expect(configuredProfiles({ dark: { theme: "dark" }, empty: {}, invalid: "nope" })).toEqual({
      dark: { theme: "dark" },
    });
  });

  it("forwards trust, config paths, and isolated workspace selections", () => {
    const folders = [
      {
        uri: "file:///workspace/a",
        configPath: "config/tokenc.config.ts",
        context: { theme: "dark" },
        resolverInput: {},
      },
      {
        uri: "file:///workspace/b",
        context: {},
        resolverInput: { brand: "mobile" },
      },
    ];
    expect(createInitializationOptions(false, { context: {}, resolverInput: {} }, folders)).toEqual(
      {
        trusted: false,
        trustedWorkspaces: {
          "file:///workspace/a": false,
          "file:///workspace/b": false,
        },
        configPaths: { "file:///workspace/a": "config/tokenc.config.ts" },
        workspaceSettings: {
          "file:///workspace/a": { context: { theme: "dark" } },
          "file:///workspace/b": { resolverInput: { brand: "mobile" } },
        },
      },
    );
    expect(createConfigurationSettings({ context: {}, resolverInput: {} }, folders)).toEqual({
      tokenc: {
        workspaces: {
          "file:///workspace/a": { context: { theme: "dark" } },
          "file:///workspace/b": { resolverInput: { brand: "mobile" } },
        },
      },
    });
  });
});
