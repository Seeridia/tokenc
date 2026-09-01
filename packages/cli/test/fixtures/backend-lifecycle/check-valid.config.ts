import { ALL_TOKEN_TYPES, defineConfig, type TokenBackend } from "@tokenc/core";

const backend: TokenBackend = {
  id: "check-valid",
  capabilities: {
    tokenTypes: ALL_TOKEN_TYPES,
    referenceStrategies: new Set(["resolve"]),
    contextMode: "none",
    colorSpaces: "preserve",
    composite: "native",
  },
  prepare: () => ({
    backendId: "check-valid",
    diagnostics: [],
    symbols: [],
    artifacts: [],
    data: null,
  }),
  emit: () => {
    throw new Error("backend emit must not run during tokenc check");
  },
};

export default defineConfig({ source: ["tokens.json"], outputs: [backend] });
