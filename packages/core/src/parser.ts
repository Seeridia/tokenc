import {
  linkTokenDocuments,
  parseUnresolvedTokenDocument,
  type FrontendParseOptions,
} from "./frontend.js";
import type { ParsedTokenDocument } from "./model.js";

export type ParseTokenDocumentOptions = FrontendParseOptions;

/** Parse and semantically link one already-loaded DTCG JSON document. */
export function parseTokenDocument(
  content: string,
  source: string,
  options: ParseTokenDocumentOptions = {},
): ParsedTokenDocument {
  const unresolved = parseUnresolvedTokenDocument(content, source, options);
  return (
    linkTokenDocuments([unresolved])[0] ?? {
      source,
      content,
      tokens: [],
      diagnostics: unresolved.diagnostics,
    }
  );
}
