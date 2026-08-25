import { defineConfig, type TokenBackend } from "@tokenc/core";

const backend: TokenBackend = {
  name: "check-valid",
  validate: () => [],
  emit: () => {
    throw new Error("backend emit must not run during tokenc check");
  },
};

export default defineConfig({ source: ["tokens.json"], outputs: [backend] });
