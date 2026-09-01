import { BackendContractError, type BackendPlan, type TokenBackend } from "./backend.js";
import { createDiagnostic, documentContentDigest } from "./diagnostic.js";
import { encodeJsonPointerToken, parseJsonPointer } from "./dtcg/json-pointer.js";
import type { Diagnostic, TextEdit, TokenId } from "./model.js";
import { recompileSnapshot } from "./snapshot-editor.js";
import type { CompilationSnapshot, ValidCompilationSnapshot } from "./snapshot.js";
import type { EditorSymbolV1 } from "./source-index.js";
import { parentTokenId, parseTokenId, tokenIdSegments } from "./token-id.js";

export interface BackendRenamePreviewV1 {
  readonly backendId: string;
  readonly beforeSymbols: readonly string[];
  readonly afterSymbols: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface RenamePlanV1 {
  readonly schemaVersion: "1";
  readonly status: "ready" | "rejected" | "unavailable";
  readonly token: TokenId;
  readonly replacement: string;
  readonly edits: readonly TextEdit[];
  readonly diagnostics: readonly Diagnostic[];
  readonly backendPreviews: readonly BackendRenamePreviewV1[];
}

export interface RenamePlanOptions {
  readonly backends?: readonly TokenBackend[];
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function result(
  status: RenamePlanV1["status"],
  token: TokenId,
  replacement: string,
  diagnostics: readonly Diagnostic[] = [],
  edits: readonly TextEdit[] = [],
  backendPreviews: readonly BackendRenamePreviewV1[] = [],
): RenamePlanV1 {
  return deepFreeze({
    schemaVersion: "1",
    status,
    token,
    replacement,
    edits: status === "ready" ? [...edits] : [],
    diagnostics: [...diagnostics],
    backendPreviews: [...backendPreviews],
  });
}

function invalidName(token: TokenId, replacement: string, message: string): RenamePlanV1 {
  return result("rejected", token, replacement, [
    createDiagnostic({ code: "DTCG_INVALID_TOKEN_NAME", message }),
  ]);
}

function collision(
  token: TokenId,
  replacement: TokenId,
  conflicting: TokenId,
  kind: string,
): RenamePlanV1 {
  return result("rejected", token, replacement, [
    createDiagnostic({
      code: "TOKEN_DUPLICATE_ID",
      message: `Rename to \`${replacement}\` has a ${kind} collision with \`${conflicting}\``,
      parameters: { token: replacement },
    }),
  ]);
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function decodedSource(document: string, symbol: EditorSymbolV1): string | undefined {
  const raw = document.slice(symbol.source.offset, symbol.source.offset + symbol.source.length);
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function referenceReplacement(
  document: string,
  symbol: EditorSymbolV1,
  replacement: TokenId,
): string | undefined {
  const decoded = decodedSource(document, symbol);
  if (decoded === undefined) return undefined;
  if (symbol.role === "alias" || (symbol.role === "inheritance" && decoded.startsWith("{")))
    return /^\{[^{}]+\}$/u.test(decoded) ? jsonStringContent(`{${replacement}}`) : undefined;
  if (symbol.role !== "json-pointer" && symbol.role !== "inheritance") return undefined;
  const parsed = parseJsonPointer(decoded);
  if (!parsed.ok || parsed.reference.documentUri) return undefined;
  const targetSegments = tokenIdSegments(symbol.target);
  const pointerTokens = parsed.reference.pointer.tokens;
  if (!targetSegments.every((segment, index) => pointerTokens[index] === segment)) return undefined;
  const suffix = pointerTokens.slice(targetSegments.length);
  const encoded = [...tokenIdSegments(replacement), ...suffix]
    .map(encodeJsonPointerToken)
    .join("/");
  const prefix = decoded.includes("#") ? "#" : "";
  return jsonStringContent(`${prefix}/${encoded}`);
}

function compareEdits(left: TextEdit, right: TextEdit): number {
  return (
    left.document.localeCompare(right.document) ||
    left.range.offset - right.range.offset ||
    left.range.length - right.range.length
  );
}

function applyEdits(
  snapshot: ValidCompilationSnapshot,
  edits: readonly TextEdit[],
): readonly { readonly file: string; readonly content: string }[] | undefined {
  const byDocument = new Map<string, TextEdit[]>();
  for (const edit of edits) {
    const group = byDocument.get(edit.document) ?? [];
    group.push(edit);
    byDocument.set(edit.document, group);
  }
  const sources: { file: string; content: string }[] = [];
  for (const document of snapshot.documents) {
    let content = document.content;
    const expectedDigest = documentContentDigest(content);
    const documentEdits = (byDocument.get(document.source) ?? []).toSorted(
      (left, right) => right.range.offset - left.range.offset,
    );
    if (documentEdits.some((edit) => edit.expectedDocumentDigest !== expectedDigest))
      return undefined;
    for (const edit of documentEdits)
      content =
        content.slice(0, edit.range.offset) +
        edit.newText +
        content.slice(edit.range.offset + edit.range.length);
    sources.push({ file: document.source, content });
    byDocument.delete(document.source);
  }
  return byDocument.size === 0 ? sources : undefined;
}

function normalizeToken(id: TokenId, token: TokenId, replacement: TokenId): TokenId {
  return id === token ? replacement : id;
}

function semanticProjection(
  snapshot: ValidCompilationSnapshot,
  token: TokenId,
  replacement: TokenId,
): unknown {
  const tokens = snapshot.query
    .completions()
    .map((id) => normalizeToken(id, token, replacement))
    .toSorted((left, right) => String(left).localeCompare(String(right)));
  const values = snapshot.ir.availableContexts
    .flatMap((context) =>
      snapshot.query.completions().map((id) => {
        const resolved = snapshot.query.resolve(id, context);
        return resolved
          ? {
              token: normalizeToken(id, token, replacement),
              context,
              type: resolved.type,
              value: resolved.value,
              dependencies: resolved.dependencies
                .map((entry) => normalizeToken(entry, token, replacement))
                .toSorted((left, right) => String(left).localeCompare(String(right))),
            }
          : { token: normalizeToken(id, token, replacement), context, missing: true };
      }),
    )
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const edges = snapshot.query
    .graph()
    .map((edge) => ({
      from: normalizeToken(edge.from, token, replacement),
      to: normalizeToken(edge.to, token, replacement),
      kind: edge.kind,
      fieldPath: edge.fieldPath,
      condition: edge.condition.key,
    }))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { tokens, values, edges };
}

function backendSymbols(plan: BackendPlan | undefined): readonly string[] {
  return Object.freeze(
    (plan?.symbols ?? [])
      .map((symbol) => `${symbol.token}=${symbol.namespace}:${symbol.name}`)
      .toSorted(),
  );
}

async function previewBackends(
  before: ValidCompilationSnapshot,
  after: ValidCompilationSnapshot,
  backends: readonly TokenBackend[],
): Promise<{
  readonly previews: readonly BackendRenamePreviewV1[];
  readonly diagnostics: readonly Diagnostic[];
}> {
  if (backends.length === 0) return { previews: [], diagnostics: [] };
  const [beforeResult, afterResult] = await Promise.all([
    before.prepare(backends),
    after.prepare(backends),
  ]);
  const previews = backends.map((backend) => {
    const beforePlan = beforeResult.plans.find((plan) => plan.backendId === backend.id);
    const afterPlan = afterResult.plans.find((plan) => plan.backendId === backend.id);
    const diagnostics = afterResult.diagnostics.filter(
      (diagnostic) => diagnostic.parameters.backend === backend.id,
    );
    return {
      backendId: backend.id,
      beforeSymbols: backendSymbols(beforePlan),
      afterSymbols: backendSymbols(afterPlan),
      diagnostics,
    };
  });
  return {
    previews,
    diagnostics: [...beforeResult.diagnostics, ...afterResult.diagnostics],
  };
}

/** Plan an atomic, in-memory verified rename without writing source or Backend artifacts. */
export async function planTokenRename(
  snapshot: CompilationSnapshot,
  token: TokenId,
  proposedReplacement: string,
  options: RenamePlanOptions = {},
): Promise<RenamePlanV1> {
  let replacement: TokenId;
  try {
    replacement = parseTokenId(proposedReplacement);
  } catch {
    return invalidName(token, proposedReplacement, `Invalid token ID: ${proposedReplacement}`);
  }
  if (snapshot.status !== "valid")
    return result("unavailable", token, replacement, snapshot.diagnostics);
  const declaration = snapshot.sourceIndex
    .declarations()
    .filter((symbol) => symbol.target === token);
  if (!snapshot.query.token(token) || declaration.length === 0)
    return result("unavailable", token, replacement, [
      createDiagnostic({
        code: "TOKEN_UNKNOWN_REFERENCE",
        message: `Cannot rename missing token \`${token}\``,
        parameters: { target: token },
      }),
    ]);
  if (declaration.length !== 1)
    return collision(token, replacement, token, "duplicate declaration");
  if (replacement === token)
    return invalidName(token, replacement, "Rename must change the token ID");
  if (parentTokenId(replacement) !== parentTokenId(token))
    return invalidName(token, replacement, "Rename cannot move a token between groups");
  const replacementLeaf = tokenIdSegments(replacement).at(-1)!;
  if (replacementLeaf === "$root")
    return invalidName(token, replacement, "`$root` is reserved and cannot be a rename target");

  const existingIds = snapshot.query.completions().filter((id) => id !== token);
  const exact = existingIds.find((id) => id === replacement);
  if (exact) return collision(token, replacement, exact, "canonical");
  const normalized = replacement.normalize("NFC");
  const unicode = existingIds.find((id) => String(id).normalize("NFC") === normalized);
  if (unicode) return collision(token, replacement, unicode, "Unicode-normalized");
  const folded = normalized.toLocaleLowerCase("en-US");
  const caseFolded = existingIds.find(
    (id) => String(id).normalize("NFC").toLocaleLowerCase("en-US") === folded,
  );
  if (caseFolded) return collision(token, replacement, caseFolded, "case-folded");

  const documents = new Map(snapshot.documents.map((document) => [document.source, document]));
  const symbols = [...declaration, ...snapshot.sourceIndex.occurrences(token)];
  const edits: TextEdit[] = [];
  for (const symbol of symbols) {
    const document = documents.get(symbol.source.file);
    if (!document)
      return invalidName(
        token,
        replacement,
        `Source document is unavailable: ${symbol.source.file}`,
      );
    const newText =
      symbol.role === "declaration"
        ? JSON.stringify(replacementLeaf)
        : referenceReplacement(document.content, symbol, replacement);
    if (newText === undefined)
      return invalidName(
        token,
        replacement,
        `Unsupported ${symbol.role} occurrence at ${symbol.source.file}:${symbol.source.offset}`,
      );
    edits.push({
      document: document.source,
      range: {
        line: symbol.source.line,
        column: symbol.source.column,
        offset: symbol.source.offset,
        length: symbol.source.length,
      },
      newText,
      expectedDocumentDigest: documentContentDigest(document.content),
    });
  }
  edits.sort(compareEdits);
  for (let index = 1; index < edits.length; index += 1) {
    const previous = edits[index - 1]!;
    const current = edits[index]!;
    if (
      previous.document === current.document &&
      previous.range.offset + previous.range.length > current.range.offset
    )
      return invalidName(token, replacement, "Rename occurrences overlap");
  }
  const sources = applyEdits(snapshot, edits);
  const pending = sources ? recompileSnapshot(snapshot, sources) : undefined;
  if (!pending) return invalidName(token, replacement, "Snapshot cannot be virtually recompiled");
  const preview = await pending;
  if (preview.status !== "valid")
    return result("rejected", token, replacement, preview.diagnostics);
  if (
    JSON.stringify(semanticProjection(snapshot, token, replacement)) !==
    JSON.stringify(semanticProjection(preview, replacement, replacement))
  )
    return invalidName(token, replacement, "Virtual rename changed values or dependency topology");

  let backend: Awaited<ReturnType<typeof previewBackends>>;
  try {
    backend = await previewBackends(snapshot, preview, options.backends ?? []);
  } catch (error) {
    const backendId = error instanceof BackendContractError ? error.backendId : "rename-preflight";
    return result("rejected", token, replacement, [
      createDiagnostic({
        code: "BACKEND_NAMING_FAILED",
        message: `Backend rename preflight failed: ${error instanceof Error ? error.message : String(error)}`,
        parameters: { backend: backendId, token },
      }),
    ]);
  }
  if (backend.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return result("rejected", token, replacement, backend.diagnostics, [], backend.previews);
  return result("ready", token, replacement, [], edits, backend.previews);
}
