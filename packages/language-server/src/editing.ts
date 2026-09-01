import { isAbsolute, resolve } from "node:path";

import {
  diagnosticCodeRegistry,
  documentContentDigest,
  planTokenRename,
  type CompilationSnapshot,
  type Diagnostic,
  type EditorSymbolV1,
  type SnapshotDocument,
  type TextEdit as CoreTextEdit,
} from "@tokenc/core";
import {
  CodeActionKind,
  LSPErrorCodes,
  ResponseError,
  type CodeAction,
  type CodeActionParams,
  type Diagnostic as ProtocolDiagnostic,
  type PrepareRenameParams,
  type Range,
  type RenameParams,
  type WorkspaceEdit,
} from "vscode-languageserver/node.js";

import { offsetRangeToLspRange } from "./diagnostics.js";
import { positionToOffset } from "./navigation.js";
import { documentIdentityToFileUri, fileUriToDocumentIdentity } from "./uri.js";
import { type WorkspaceCoordinator, type WorkspaceManager } from "./workspace.js";

interface EditingDocument {
  readonly source: string;
  readonly identity: string;
  readonly path: string;
  readonly uri: string;
  readonly content: string;
}

interface CurrentEditingDocument {
  readonly workspace: WorkspaceCoordinator;
  readonly workspaceRevision: number;
  readonly snapshot: CompilationSnapshot;
  readonly documents: readonly EditingDocument[];
  readonly document: EditingDocument;
  readonly versions: ReadonlyMap<string, number | undefined>;
}

