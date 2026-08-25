import packageManifest from "../package.json" with { type: "json" };

export const VERSION = packageManifest.version;

export * from "./model.js";
export * from "./token-id.js";
export * from "./parser.js";
export * from "./graph.js";
export { checkTokenGraph, CONTEXT_CYCLE_PROJECTION_LIMIT, suggestTokenIds } from "./checker.js";
export * from "./context.js";
export * from "./resolver.js";
export * from "./loader.js";
export * from "./compiler.js";
export * from "./incremental.js";
export * from "./dtcg/color.js";
export * from "./dtcg/format.js";
export * from "./dtcg/json-pointer.js";
export * from "./dtcg/resolver-document.js";
export * from "./extensions/context.js";
