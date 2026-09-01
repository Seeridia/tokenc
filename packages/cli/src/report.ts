import { basename, isAbsolute, relative, sep } from "node:path";

import {
  diagnosticCodeRegistry,
  VERSION,
  type Diagnostic,
  type DiagnosticFixV1,
  type DiagnosticLocation,
  type PolicyEvaluationV1,
  type SnapshotDiffV1,
  type SidedDiagnosticV1,
  type TokenChangeV1,
  type TokenStateV1,
} from "@tokenc/core";

export type ReportVerdictV1 = "pass" | "fail" | "incomplete";
export type ReportFormat = "text" | "json" | "sarif";

export interface ReportDiagnosticEntryV1 {
  readonly origin: "compiler" | "comparison" | "policy";
  readonly side?: SidedDiagnosticV1["side"];
  readonly allowed: boolean;
  readonly findingId?: string;
  readonly ruleId?: string;
  readonly changeId?: string;
  readonly allowReason?: string;
  readonly diagnostic: Diagnostic;
}

export interface CheckReportDataV1 {
  readonly kind: "check";
  readonly tokens: number;
  readonly references: number;
}

export interface DiffReportDataV1 {
  readonly kind: "diff";
  readonly comparison: SnapshotDiffV1;
  readonly policy?: PolicyEvaluationV1["policy"];
}

export interface ReportV1 {
  readonly schemaVersion: "1";
  readonly command: "check" | "diff";
  readonly verdict: ReportVerdictV1;
  readonly data: CheckReportDataV1 | DiffReportDataV1;
  readonly diagnostics: readonly ReportDiagnosticEntryV1[];
}