export interface LspRenameFailureDataV1 {
  readonly schemaVersion: "1";
  readonly status: "rejected" | "unavailable";
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

function editingDocuments(
  documents: readonly SnapshotDocument[],
  workspace: WorkspaceCoordinator,
): readonly EditingDocument[] {
  return documents.map((document) => {
    const path = isAbsolute(document.source)
      ? resolve(document.source)
      : resolve(workspace.root!, document.source);
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
  documents: readonly EditingDocument[],
): EditingDocument | undefined {
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

function samePosition(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): boolean {
  return left.line === right.line && left.character === right.character;
}

function sameRange(left: Range, right: Range): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function protocolFingerprint(diagnostic: ProtocolDiagnostic): string | undefined {
  const data = diagnostic.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return data.schemaVersion === "1" && typeof data.fingerprint === "string"
    ? data.fingerprint
    : undefined;
}

function quickFixRequested(only: readonly string[] | undefined): boolean {
  return (
    !only ||
    only.some(
      (kind) => kind === CodeActionKind.QuickFix || CodeActionKind.QuickFix.startsWith(`${kind}.`),
    )
  );
}

function workspaceEdit(
  current: CurrentEditingDocument,
  edits: readonly CoreTextEdit[],
): WorkspaceEdit | undefined {
  if (edits.length === 0) return undefined;
  const grouped = new Map<EditingDocument, CoreTextEdit[]>();
  for (const edit of edits) {
    const document = documentForSource(edit.document, current.documents);
    if (
      !document ||
      edit.range.offset + edit.range.length > document.content.length ||
      edit.expectedDocumentDigest !== documentContentDigest(document.content) ||
      current.workspace.documentVersion(document.uri) !== current.versions.get(document.uri)
    )
      return undefined;
    const entries = grouped.get(document) ?? [];
    entries.push(edit);
    grouped.set(document, entries);
  }
  for (const entries of grouped.values()) {
    entries.sort(
      (left, right) =>
        left.range.offset - right.range.offset || left.range.length - right.range.length,
    );
    if (
      entries.some((edit, index) => {
        const previous = entries[index - 1];
        return previous && previous.range.offset + previous.range.length > edit.range.offset;
      })
    )
      return undefined;
  }
  return {
    documentChanges: [...grouped]
      .toSorted(([left], [right]) => left.uri.localeCompare(right.uri))
      .map(([document, documentEdits]) => ({
        textDocument: {
          uri: document.uri,
          version: current.versions.get(document.uri) ?? null,
        },
        edits: documentEdits.map((edit) => ({
          range: offsetRangeToLspRange(document.content, edit.range),
          newText: edit.newText,
        })),
      })),
  };
}

function renameFailure(
  status: LspRenameFailureDataV1["status"],
  diagnostics: readonly Diagnostic[],
): ResponseError<LspRenameFailureDataV1> {
  const summary = diagnostics[0]?.message ?? `Rename is ${status}`;
  return new ResponseError(LSPErrorCodes.RequestFailed, summary, {
    schemaVersion: "1",
    status,
    diagnostics: diagnostics.map(({ code, message }) => ({ code, message })),
  });
}

/** Current-snapshot rename and Diagnostic fix projections with version and digest guards. */
export class EditingProvider {
  readonly #workspaces: WorkspaceManager;

  constructor(workspaces: WorkspaceManager) {
    this.#workspaces = workspaces;
  }

  async prepareRename(
    params: PrepareRenameParams,
  ): Promise<{ readonly range: Range; readonly placeholder: string } | null> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current || current.snapshot.status !== "valid") return null;
    const symbol = symbolAtCursor(
      current.snapshot,
      current.document.source,
      positionToOffset(current.document.content, params.position),
    );
    if (!symbol || !current.snapshot.query.token(symbol.target)) return null;
    const declarations = current.snapshot.sourceIndex
      .declarations()
      .filter((candidate) => candidate.target === symbol.target);
    if (
      declarations.length !== 1 ||
      !current.workspace.canQuery(current.snapshot, current.workspaceRevision)
    )
      return null;
    return {
      range: offsetRangeToLspRange(current.document.content, symbol.source),
      placeholder: String(symbol.target),
    };
  }

  async rename(params: RenameParams): Promise<WorkspaceEdit | null> {
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current || current.snapshot.status !== "valid") return null;
    const symbol = symbolAtCursor(
      current.snapshot,
      current.document.source,
      positionToOffset(current.document.content, params.position),
    );
    if (!symbol || !current.snapshot.query.token(symbol.target)) return null;
    const plan = await planTokenRename(current.snapshot, symbol.target, params.newName, {
      backends: current.workspace.session?.backends ?? [],
    });
    if (plan.status !== "ready") throw renameFailure(plan.status, plan.diagnostics);
    if (!current.workspace.canQuery(current.snapshot, current.workspaceRevision))
      throw new ResponseError(LSPErrorCodes.ContentModified, "Workspace changed during rename");
    const edit = workspaceEdit(current, plan.edits);
    if (!edit || !current.workspace.canQuery(current.snapshot, current.workspaceRevision))
      throw new ResponseError(
        LSPErrorCodes.ContentModified,
        "Rename sources changed during planning",
      );
    return edit;
  }

  async codeActions(params: CodeActionParams): Promise<CodeAction[]> {
    if (!quickFixRequested(params.context.only)) return [];
    const current = await this.#currentDocument(params.textDocument.uri);
    if (!current) return [];
    const allowedCodes = new Set(
      diagnosticCodeRegistry()
        .filter((registration) => registration.fixesAllowed)
        .map((registration) => registration.code),
    );
    const actions: CodeAction[] = [];
    for (const protocolDiagnostic of params.context.diagnostics) {
      if (protocolDiagnostic.source !== "tokenc") continue;
      const fingerprint = protocolFingerprint(protocolDiagnostic);
      if (!fingerprint) continue;
      const diagnostic = current.snapshot.diagnostics.find(
        (candidate) =>
          candidate.fingerprint === fingerprint &&
          candidate.code === protocolDiagnostic.code &&
          allowedCodes.has(candidate.code),
      );
      if (!diagnostic?.source) continue;
      const source = documentForSource(diagnostic.source.document, current.documents);
      if (
        !source ||
        source.uri !== params.textDocument.uri ||
        !sameRange(
          protocolDiagnostic.range,
          offsetRangeToLspRange(source.content, diagnostic.source.range),
        )
      )
        continue;
      for (const fix of diagnostic.fixes) {
        const edit = workspaceEdit(current, fix.edits);
        if (!edit) continue;
        actions.push({
          title: fix.title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [protocolDiagnostic],
          isPreferred: fix.applicability === "safe",
          edit,
        });
      }
    }
    if (!current.workspace.canQuery(current.snapshot, current.workspaceRevision)) return [];
    return actions;
  }

  async #currentDocument(uri: string): Promise<CurrentEditingDocument | undefined> {
    const workspace = this.#workspaces.workspaceForDocument(uri);
    if (!workspace) return undefined;
    await workspace.idle();
    const snapshot = workspace.snapshot;
    const workspaceRevision = workspace.publishedRevision;
    if (!snapshot || !workspace.root || !workspace.canQuery(snapshot, workspaceRevision))
      return undefined;
    const identity = fileUriToDocumentIdentity(uri);
    if (!identity) return undefined;
    const documents = editingDocuments(snapshot.documents, workspace);
    const document = documents.find((candidate) => candidate.path === identity);
    if (!document) return undefined;
    return {
      workspace,
      workspaceRevision,
      snapshot,
      documents,
      document,
      versions: new Map(
        documents.map((candidate) => [candidate.uri, workspace.documentVersion(candidate.uri)]),
      ),
    };
  }
}
