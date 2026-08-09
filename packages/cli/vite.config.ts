import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/bin.ts"],
    clean: true,
    deps: { neverBundle: true },
    dts: true,
    fixedExtension: false,
    format: ["esm"],
    sourcemap: true,
    target: "node22",
  },
});
