import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  documentIdentityToFileUri,
  fileUriToDocumentIdentity,
  isDocumentInsideWorkspace,
} from "../src/uri.js";

describe("file URI mapping", () => {
  it("round-trips percent-encoded Unicode and spaces exactly once", () => {
    const identity = resolve("/tmp/tokenc space/令牌%25.json");
    const uri = documentIdentityToFileUri(identity);

    expect(fileUriToDocumentIdentity(uri)).toBe(identity);
    expect(uri).toContain("%20");
    expect(uri).toContain("%2525");
  });

  it("rejects non-file URIs and path-prefix lookalikes", () => {
    const root = resolve("/tmp/workspace");

    expect(fileUriToDocumentIdentity("untitled:tokens.json")).toBeUndefined();
    expect(isDocumentInsideWorkspace(resolve(root, "tokens.json"), root)).toBe(true);
    expect(isDocumentInsideWorkspace(resolve(`${root}-other`, "tokens.json"), root)).toBe(false);
    expect(fileUriToDocumentIdentity(pathToFileURL(root).href)).toBe(root);
  });
});