export interface CheckReportInput {
  readonly root: string;
  readonly tokens: number;
  readonly references: number;
  readonly success: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

/** Normalize a source identity to the explicit report root without leaking an external temp path. */
export function reportDocumentPath(document: string, root: string): string {
  if (!isAbsolute(document)) {
    const normalized = posixPath(document).replace(/^\.\//u, "");
    return normalized === ".." || normalized.startsWith("../")
      ? `_external/${basename(normalized)}`
      : normalized;
  }
  const local = posixPath(relative(root, document));
  return local !== ".." && !local.startsWith("../")
    ? local || basename(document)
    : `_external/${basename(document)}`;
}

function normalizeLocation(source: DiagnosticLocation, root: string): DiagnosticLocation {
  return Object.freeze({ ...source, document: reportDocumentPath(source.document, root) });
}

function normalizeFix(fix: DiagnosticFixV1, root: string): DiagnosticFixV1 {
  return Object.freeze({
    ...fix,
    edits: Object.freeze(
      fix.edits.map((edit) =>
        Object.freeze({ ...edit, document: reportDocumentPath(edit.document, root) }),
      ),
    ),
  });
}

function normalizeDiagnostic(diagnostic: Diagnostic, root: string): Diagnostic {
  return deepFreeze({
    ...diagnostic,
    ...(diagnostic.source ? { source: normalizeLocation(diagnostic.source, root) } : {}),
    related: diagnostic.related.map((entry) =>
      Object.freeze({
        ...entry,
        ...(entry.source ? { source: normalizeLocation(entry.source, root) } : {}),
      }),
    ),
    fixes: diagnostic.fixes.map((fix) => normalizeFix(fix, root)),
  });
}

function normalizeTokenState(state: TokenStateV1, root: string): TokenStateV1 {
  return deepFreeze({ ...state, source: normalizeLocation(state.source, root) });
}

function normalizeChange(change: TokenChangeV1, root: string): TokenChangeV1 {
  return deepFreeze({
    changeId: change.changeId,
    kind: change.kind,
    token: change.token,
    condition: change.condition,
    sides: change.sides,
    ...(change.before ? { before: normalizeTokenState(change.before, root) } : {}),
    ...(change.after ? { after: normalizeTokenState(change.after, root) } : {}),
  });
}

function normalizeDiff(diff: SnapshotDiffV1, root: string): SnapshotDiffV1 {
  return deepFreeze({
    ...diff,
    changes: diff.changes.map((change) => normalizeChange(change, root)),
    diagnostics: diff.diagnostics.map((entry) =>
      deepFreeze({ ...entry, diagnostic: normalizeDiagnostic(entry.diagnostic, root) }),
    ),
  });
}

function reportEntry(
  diagnostic: Diagnostic,
  root: string,
  fields: Omit<ReportDiagnosticEntryV1, "diagnostic" | "allowed"> &
    Partial<Pick<ReportDiagnosticEntryV1, "allowed">>,
): ReportDiagnosticEntryV1 {
  return deepFreeze({
    ...fields,
    allowed: fields.allowed ?? false,
    diagnostic: normalizeDiagnostic(diagnostic, root),
  });
}

/** Build the single immutable model consumed by every check renderer. */
export function createCheckReport(input: CheckReportInput): ReportV1 {
  return deepFreeze({
    schemaVersion: "1",
    command: "check",
    verdict: input.success ? "pass" : "fail",
    data: {
      kind: "check",
      tokens: input.tokens,
      references: input.references,
    },
    diagnostics: input.diagnostics.map((diagnostic) =>
      reportEntry(diagnostic, input.root, { origin: "compiler" }),
    ),
  });
}

/** Build the single immutable model consumed by every diff renderer. */
export function createDiffReport(
  diff: SnapshotDiffV1,
  root: string,
  evaluation?: PolicyEvaluationV1,
): ReportV1 {
  if (evaluation && evaluation.diff !== diff)
    throw new TypeError("Policy evaluation must refer to the supplied Snapshot Diff v1 value");
  const comparison = normalizeDiff(diff, root);
  const diagnostics: ReportDiagnosticEntryV1[] = diff.diagnostics.map((item) =>
    reportEntry(item.diagnostic, root, { origin: "comparison", side: item.side }),
  );
  if (evaluation) {
    diagnostics.push(
      ...evaluation.findings.map((finding) =>
        reportEntry(finding.diagnostic, root, {
          origin: "policy",
          allowed: finding.allowed,
          findingId: finding.findingId,
          ruleId: finding.ruleId,
          changeId: finding.changeId,
          ...(finding.allowReason ? { allowReason: finding.allowReason } : {}),
        }),
      ),
      ...evaluation.diagnostics.map((diagnostic) =>
        reportEntry(diagnostic, root, { origin: "policy" }),
      ),
    );
  }
  return deepFreeze({
    schemaVersion: "1",
    command: "diff",
    verdict: evaluation?.verdict ?? (diff.status === "complete" ? "pass" : "incomplete"),
    data: {
      kind: "diff",
      comparison,
      ...(evaluation ? { policy: evaluation.policy } : {}),
    },
    diagnostics,
  });
}

function reportDiagnosticText(entryValue: ReportDiagnosticEntryV1): string {
  const diagnostic = entryValue.diagnostic;
  const location = diagnostic.source
    ? `${diagnostic.source.document}:${diagnostic.source.range.line}:${diagnostic.source.range.column} `
    : "";
  const allowed = entryValue.allowed ? ` allowed: ${entryValue.allowReason ?? "approved"}` : "";
  return `${location}[${diagnostic.severity}] ${diagnostic.code} ${diagnostic.fingerprint}${allowed}\n  ${diagnostic.message}`;
}

function impactText(
  label: string,
  entries: SnapshotDiffV1["impact"]["changed"],
): readonly string[] {
  return [
    `${label}: ${entries.length}`,
    ...entries.map((item) => `  ${item.token} [${item.condition.key}] (${item.sides.join("+")})`),
  ];
}

/** Render Report v1 as deterministic terminal text. */
export function renderReportText(report: ReportV1): string {
  const lines = [`tokenc ${report.command} report v1`, `Verdict: ${report.verdict}`];
  if (report.data.kind === "check") {
    lines.push(`Tokens: ${report.data.tokens}`, `References: ${report.data.references}`);
  } else {
    const diff = report.data.comparison;
    lines.push(
      `Base: ${diff.base.label}`,
      `Head: ${diff.head.label}`,
      `Changes: ${diff.changes.length}`,
      ...diff.changes.map(
        (change) =>
          `  ${change.changeId} ${change.token}: ${change.kind} [${change.condition.key}]`,
      ),
      ...impactText("Directly changed", diff.impact.changed),
      ...impactText("Directly affected", diff.impact.directlyAffected),
      ...impactText("Transitively affected", diff.impact.indirectlyAffected),
    );
  }
  lines.push(
    `Diagnostics: ${report.diagnostics.length}`,
    ...report.diagnostics.map(reportDiagnosticText),
  );
  return `${lines.join("\n")}\n`;
}

/** Render Report v1 as deterministic JSON. */
export function serializeReportJson(report: ReportV1): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

interface SarifRegion {
  readonly startLine: number;
  readonly startColumn: number;
  readonly charOffset: number;
  readonly charLength: number;
}

function sarifUri(document: string): string {
  return document.split("/").map(encodeURIComponent).join("/");
}

function sarifRegion(source: DiagnosticLocation): SarifRegion {
  return {
    startLine: source.range.line,
    startColumn: source.range.column,
    charOffset: source.range.offset,
    charLength: source.range.length,
  };
}

function physicalLocation(source: DiagnosticLocation) {
  return {
    artifactLocation: { uri: sarifUri(source.document) },
    region: sarifRegion(source),
  };
}

function sarifFixes(diagnostic: Diagnostic) {
  return diagnostic.fixes.map((fix) => {
    const documents = new Map<string, typeof fix.edits>();
    for (const edit of fix.edits) {
      const existing = documents.get(edit.document) ?? [];
      documents.set(edit.document, [...existing, edit]);
    }
    return {
      description: { text: fix.title },
      artifactChanges: [...documents.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([document, edits]) => ({
          artifactLocation: { uri: sarifUri(document) },
          replacements: edits.map((edit) => ({
            deletedRegion: {
              startLine: edit.range.line,
              startColumn: edit.range.column,
              charOffset: edit.range.offset,
              charLength: edit.range.length,
            },
            insertedContent: { text: edit.newText },
          })),
        })),
      properties: { applicability: fix.applicability },
    };
  });
}

/** Render Report v1 as a deterministic SARIF 2.1.0 log. */
export function serializeReportSarif(report: ReportV1): string {
  const registrations = new Map(diagnosticCodeRegistry().map((item) => [item.code, item]));
  const codes = [...new Set(report.diagnostics.map((item) => item.diagnostic.code))].toSorted();
  const rules = codes.map((code) => {
    const diagnostic = report.diagnostics.find((item) => item.diagnostic.code === code)!.diagnostic;
    const registration = registrations.get(code);
    return {
      id: code,
      name: code,
      shortDescription: { text: code.replaceAll("_", " ").toLowerCase() },
      helpUri: diagnostic.documentationUrl,
      defaultConfiguration: {
        level:
          registration?.defaultSeverity === "error"
            ? "error"
            : registration?.defaultSeverity === "warning"
              ? "warning"
              : "note",
      },
      properties: { stage: registration?.stage ?? "unknown" },
    };
  });
  const results = report.diagnostics.map((item) => {
    const diagnostic = item.diagnostic;
    const relatedLocations = diagnostic.related.flatMap((related, index) =>
      related.source
        ? [
            {
              id: index + 1,
              message: { text: related.message },
              physicalLocation: physicalLocation(related.source),
            },
          ]
        : [],
    );
    return {
      ruleId: diagnostic.code,
      level:
        diagnostic.severity === "error"
          ? "error"
          : diagnostic.severity === "warning"
            ? "warning"
            : "note",
      message: { text: diagnostic.message },
      partialFingerprints: { "tokenc/v1": diagnostic.fingerprint },
      ...(diagnostic.source
        ? { locations: [{ physicalLocation: physicalLocation(diagnostic.source) }] }
        : {}),
      ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
      ...(diagnostic.fixes.length > 0 ? { fixes: sarifFixes(diagnostic) } : {}),
      ...(item.allowed
        ? {
            suppressions: [
              { kind: "external", justification: item.allowReason ?? "Allowed by policy" },
            ],
          }
        : {}),
      properties: {
        origin: item.origin,
        allowed: item.allowed,
        ...(item.side ? { side: item.side } : {}),
        ...(item.findingId ? { findingId: item.findingId } : {}),
        ...(item.ruleId ? { policyRuleId: item.ruleId } : {}),
        ...(item.changeId ? { changeId: item.changeId } : {}),
      },
    };
  });
  return `${JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: "tokenc",
              semanticVersion: VERSION,
              informationUri: "https://github.com/Seeridia/tokenc",
              rules,
            },
          },
          results,
          properties: {
            command: report.command,
            verdict: report.verdict,
            reportSchemaVersion: report.schemaVersion,
          },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function renderReport(report: ReportV1, format: ReportFormat): string {
  if (format === "json") return serializeReportJson(report);
  if (format === "sarif") return serializeReportSarif(report);
  return renderReportText(report);
}
