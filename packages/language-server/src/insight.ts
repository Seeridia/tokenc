import { isAbsolute, resolve } from "node:path";

import type {
  CompilationSnapshot,
  Diagnostic,
  EditorSymbolV1,
  SnapshotDocument,
  TokenId,
  TokenNode,
} from "@tokenc/core";
import {
  CompletionItemKind,
  MarkupKind,
  type CompletionItem,
  type CompletionList,
  type CompletionParams,
  type Hover,
  type HoverParams,
} from "vscode-languageserver/node.js";

import { offsetRangeToLspRange } from "./diagnostics.js";
import { positionToOffset } from "./navigation.js";
import { fileUriToDocumentIdentity } from "./uri.js";
import { type WorkspaceCoordinator, type WorkspaceManager } from "./workspace.js";

interface CurrentInsightDocument {
  readonly workspace: WorkspaceCoordinator;
  readonly snapshot: CompilationSnapshot;
  readonly document: SnapshotDocument;
}

function documentPath(document: SnapshotDocument, root: string): string {
  return resolve(isAbsolute(document.source) ? document.source : resolve(root, document.source));
}

function symbolAtCursor(
  snapshot: CompilationSnapshot,
  document: string,
  offset: number,
): EditorSymbolV1 | undefined {
  return (
    snapshot.query.symbolAt(document, offset) ??
    (offset > 0 ? snapshot.query.symbolAt(document, offset - 1) : undefined)
  );
}

function diagnosticMatches(
  diagnostic: Diagnostic,
  target: TokenId,
  token: TokenNode | undefined,
): boolean {
  if (diagnostic.parameters.token === target || diagnostic.parameters.target === target)
    return true;
  if (!token || !diagnostic.source || diagnostic.source.document !== token.source.file)
    return false;
  const start = diagnostic.source.range.offset;
  const end = start + diagnostic.source.range.length;
  return start < token.source.offset + token.source.length && end > token.source.offset;
}

/** Current-snapshot completion and hover projections backed only by Core Query facts. */
export class InsightProvider {
  readonly #workspaces: WorkspaceManager;

  constructor(workspaces: WorkspaceManager) {
    this.#workspaces = workspaces;
  }

  async completion(params: CompletionParams): Promise<CompletionList | null> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current) return null;
    const { workspace, snapshot, document } = current;
    const offset = positionToOffset(document.content, params.position);
    const symbol = symbolAtCursor(snapshot, document.source, offset);
    if (!symbol || symbol.role !== "alias") return null;
    const raw = document.content.slice(
      symbol.source.offset,
      symbol.source.offset + symbol.source.length,
    );
    const innerStart = symbol.source.offset + 1;
    const innerEnd = symbol.source.offset + symbol.source.length - 1;
    if (!raw.startsWith("{") || !raw.endsWith("}") || offset < innerStart || offset > innerEnd)
      return null;
    const prefix = document.content.slice(innerStart, offset);
    const range = offsetRangeToLspRange(document.content, {
      line: 1,
      column: 1,
      offset: innerStart,
      length: Math.max(0, innerEnd - innerStart),
    });
    const items = snapshot.query
      .completions(prefix)
      .filter((candidate) => candidate !== symbol.owner)
      .map((candidate) => {
        const type = snapshot.query.token(candidate)?.type;
        const item: CompletionItem = {
          label: String(candidate),
          kind: CompletionItemKind.Reference,
          sortText: String(candidate),
          filterText: String(candidate),
          textEdit: { range, newText: String(candidate) },
        };
        if (type) item.detail = type;
        return item;
      });
    if (!workspace.canQuery(snapshot, workspace.publishedRevision)) return null;
    return { isIncomplete: false, items };
  }

  async hover(params: HoverParams): Promise<Hover | null> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current) return null;
    const { workspace, snapshot, document } = current;
    const offset = positionToOffset(document.content, params.position);
    const symbol = symbolAtCursor(snapshot, document.source, offset);
    const tokenAtCursor = symbol ? undefined : snapshot.query.tokenAt(document.source, offset);
    const target = symbol?.target ?? tokenAtCursor?.id;
    if (!target) return null;
    const token = snapshot.query.token(target);
    const context = workspace.activeContext;
    const resolved =
      snapshot.status === "valid" ? snapshot.query.resolve(target, context) : undefined;
    const provenance =
      snapshot.status === "valid" ? snapshot.query.explain(target, context) : undefined;
    const effectiveContext = resolved?.context ?? workspace.effectiveContext(snapshot);
    const data = {
      schemaVersion: "1",
      token: String(target),
      ...(symbol ? { role: symbol.role } : {}),
      ...(token ? { type: token.type } : {}),
      ...((resolved?.expression ?? token?.value)
        ? { expression: resolved?.expression ?? token?.value }
        : {}),
      ...(resolved ? { resolvedValue: resolved.value } : {}),
      context: effectiveContext,
      ...(provenance ? { provenance } : {}),
      diagnostics: snapshot.diagnostics
        .filter((diagnostic) => diagnosticMatches(diagnostic, target, token))
        .map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
          fingerprint: diagnostic.fingerprint,
        })),
    };
    if (!workspace.canQuery(snapshot, workspace.publishedRevision)) return null;
    const source = symbol?.source ?? tokenAtCursor?.source;
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**\`${String(target)}\`**\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
      },
      ...(source ? { range: offsetRangeToLspRange(document.content, source) } : {}),
    };
  }

  async #currentDocument(uri: string): Promise<CurrentInsightDocument | undefined> {
    const workspace = this.#workspaces.workspaceForDocument(uri);
    if (!workspace) return undefined;
    await workspace.idle();
    const snapshot = workspace.snapshot;
    const revision = workspace.publishedRevision;
    if (!snapshot || !workspace.root || !workspace.canQuery(snapshot, revision)) return undefined;
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity) return undefined;
    const document = snapshot.documents.find(
      (candidate) => documentPath(candidate, workspace.root!) === identity,
    );
    return document ? { workspace, snapshot, document } : undefined;
  }
}
