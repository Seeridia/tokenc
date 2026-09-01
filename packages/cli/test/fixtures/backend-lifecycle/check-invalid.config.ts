import { ALL_TOKEN_TYPES, createDiagnostic, defineConfig, type TokenBackend } from "@tokenc/core";

const backend: TokenBackend = {
  id: "check-invalid",
  capabilities: {
    tokenTypes: ALL_TOKEN_TYPES,
    referenceStrategies: new Set(["resolve"]),
    contextMode: "none",
    colorSpaces: "preserve",
    composite: "native",
  },
  prepare: (ir) => ({
    backendId: "check-invalid",
    diagnostics: [
      createDiagnostic({
        code: "BACKEND_UNSUPPORTED_VALUE",
        severity: "error",
        message: "Backend fixture rejected the token",
        source: ir.tokens[0]!.source,
        anchor: { kind: "token", token: ir.tokens[0]!.id },
      }),
    ],
    symbols: [],
    artifacts: [],
    data: null,
  }),
  emit: () => {
    throw new Error("backend emit must not run after validation fails");
  },
};

export default defineConfig({ source: ["tokens.json"], outputs: [backend] });
