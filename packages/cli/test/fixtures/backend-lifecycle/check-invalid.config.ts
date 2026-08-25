import { defineConfig, type TokenBackend } from "@tokenc/core";

const backend: TokenBackend = {
  name: "check-invalid",
  validate: (compilation) => [
    {
      code: "BACKEND_FIXTURE_INVALID",
      severity: "error",
      message: "Backend fixture rejected the token",
      source: compilation.tokens[0]!.source,
    },
  ],
  emit: () => {
    throw new Error("backend emit must not run after validation fails");
  },
};

export default defineConfig({ source: ["tokens.json"], outputs: [backend] });
