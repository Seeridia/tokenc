import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticFixV1,
  DiagnosticLocation,
  DiagnosticSeverity,
  JsonValue,
  RelatedDiagnosticV1,
  SemanticAnchor,
  SourceLocation,
  TextEdit,
} from "./model.js";

export type DiagnosticStage = "parser" | "linker" | "checker" | "backend" | "session" | "policy";

export interface DiagnosticCodeRegistration {
  readonly code: DiagnosticCode;
  readonly stage: DiagnosticStage;
  readonly defaultSeverity: DiagnosticSeverity;
  readonly parameters: Readonly<
    Record<string, { readonly identity: boolean; readonly required: boolean }>
  >;
  readonly documentationUrl: string;
  readonly fixesAllowed: boolean;
  readonly suppressible: boolean;
}

export interface DiagnosticInput {
  readonly code: DiagnosticCode;
  readonly severity?: DiagnosticSeverity;
  readonly message: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly source?: SourceLocation | DiagnosticLocation;
  readonly anchor?: SemanticAnchor;
  readonly related?: readonly {
    readonly message: string;
    readonly source?: SourceLocation | DiagnosticLocation;
    readonly anchor?: SemanticAnchor;
  }[];
  readonly fixes?: readonly DiagnosticFixV1[];
}

const CORE_CODES = [
  "BACKEND_CONTEXT_COVERAGE",
  "BACKEND_ARTIFACT_COLLISION",
  "BACKEND_ARTIFACT_INVALID_PATH",
  "BACKEND_INVALID_CONTEXT_SELECTOR",
  "BACKEND_NAMING_FAILED",
  "BACKEND_SYMBOL_COLLISION",
  "BACKEND_SYMBOL_INVALID",
  "BACKEND_SYMBOL_RESERVED",
  "BACKEND_UNSUPPORTED_COLOR_SPACE",
  "BACKEND_UNSUPPORTED_CONTEXT",
  "BACKEND_UNSUPPORTED_REFERENCE_STRATEGY",
  "BACKEND_UNSUPPORTED_TYPE",
  "BACKEND_UNSUPPORTED_VALUE",
  "DTCG_GROUP_EXTENDS_CYCLE",
  "DTCG_GROUP_EXTENDS_INVALID_TARGET",
  "DTCG_INVALID_COLOR",
  "DTCG_INVALID_COMPOSITE_VALUE",
  "DTCG_INVALID_CUBIC_BEZIER",
  "DTCG_INVALID_DEPRECATED",
  "DTCG_INVALID_DESCRIPTION",
  "DTCG_INVALID_EXTENSIONS",
  "DTCG_INVALID_GROUP_EXTENDS",
  "DTCG_INVALID_GROUP_MEMBER",
  "DTCG_INVALID_GROUP_PROPERTY",
  "DTCG_INVALID_JSON_POINTER",
  "DTCG_INVALID_RESOLUTION_ORDER",
  "DTCG_INVALID_RESOLUTION_SOURCE",
  "DTCG_INVALID_RESOLVER_DEFAULT",
  "DTCG_INVALID_RESOLVER_DOCUMENT",
  "DTCG_INVALID_RESOLVER_INPUT",
  "DTCG_INVALID_RESOLVER_MODIFIER",
  "DTCG_INVALID_RESOLVER_REFERENCE",
  "DTCG_INVALID_RESOLVER_REFERENCE_OVERRIDE",
  "DTCG_INVALID_RESOLVER_VERSION",
  "DTCG_INVALID_TOKEN_NAME",
  "DTCG_INVALID_TOKEN_PROPERTY",
  "DTCG_INVALID_TOKEN_STRUCTURE",
  "DTCG_JSON_POINTER_INVALID_ARRAY_INDEX",
  "DTCG_JSON_POINTER_INVALID_TARGET",
  "DTCG_JSON_POINTER_NOT_FOUND",
  "DTCG_RESOLVER_CIRCULAR_REFERENCE",
  "DTCG_RESOLVER_MISSING_INPUT",
  "DTCG_RESOLVER_SINGLE_CONTEXT",
  "DTCG_RESOLVER_SOURCE_NOT_FOUND",
  "DTCG_UNKNOWN_MODIFIER",
  "DTCG_UNKNOWN_SET",
  "DTCG_UNSUPPORTED_COLOR_SPACE",
  "DTCG_UNSUPPORTED_EXTERNAL_JSON_POINTER",
  "DTCG_UNSUPPORTED_RESOLVER_REFERENCE",
  "POLICY_BACKEND_ARTIFACT_PATH_REMOVAL",
  "POLICY_BACKEND_SYMBOL_REMOVAL",
  "POLICY_CONTEXT_COVERAGE_LOSS",
  "POLICY_DIRECT_VALUE_CHANGE",
  "POLICY_INCOMPLETE_COMPARISON",
  "POLICY_INVALID_CONFIG",
  "POLICY_PROPAGATED_VALUE_CHANGE",
  "POLICY_STALE_ALLOW",
  "POLICY_TOKEN_REMOVAL",
  "POLICY_TOKEN_TYPE_CHANGE",
  "POLICY_UNKNOWN_RULE",
  "RESOLVER_PERMUTATION_INVALID_FILTER",
  "RESOLVER_PERMUTATION_INVALID_LIMIT",
  "RESOLVER_PERMUTATION_LIMIT_EXCEEDED",
  "RESOLVER_PERMUTATION_LIMIT_REQUIRED",
  "RESOLVER_PERMUTATION_OUTPUT_COLLISION",
  "RESOLVER_PERMUTATION_UNKNOWN_FILTER",
  "SESSION_CONFLICTING_CHANGE",
  "TOKEN_CANNOT_INFER_TYPE",
  "TOKEN_CIRCULAR_REFERENCE",
  "TOKEN_CONTEXT_DOMAIN_MISMATCH",
  "TOKEN_CONTEXT_INVALID_DEFAULT",
  "TOKEN_CONTEXT_PREDICATE_LIMIT",
  "TOKEN_CONTEXT_UNKNOWN_DIMENSION",
  "TOKEN_CONTEXT_UNKNOWN_VALUE",
  "TOKEN_DUPLICATE_ID",
  "TOKEN_INVALID_CONTEXT_EXTENSION",
  "TOKEN_INVALID_CONTEXT_SELECTOR",
  "TOKEN_INVALID_JSON",
  "TOKEN_INVALID_REFERENCE",
  "TOKEN_INVALID_TYPE",
  "TOKEN_INVALID_VALUE",
  "TOKEN_MISSING_TYPE",
  "TOKEN_REFERENCE_TYPE_MISMATCH",
  "TOKEN_RESOLUTION_AMBIGUOUS",
  "TOKEN_UNKNOWN_REFERENCE",
] as const;

