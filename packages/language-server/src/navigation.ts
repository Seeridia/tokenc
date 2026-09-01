import { isAbsolute, resolve } from "node:path";

import {
  parentTokenId,
  tokenIdSegments,
  type CompilationSnapshot,
  type EditorSymbolV1,
  type SnapshotDocument,
  type SourceLocation,
} from "@tokenc/core";
import {
  SymbolKind,
  type DefinitionParams,
  type DocumentSymbol,
  type DocumentSymbolParams,
  type Location,
  type Position,
  type ReferenceParams,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from "vscode-languageserver/node.js";

import { offsetRangeToLspRange } from "./diagnostics.js";
import { documentIdentityToFileUri, fileUriToDocumentIdentity } from "./uri.js";
import { type WorkspaceCoordinator, type WorkspaceManager } from "./workspace.js";

interface NavigationDocument {
  readonly source: string;
  readonly identity: string;
  readonly path: string;
  readonly uri: string;
  readonly content: string;
}

interface CurrentDocumentQuery {
  readonly workspace: WorkspaceCoordinator;
  readonly snapshot: CompilationSnapshot;
  readonly document: NavigationDocument;
}

function navigationDocuments(
  documents: readonly SnapshotDocument[],
  workspaceRoot: string,
): readonly NavigationDocument[] {
  return documents.map((document) => {
    const path = isAbsolute(document.source)
      ? resolve(document.source)
      : resolve(workspaceRoot, document.source);
    return {
      source: document.source,
      identity: document.identity,
      path,
      uri: documentIdentityToFileUri(path),
      content: document.content,
    };
  });
}

function documentForSource(
  source: string,
  documents: readonly NavigationDocument[],
): NavigationDocument | undefined {
  const exact = documents.find(
    (document) => document.source === source || document.identity === source,
  );
  if (exact) return exact;
  if (!isAbsolute(source)) return undefined;
  const normalized = resolve(source);
  return documents.find(
    (document) =>
      document.path === normalized ||
      (isAbsolute(document.identity) && resolve(document.identity) === normalized),
  );
}

/** Convert an LSP UTF-16 position to a bounded JavaScript string offset. */
export function positionToOffset(content: string, position: Position): number {
  const requestedLine = Math.max(0, position.line);
  let line = 0;
  let lineStart = 0;
  while (line < requestedLine) {
    const newline = content.indexOf("\n", lineStart);
    if (newline < 0) return content.length;
    lineStart = newline + 1;
    line += 1;
  }
  const newline = content.indexOf("\n", lineStart);
  let lineEnd = newline < 0 ? content.length : newline;
  if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
  return Math.min(lineEnd, lineStart + Math.max(0, position.character));
}

function locationFor(
  source: SourceLocation,
  documents: readonly NavigationDocument[],
): Location | undefined {
  const document = documentForSource(source.file, documents);
  if (!document) return undefined;
  return {
    uri: document.uri,
    range: offsetRangeToLspRange(document.content, source),
  };
}

function compareSymbols(left: EditorSymbolV1, right: EditorSymbolV1): number {
  return (
    left.source.file.localeCompare(right.source.file) ||
    left.source.offset - right.source.offset ||
    left.source.length - right.source.length ||
    left.role.localeCompare(right.role) ||
    String(left.target).localeCompare(String(right.target))
  );
}

function symbolKind(snapshot: CompilationSnapshot, symbol: EditorSymbolV1): SymbolKind {
  return snapshot.query.token(symbol.target) ? SymbolKind.Constant : SymbolKind.Namespace;
}

/** Current-snapshot projections for standard LSP navigation and symbol requests. */
export class NavigationProvider {
  readonly #workspaces: WorkspaceManager;

  constructor(workspaces: WorkspaceManager) {
    this.#workspaces = workspaces;
  }

  async definition(params: DefinitionParams): Promise<Location | null> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current) return null;
    const { snapshot, document, workspace } = current;
    const offset = positionToOffset(document.content, params.position);
    const symbol = snapshot.query.symbolAt(document.source, offset);
    const token = symbol ? undefined : snapshot.query.tokenAt(document.source, offset);
    const target = symbol?.target ?? token?.id;
    if (!target) return null;
    const definition = snapshot.query.definition(target);
    if (!definition || !workspace.canQuery(snapshot, workspace.publishedRevision)) return null;
    const documents = navigationDocuments(snapshot.documents, workspace.root!);
    return locationFor(definition, documents) ?? null;
  }

  async references(params: ReferenceParams): Promise<Location[]> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current) return [];
    const { snapshot, document, workspace } = current;
    const offset = positionToOffset(document.content, params.position);
    const symbol = snapshot.query.symbolAt(document.source, offset);
    const token = symbol ? undefined : snapshot.query.tokenAt(document.source, offset);
    const target = symbol?.target ?? token?.id;
    if (!target) return [];
    const facts = [
      ...(params.context.includeDeclaration
        ? snapshot.sourceIndex.declarations().filter((entry) => entry.target === target)
        : []),
      ...snapshot.query.occurrences(target),
    ].toSorted(compareSymbols);
    if (!workspace.canQuery(snapshot, workspace.publishedRevision)) return [];
    const documents = navigationDocuments(snapshot.documents, workspace.root!);
    return facts.flatMap((fact) => locationFor(fact.source, documents) ?? []);
  }

  async documentSymbols(params: DocumentSymbolParams): Promise<DocumentSymbol[]> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current) return [];
    const { snapshot, document, workspace } = current;
    const documents = navigationDocuments(snapshot.documents, workspace.root!);
    const entries = snapshot.query.documentSymbols(document.source).flatMap((fact) => {
      const location = locationFor(fact.source, documents);
      if (!location) return [];
      const id = String(fact.target);
      return [
        {
          id,
          parent: parentTokenId(fact.target),
          offset: fact.source.offset,
          symbol: {
            name: tokenIdSegments(fact.target).at(-1)!,
            detail: id,
            kind: symbolKind(snapshot, fact),
            range: location.range,
            selectionRange: location.range,
            children: [] as DocumentSymbol[],
          } satisfies DocumentSymbol,
        },
      ];
    });
    const byId = new Map<string, (typeof entries)[number][]>();
    for (const entry of entries) {
      const matches = byId.get(entry.id) ?? [];
      matches.push(entry);
      byId.set(entry.id, matches);
    }
    const roots: (typeof entries)[number][] = [];
    for (const entry of entries) {
      const parents = entry.parent ? byId.get(String(entry.parent)) : undefined;
      if (parents?.length === 1) parents[0]!.symbol.children.push(entry.symbol);
      else roots.push(entry);
    }
    if (!workspace.canQuery(snapshot, workspace.publishedRevision)) return [];
    return roots.toSorted((left, right) => left.offset - right.offset).map((entry) => entry.symbol);
  }

  async workspaceSymbols(params: WorkspaceSymbolParams): Promise<SymbolInformation[]> {
    await this.#workspaces.idle();
    const normalizedQuery = params.query.normalize("NFC").toLocaleLowerCase("en-US");
    const symbols: SymbolInformation[] = [];
    for (const workspace of this.#workspaces.all.toSorted((left, right) =>
      left.folder.uri.localeCompare(right.folder.uri),
    )) {
      const snapshot = workspace.snapshot;
      const revision = workspace.publishedRevision;
      if (!snapshot || !workspace.root || !workspace.canQuery(snapshot, revision)) continue;
      const documents = navigationDocuments(snapshot.documents, workspace.root);
      for (const fact of snapshot.sourceIndex.declarations()) {
        const name = String(fact.target);
        if (!name.normalize("NFC").toLocaleLowerCase("en-US").includes(normalizedQuery)) continue;
        const location = locationFor(fact.source, documents);
        if (!location) continue;
        const parent = parentTokenId(fact.target);
        symbols.push({
          name,
          kind: symbolKind(snapshot, fact),
          location,
          ...(parent ? { containerName: String(parent) } : {}),
        });
      }
    }
    return symbols.toSorted(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.location.uri.localeCompare(right.location.uri) ||
        left.location.range.start.line - right.location.range.start.line ||
        left.location.range.start.character - right.location.range.start.character,
    );
  }

  async #currentDocument(uri: string): Promise<CurrentDocumentQuery | undefined> {
    const workspace = this.#workspaces.workspaceForDocument(uri);
    if (!workspace) return undefined;
    await workspace.idle();
    const snapshot = workspace.snapshot;
    const revision = workspace.publishedRevision;
    if (!snapshot || !workspace.root || !workspace.canQuery(snapshot, revision)) return undefined;
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity) return undefined;
    const document = navigationDocuments(snapshot.documents, workspace.root).find(
      (candidate) => candidate.path === identity,
    );
    return document ? { workspace, snapshot, document } : undefined;
  }
}
