import packageManifest from "../package.json" with { type: "json" };

export const VERSION = packageManifest.version;

export * from "./server.js";
export * from "./uri.js";
export * from "./workspace.js";