type CoreDiagnosticCode = (typeof CORE_CODES)[number];

const CORE_IDENTITY_PARAMETERS: Partial<Record<CoreDiagnosticCode, readonly string[]>> = {
  BACKEND_ARTIFACT_COLLISION: [
    "backend",
    "artifact",
    "path",
    "previousBackend",
    "previousArtifact",
    "previousPath",
  ],
  BACKEND_ARTIFACT_INVALID_PATH: ["backend", "artifact", "path"],
  BACKEND_NAMING_FAILED: ["backend", "token"],
  BACKEND_SYMBOL_COLLISION: ["backend", "namespace", "name", "firstToken", "secondToken"],
  BACKEND_SYMBOL_INVALID: ["backend", "namespace", "name", "token"],
  BACKEND_SYMBOL_RESERVED: ["backend", "namespace", "name", "token"],
  BACKEND_UNSUPPORTED_COLOR_SPACE: ["backend", "token", "colorSpace"],
  BACKEND_UNSUPPORTED_CONTEXT: ["backend"],
  BACKEND_UNSUPPORTED_REFERENCE_STRATEGY: ["backend", "token"],
  BACKEND_UNSUPPORTED_TYPE: ["backend", "token", "type"],
  POLICY_BACKEND_ARTIFACT_PATH_REMOVAL: ["ruleId", "changeId"],
  POLICY_BACKEND_SYMBOL_REMOVAL: ["ruleId", "changeId"],
  POLICY_CONTEXT_COVERAGE_LOSS: ["ruleId", "changeId"],
  POLICY_DIRECT_VALUE_CHANGE: ["ruleId", "changeId"],
  POLICY_INCOMPLETE_COMPARISON: ["base", "head"],
  POLICY_INVALID_CONFIG: ["path"],
  POLICY_PROPAGATED_VALUE_CHANGE: ["ruleId", "changeId"],
  POLICY_STALE_ALLOW: ["changeId"],
  POLICY_TOKEN_REMOVAL: ["ruleId", "changeId"],
  POLICY_TOKEN_TYPE_CHANGE: ["ruleId", "changeId"],
  POLICY_UNKNOWN_RULE: ["ruleId"],
  RESOLVER_PERMUTATION_INVALID_FILTER: ["dimension", "value"],
  RESOLVER_PERMUTATION_INVALID_LIMIT: ["limit"],
  RESOLVER_PERMUTATION_LIMIT_EXCEEDED: ["limit", "estimatedCount"],
  RESOLVER_PERMUTATION_LIMIT_REQUIRED: ["estimatedCount"],
  RESOLVER_PERMUTATION_OUTPUT_COLLISION: ["path", "firstContext", "secondContext"],
  RESOLVER_PERMUTATION_UNKNOWN_FILTER: ["dimension"],
  TOKEN_CIRCULAR_REFERENCE: ["cycle", "context"],
  TOKEN_DUPLICATE_ID: ["token"],
  TOKEN_REFERENCE_TYPE_MISMATCH: ["target", "expected", "actual"],
  TOKEN_UNKNOWN_REFERENCE: ["target"],
  SESSION_CONFLICTING_CHANGE: ["document"],
};

