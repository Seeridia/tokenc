import { isAbsolute, resolve } from "node:path";

import type {
  CompilationSnapshot,
  Diagnostic,
  DiagnosticLocation,
  SnapshotDocument,
} from "@tokenc/core";
import {
  DiagnosticSeverity,
  type Diagnostic as ProtocolDiagnostic,
  type DiagnosticRelatedInformation,
  type Position,
  type PublishDiagnosticsParams,
  type Range,
} from "vscode-languageserver/node.js";

import { documentIdentityToFileUri } from "./uri.js";
import type { WorkspaceCoordinator } from "./workspace.js";

export interface LspDiagnosticDataV1 {
  readonly schemaVersion: "1";
  readonly fingerprint: string;
  readonly parameters: Diagnostic["parameters"];
  readonly fixes: readonly {
    readonly title: string;
    readonly applicability: "safe" | "requires-review";
  }[];
}

export interface DiagnosticSourceDocument {
  readonly source: string;
  readonly identity: string;
  readonly uri: string;
  readonly content: string;
}

export interface DiagnosticPublicationTarget {
  sendDiagnostics(params: PublishDiagnosticsParams): Promise<void>;
}

export interface DiagnosticPublisherOptions {
  readonly onError?: (error: unknown) => void;
}

/** Convert a JavaScript string offset to the UTF-16 position required by LSP 3.17. */
export function offsetToPosition(content: string, offset: number): Position {
  const bounded = Math.max(0, Math.min(offset, content.length));
  let line = 0;
  let lineStart = 0;
  for (let index = content.indexOf("\n"); index >= 0 && index < bounded;) {
    line += 1;
    lineStart = index + 1;
    index = content.indexOf("\n", lineStart);
  }
  return { line, character: bounded - lineStart };
}

export function offsetRangeToLspRange(content: string, range: DiagnosticLocation["range"]): Range {
  return {
    start: offsetToPosition(content, range.offset),
    end: offsetToPosition(content, range.offset + range.length),
  };
}

function protocolSeverity(severity: Diagnostic["severity"]): DiagnosticSeverity {
  if (severity === "error") return DiagnosticSeverity.Error;
  if (severity === "warning") return DiagnosticSeverity.Warning;
  return DiagnosticSeverity.Information;
}

function sourceFor(
  document: string,
  sources: readonly DiagnosticSourceDocument[],
): DiagnosticSourceDocument | undefined {
  const exact = sources.find(
    (candidate) => candidate.source === document || candidate.identity === document,
  );
  if (exact) return exact;
  if (!isAbsolute(document)) return undefined;
  const normalized = resolve(document);
  return sources.find(
    (candidate) =>
      resolve(candidate.source) === normalized ||
      (isAbsolute(candidate.identity) && resolve(candidate.identity) === normalized),
  );
}

function relatedInformation(
  diagnostic: Diagnostic,
  sources: readonly DiagnosticSourceDocument[],
): DiagnosticRelatedInformation[] | undefined {
  const related = diagnostic.related.flatMap((item) => {
    if (!item.source) return [];
    const document = sourceFor(item.source.document, sources);
    if (!document) return [];
    return [
      {
        location: {
          uri: document.uri,
          range: offsetRangeToLspRange(document.content, item.source.range),
        },
        message: item.message,
      },
    ];
  });
  return related.length > 0 ? related : undefined;
}

/** Project one Diagnostic v1 without changing its identity or classification. */
export function diagnosticToLsp(
  diagnostic: Diagnostic,
  sources: readonly DiagnosticSourceDocument[],
): ProtocolDiagnostic | undefined {
  if (!diagnostic.source) return undefined;
  const document = sourceFor(diagnostic.source.document, sources);
  if (!document) return undefined;
  const related = relatedInformation(diagnostic, sources);
  const data: LspDiagnosticDataV1 = Object.freeze({
    schemaVersion: "1",
    fingerprint: diagnostic.fingerprint,
    parameters: diagnostic.parameters,
    fixes: Object.freeze(
      diagnostic.fixes.map((fix) => ({
        title: fix.title,
        applicability: fix.applicability,
      })),
    ),
  });
  return {
    range: offsetRangeToLspRange(document.content, diagnostic.source.range),
    severity: protocolSeverity(diagnostic.severity),
    code: diagnostic.code,
    codeDescription: { href: diagnostic.documentationUrl },
    source: "tokenc",
    message: diagnostic.message,
    ...(related ? { relatedInformation: related } : {}),
    data,
  };
}

