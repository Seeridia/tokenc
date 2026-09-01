import packageManifest from "../package.json" with { type: "json" };

export const VERSION = packageManifest.version;

export * from "./model.js";
export * from "./diagnostic.js";
export * from "./backend.js";
export * from "./token-id.js";
export * from "./parser.js";
export type { ConditionalCycle, DependencyEdge, DependencyEdgeFilter } from "./graph.js";
export { CONTEXT_CYCLE_PROJECTION_LIMIT } from "./checker.js";
export * from "./context.js";
export * from "./predicate.js";
export type {
  CompilationQuery,
  ImpactedTokenV1,
  ImpactQueryV1,
  QueryEdgeV1,
  QueryRegion,
} from "./query.js";
export * from "./snapshot.js";
export * from "./snapshot-diff.js";
export * from "./breaking-policy.js";
export * from "./permutation.js";
export * from "./impact-report.js";
export * from "./session.js";
export * from "./differential.js";
export * from "./loader.js";
export {
  compile,
  compileDocuments,
  defineConfig,
  type CompilationOptions,
  type CompileOptions,
  type CompilerConfig,
  type ResolverFileConfig,
} from "./compiler.js";
export * from "./dtcg/color.js";
export * from "./dtcg/format.js";
export * from "./dtcg/json-pointer.js";
export * from "./dtcg/resolver-document.js";
export * from "./extensions/context.js";