function stageFor(code: string): DiagnosticStage {
  if (code.startsWith("BACKEND_")) return "backend";
  if (code.startsWith("POLICY_")) return "policy";
  if (code.startsWith("SESSION_")) return "session";
  if (code.includes("REFERENCE") || code.includes("CONTEXT")) return "checker";
  if (code.startsWith("DTCG_GROUP_") || code.includes("RESOLVER")) return "linker";
  return "parser";
}

function documentationUrl(code: string): string {
  return `https://github.com/Seeridia/tokenc/blob/main/docs/DIAGNOSTICS-V1.md#${code.toLowerCase().replaceAll("_", "-")}`;
}

const registry = new Map<DiagnosticCode, DiagnosticCodeRegistration>(
  CORE_CODES.map((code) => [
    code,
    {
      code,
      stage: stageFor(code),
      defaultSeverity: "error",
      parameters: Object.fromEntries(
        (CORE_IDENTITY_PARAMETERS[code] ?? []).map((name) => [
          name,
          { identity: true, required: true },
        ]),
      ),
      documentationUrl: documentationUrl(code),
      fixesAllowed: code === "TOKEN_UNKNOWN_REFERENCE",
      suppressible: false,
    },
  ]),
);

/** Register a third-party diagnostic code before constructing diagnostics with it. */
export function registerDiagnosticCode(registration: DiagnosticCodeRegistration): void {
  if (/^(?:TOKEN|DTCG|BACKEND|SESSION)_/u.test(registration.code))
    throw new Error(
      `Third-party diagnostic code cannot use the reserved prefix: ${registration.code}`,
    );
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+\/[A-Z][A-Z0-9_]*$/u.test(registration.code))
    throw new Error(
      `Third-party diagnostic code must use a reverse-domain namespace: ${registration.code}`,
    );
  if (registry.has(registration.code))
    throw new Error(`Diagnostic code is already registered: ${registration.code}`);
  registry.set(registration.code, Object.freeze({ ...registration }));
}

export function diagnosticCodeRegistry(): readonly DiagnosticCodeRegistration[] {
  return [...registry.values()].toSorted((left, right) => left.code.localeCompare(right.code));
}

function canonicalDocument(document: string): string {
  const normalized = document.split(sep).join("/");
  if (!isAbsolute(document)) return normalized.replace(/^\.\//u, "");
  const local = relative(process.cwd(), document).split(sep).join("/");
  return local.startsWith("../") ? normalized.slice(normalized.lastIndexOf("/") + 1) : local;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}

function isDiagnosticLocation(
  source: SourceLocation | DiagnosticLocation,
): source is DiagnosticLocation {
  return "document" in source;
}

export function diagnosticLocation(
  source: SourceLocation | DiagnosticLocation,
  anchor?: SemanticAnchor,
): DiagnosticLocation {
  if (isDiagnosticLocation(source)) return anchor === undefined ? source : { ...source, anchor };
  return {
    document: source.file,
    range: {
      line: source.line,
      column: source.column,
      offset: source.offset,
      length: source.length,
    },
    ...(anchor ? { anchor } : {}),
    ...(source.excerpt === undefined ? {} : { excerpt: source.excerpt }),
  };
}

function compareEdits(left: TextEdit, right: TextEdit): number {
  return (
    left.document.localeCompare(right.document) ||
    left.range.offset - right.range.offset ||
    left.range.length - right.range.length
  );
}

function validateFixes(fixes: readonly DiagnosticFixV1[]): readonly DiagnosticFixV1[] {
  return fixes.map((fix) => {
    if (fix.edits.length === 0)
      throw new Error(`Diagnostic fix \`${fix.title}\` must contain at least one edit`);
    const edits = [...fix.edits].toSorted(compareEdits);
    for (const edit of edits) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(edit.expectedDocumentDigest))
        throw new Error(`Diagnostic fix \`${fix.title}\` has an invalid document digest`);
      if (
        edit.range.line < 1 ||
        edit.range.column < 1 ||
        edit.range.offset < 0 ||
        edit.range.length < 0
      )
        throw new Error(`Diagnostic fix \`${fix.title}\` has an invalid edit range`);
    }
    for (let index = 1; index < edits.length; index += 1) {
      const previous = edits[index - 1]!;
      const current = edits[index]!;
      if (
        previous.document === current.document &&
        previous.range.offset + previous.range.length > current.range.offset
      )
        throw new Error(`Diagnostic fix \`${fix.title}\` contains overlapping edits`);
    }
    return Object.freeze({ ...fix, edits: Object.freeze(edits) });
  });
}