function sourceDocuments(
  documents: readonly SnapshotDocument[],
  workspaceRoot: string,
): readonly DiagnosticSourceDocument[] {
  return documents.map((document) => {
    const path = isAbsolute(document.source)
      ? document.source
      : resolve(workspaceRoot, document.source);
    return {
      source: document.source,
      identity: document.identity,
      uri: documentIdentityToFileUri(path),
      content: document.content,
    };
  });
}

/** Ordered, revision-gated push diagnostics for all active workspace documents. */
export class DiagnosticPublisher {
  readonly #target: DiagnosticPublicationTarget;
  readonly #onError: (error: unknown) => void;
  readonly #publishedUris = new Map<WorkspaceCoordinator, ReadonlySet<string>>();
  #tail: Promise<void> = Promise.resolve();

  constructor(target: DiagnosticPublicationTarget, options: DiagnosticPublisherOptions = {}) {
    this.#target = target;
    this.#onError = options.onError ?? (() => undefined);
  }

  publish(
    snapshot: CompilationSnapshot,
    workspace: WorkspaceCoordinator,
    workspaceRevision: number,
  ): void {
    const root = workspace.root;
    if (!root) return;
    const sources = sourceDocuments(snapshot.documents, root);
    const byUri = new Map<string, ProtocolDiagnostic[]>(
      sources.map((document) => [document.uri, []]),
    );
    for (const diagnostic of snapshot.diagnostics) {
      const source = diagnostic.source ? sourceFor(diagnostic.source.document, sources) : undefined;
      const mapped = diagnosticToLsp(diagnostic, sources);
      if (source && mapped) byUri.get(source.uri)?.push(mapped);
    }
    const versions = new Map([...byUri.keys()].map((uri) => [uri, workspace.documentVersion(uri)]));
    this.#enqueue(async () => {
      if (!workspace.canPublish(snapshot, workspaceRevision)) return;
      const previous = this.#publishedUris.get(workspace) ?? new Set<string>();
      const current = new Set(byUri.keys());
      const removed = [...previous].filter((uri) => !current.has(uri)).toSorted();
      const active = [...byUri.entries()].toSorted(([left], [right]) => left.localeCompare(right));
      await Promise.all(
        removed.map((uri) => {
          if (!workspace.canPublish(snapshot, workspaceRevision)) return Promise.resolve();
          return this.#target.sendDiagnostics({ uri, diagnostics: [] });
        }),
      );
      await Promise.all(
        active.map(([uri, diagnostics]) => {
          if (
            !workspace.canPublish(snapshot, workspaceRevision) ||
            workspace.documentVersion(uri) !== versions.get(uri)
          )
            return Promise.resolve();
          const version = versions.get(uri);
          return this.#target.sendDiagnostics({
            uri,
            diagnostics,
            ...(version === undefined ? {} : { version }),
          });
        }),
      );
      if (
        !workspace.canPublish(snapshot, workspaceRevision) ||
        active.some(([uri]) => workspace.documentVersion(uri) !== versions.get(uri))
      )
        return;
      this.#publishedUris.set(workspace, current);
    });
  }

  clear(workspace: WorkspaceCoordinator): void {
    const uris = this.#publishedUris.get(workspace);
    this.#publishedUris.delete(workspace);
    if (!uris) return;
    this.#enqueue(async () => {
      await Promise.all(
        [...uris].toSorted().map((uri) => this.#target.sendDiagnostics({ uri, diagnostics: [] })),
      );
    });
  }

  async idle(): Promise<void> {
    await this.#tail;
  }

  #enqueue(work: () => Promise<void>): void {
    this.#tail = this.#tail.then(work).catch((error: unknown) => {
      this.#onError(error);
    });
  }
}
