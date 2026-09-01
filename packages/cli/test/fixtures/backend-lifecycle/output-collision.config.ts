import { ALL_TOKEN_TYPES, defineConfig, type BackendPlan, type TokenBackend } from "@tokenc/core";

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

const emit = (plan: BackendPlan) =>
  plan.artifacts.map((artifact) => ({
    id: artifact.id,
    path: artifact.path,
    content: String(artifact.payload),
  }));

const first: TokenBackend = {
  id: "first",
  capabilities,
  prepare: () => ({
    backendId: "first",
    diagnostics: [],
    symbols: [],
    artifacts: [
      {
        id: "main",
        path: "dist/Shared.txt",
        mediaType: "text/plain",
        tokenIds: [],
        payload: "first",
      },
    ],
    data: null,
  }),
  emit,
};

const second: TokenBackend = {
  id: "second",
  capabilities,
  prepare: () => ({
    backendId: "second",
    diagnostics: [],
    symbols: [],
    artifacts: [
      {
        id: "main",
        path: "DIST/shared.txt",
        mediaType: "text/plain",
        tokenIds: [],
        payload: "second",
      },
    ],
    data: null,
  }),
  emit,
};

export default defineConfig({ source: ["tokens.json"], outputs: [first, second] });