export function documentContentDigest(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

/** Construct a complete, validated Diagnostic v1 value. */
export function createDiagnostic(input: DiagnosticInput | Diagnostic): Diagnostic {
  if ("schemaVersion" in input) return input;
  const registration = registry.get(input.code);
  if (!registration) throw new Error(`Unregistered diagnostic code: ${input.code}`);
  const parameters = Object.freeze({ ...input.parameters });
  const unknown = Object.keys(parameters).filter((key) => !(key in registration.parameters));
  if (unknown.length > 0)
    throw new Error(`Unknown parameters for ${input.code}: ${unknown.join(", ")}`);
  const missing = Object.entries(registration.parameters)
    .filter(([key, schema]) => schema.required && !(key in parameters))
    .map(([key]) => key);
  if (missing.length > 0)
    throw new Error(`Missing parameters for ${input.code}: ${missing.join(", ")}`);
  const source = input.source ? diagnosticLocation(input.source, input.anchor) : undefined;
  const related: readonly RelatedDiagnosticV1[] = Object.freeze(
    (input.related ?? []).map((item) =>
      Object.freeze({
        message: item.message,
        ...(item.source ? { source: diagnosticLocation(item.source, item.anchor) } : {}),
      }),
    ),
  );
  const fixes = Object.freeze(validateFixes(input.fixes ?? []));
  if (fixes.length > 0 && !registration.fixesAllowed)
    throw new Error(`Diagnostic code does not permit fixes: ${input.code}`);
  const identityParameters = Object.fromEntries(
    Object.entries(parameters).filter(([key]) => registration.parameters[key]?.identity),
  ) as Record<string, JsonValue>;
  const fallbackAnchor = source
    ? ({ kind: "offset", errorKind: input.code, offset: source.range.offset } as const)
    : undefined;
  const identityAnchor: JsonValue = source?.anchor
    ? semanticAnchorJson(source.anchor)
    : fallbackAnchor
      ? semanticAnchorJson(fallbackAnchor)
      : null;
  const identity: JsonValue = {
    schemaVersion: "1",
    code: input.code,
    document: source ? canonicalDocument(source.document) : "",
    anchor: identityAnchor,
    parameters: identityParameters,
  };
  return Object.freeze({
    schemaVersion: "1",
    code: input.code,
    severity: input.severity ?? registration.defaultSeverity,
    message: input.message,
    parameters,
    fingerprint: createHash("sha256").update(canonical(identity)).digest("base64url"),
    documentationUrl: registration.documentationUrl,
    ...(source ? { source } : {}),
    related,
    fixes,
  });
}

function semanticAnchorJson(anchor: SemanticAnchor): JsonValue {
  switch (anchor.kind) {
    case "token":
      return { kind: anchor.kind, token: anchor.token };
    case "candidate":
      return { kind: anchor.kind, token: anchor.token, candidate: anchor.candidate };
    case "field":
      return {
        kind: anchor.kind,
        token: anchor.token,
        ...(anchor.candidate ? { candidate: anchor.candidate } : {}),
        path: [...anchor.path],
      };
    case "json-pointer":
      return { kind: anchor.kind, pointer: anchor.pointer };
    case "offset":
      return { kind: anchor.kind, errorKind: anchor.errorKind, offset: anchor.offset };
    default:
      throw new Error("Unknown semantic anchor");
  }
}

export function createDiagnostics(
  inputs: readonly (DiagnosticInput | Diagnostic)[],
): readonly Diagnostic[] {
  return inputs.map(createDiagnostic);
}

/** Mutable construction buffer that normalizes every inserted value to Diagnostic v1. */
export class DiagnosticBag extends Array<Diagnostic> {
  override push(...items: (DiagnosticInput | Diagnostic)[]): number {
    return super.push(...items.map(createDiagnostic));
  }
}
