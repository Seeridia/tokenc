import { createDiagnostic } from "./diagnostic.js";
import type { CompilationContext, Diagnostic, JsonValue, TokenId } from "./model.js";
import {
  contextPredicateFromSelector,
  createContextDomain,
  trueContextPredicate,
  type ContextDomain,
  type ContextPredicate,
  type ContextPredicateError,
} from "./predicate.js";
import type { ImpactedTokenV1, ImpactQueryV1 } from "./query.js";
import type {
  ComparisonCoverageOmissionV1,
  ComparisonCoverageV1,
  SidedDiagnosticV1,
  SnapshotChangeSideV1,
  SnapshotImpactEntryV1,
  SnapshotImpactV1,
} from "./snapshot-diff.js";
import type { CompilationSnapshot } from "./snapshot.js";

export type ImpactSourceStatusV1 = "matched" | "empty" | "unknown";

export interface ImpactSourceV1 {
  readonly document: string;
  readonly status: ImpactSourceStatusV1;
  readonly tokens: readonly TokenId[];
}

export interface ImpactSnapshotIdentityV1 {
  readonly sourceRevision: string;
  readonly configurationIdentity: string;
  readonly status: "valid" | "invalid";
}

export interface ImpactRequestV1 {
  readonly documents: readonly string[];
  readonly sources: readonly ImpactSourceV1[];
  readonly tokens: readonly TokenId[];
  readonly context: CompilationContext;
  readonly predicate?: ContextPredicate;
}

export interface ImpactReportV1 {
  readonly schemaVersion: "1";
  readonly status: "complete" | "incomplete";
  readonly snapshot: ImpactSnapshotIdentityV1;
  readonly base?: ImpactSnapshotIdentityV1;
  readonly request: ImpactRequestV1;
  readonly coverage: ComparisonCoverageV1;
  readonly impact: SnapshotImpactV1;
  readonly diagnostics: readonly SidedDiagnosticV1[];
}

export interface ImpactReportOptions {
  /** Exact canonical document identities to treat as changed. */
  readonly documents: readonly string[];
  /** Optional Context filter. Omit it to retain every satisfiable Predicate region. */
  readonly context?: CompilationContext;
  /** Optional older Snapshot used to retain removed Tokens and base-only consumers. */
  readonly base?: CompilationSnapshot;
}

interface PredicateResult {
  readonly predicate?: ContextPredicate;
  readonly error?: ContextPredicateError;
}

const EMPTY_IMPACT: ImpactQueryV1 = Object.freeze({
  schemaVersion: "1",
  changed: Object.freeze([]),
  directlyAffected: Object.freeze([]),
  indirectlyAffected: Object.freeze([]),
});

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Impact report values must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  throw new TypeError(`Impact report cannot serialize ${typeof value}`);
}

function domain(snapshot: CompilationSnapshot, context: CompilationContext): ContextDomain {
  if (snapshot.status === "valid") return createContextDomain(snapshot.ir.contexts);
  const edge = snapshot.query.graph()[0];
  if (edge) return edge.condition.domain;
  return createContextDomain(
    Object.fromEntries(
      Object.entries(context).map(([name, value]) => [name, { default: value, values: [value] }]),
    ),
  );
}

function predicate(snapshot: CompilationSnapshot, context: CompilationContext): PredicateResult {
  const contextDomain = domain(snapshot, context);
  if (Object.keys(context).length === 0) return { predicate: trueContextPredicate(contextDomain) };
  const result = contextPredicateFromSelector(contextDomain, context);
  return result.ok ? { predicate: result.value } : { error: result.error };
}

function identity(snapshot: CompilationSnapshot): ImpactSnapshotIdentityV1 {
  return Object.freeze({
    sourceRevision: snapshot.sourceRevision,
    configurationIdentity: snapshot.configurationIdentity,
    status: snapshot.status,
  });
}

function sideDiagnostics(
  side: SidedDiagnosticV1["side"],
  diagnostics: readonly Diagnostic[],
): readonly SidedDiagnosticV1[] {
  return diagnostics.map((diagnostic) => deepFreeze({ side, diagnostic }));
}

function contextDiagnostic(error: ContextPredicateError): Diagnostic {
  return createDiagnostic({
    code: error.code,
    severity: "error",
    message: error.message,
  });
}

function mergeImpactEntries(
  base: readonly ImpactedTokenV1[],
  head: readonly ImpactedTokenV1[],
): readonly SnapshotImpactEntryV1[] {
  const entries = new Map<
    string,
    {
      readonly token: TokenId;
      readonly condition: ContextPredicate;
      readonly sides: SnapshotChangeSideV1[];
    }
  >();
  for (const [side, values] of [
    ["base", base],
    ["head", head],
  ] as const) {
    for (const value of values) {
      const key = `${value.token}\0${value.condition.key}`;
      const previous = entries.get(key);
      if (previous) previous.sides.push(side);
      else entries.set(key, { token: value.token, condition: value.condition, sides: [side] });
    }
  }
  return Object.freeze(
    [...entries.values()]
      .map((entry) => deepFreeze({ ...entry, sides: [...entry.sides] }))
      .toSorted(
        (left, right) =>
          String(left.token).localeCompare(String(right.token)) ||
          left.condition.key.localeCompare(right.condition.key),
      ),
  );
}

function documentTokenIds(snapshot: CompilationSnapshot, document: string): readonly TokenId[] {
  return snapshot.documents.find((entry) => entry.identity === document)?.tokenIds ?? [];
}

function queryImpact(
  snapshot: CompilationSnapshot | undefined,
  roots: readonly TokenId[],
  region: ContextPredicate | undefined,
): ImpactQueryV1 {
  if (!snapshot || !region) return EMPTY_IMPACT;
  return snapshot.query.impact(roots, { predicate: region });
}

/** Build an immutable source-to-Token impact report without performing host IO. */
export function buildImpactReport(
  snapshot: CompilationSnapshot,
  options: ImpactReportOptions,
): ImpactReportV1 {
  const documents = [...new Set(options.documents)].toSorted();
  const requestedContext = Object.freeze(
    Object.fromEntries(
      Object.entries(options.context ?? {}).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
  const headPredicate = predicate(snapshot, requestedContext);
  const basePredicate = options.base ? predicate(options.base, requestedContext) : undefined;
  const requestPredicate = headPredicate.predicate ?? basePredicate?.predicate;
  const sources = documents.map((document): ImpactSourceV1 => {
    const baseTokens = options.base ? documentTokenIds(options.base, document) : [];
    const headTokens = documentTokenIds(snapshot, document);
    const known =
      snapshot.documents.some((entry) => entry.identity === document) ||
      (options.base?.documents.some((entry) => entry.identity === document) ?? false);
    const tokens = [...new Set([...baseTokens, ...headTokens])].toSorted((left, right) =>
      String(left).localeCompare(String(right)),
    );
    return deepFreeze({
      document,
      status: !known ? "unknown" : tokens.length === 0 ? "empty" : "matched",
      tokens,
    });
  });
  const tokens = [...new Set(sources.flatMap((source) => source.tokens))].toSorted((left, right) =>
    String(left).localeCompare(String(right)),
  );
  const baseRoots = options.base
    ? tokens.filter((token) => options.base?.query.token(token) !== undefined)
    : [];
  const headRoots = tokens.filter((token) => snapshot.query.token(token) !== undefined);
  const baseImpact = queryImpact(options.base, baseRoots, basePredicate?.predicate);
  const headImpact = queryImpact(snapshot, headRoots, headPredicate.predicate);
  const changed = mergeImpactEntries(baseImpact.changed, headImpact.changed);
  const changedIds = new Set(changed.map((entry) => entry.token));
  const directlyAffected = mergeImpactEntries(
    baseImpact.directlyAffected,
    headImpact.directlyAffected,
  ).filter((entry) => !changedIds.has(entry.token));
  const directIds = new Set(directlyAffected.map((entry) => entry.token));
  const indirectlyAffected = mergeImpactEntries(
    baseImpact.indirectlyAffected,
    headImpact.indirectlyAffected,
  ).filter((entry) => !changedIds.has(entry.token) && !directIds.has(entry.token));

  const fallbackPredicate = trueContextPredicate(domain(snapshot, {}));
  const coveragePredicate = requestPredicate ?? fallbackPredicate;
  const omissions: ComparisonCoverageOmissionV1[] = [];
  const diagnostics: SidedDiagnosticV1[] = [
    ...(options.base ? sideDiagnostics("base", options.base.diagnostics) : []),
    ...sideDiagnostics("head", snapshot.diagnostics),
  ];
  if (options.base?.status === "invalid")
    omissions.push({ predicate: coveragePredicate, reason: "invalid-base" });
  if (snapshot.status === "invalid")
    omissions.push({ predicate: coveragePredicate, reason: "invalid-head" });
  for (const result of [basePredicate, headPredicate]) {
    if (!result?.error) continue;
    omissions.push({
      predicate: coveragePredicate,
      reason: "unsupported",
      detail: result.error.message,
    });
    diagnostics.push(
      deepFreeze({ side: "comparison", diagnostic: contextDiagnostic(result.error) }),
    );
  }
  if (
    basePredicate?.predicate &&
    headPredicate.predicate &&
    basePredicate.predicate.domain.key !== headPredicate.predicate.domain.key
  )
    omissions.push({
      predicate: coveragePredicate,
      reason: "unsupported",
      detail: "Base and head Context domains differ",
    });
  const unknownSource = sources.some((source) => source.status === "unknown");
  const complete = !unknownSource && omissions.length === 0;
  const coverage: ComparisonCoverageV1 = {
    requested: requestPredicate ? [requestPredicate] : [],
    compared: complete && requestPredicate ? [requestPredicate] : [],
    omitted: omissions,
  };
  return deepFreeze({
    schemaVersion: "1",
    status: complete ? "complete" : "incomplete",
    snapshot: identity(snapshot),
    ...(options.base ? { base: identity(options.base) } : {}),
    request: {
      documents,
      sources,
      tokens,
      context: requestedContext,
      ...(requestPredicate ? { predicate: requestPredicate } : {}),
    },
    coverage,
    impact: {
      schemaVersion: "1",
      changed,
      directlyAffected,
      indirectlyAffected,
    },
    diagnostics,
  });
}

/** Deterministic JSON projection of Impact Report v1. */
export function serializeImpactReport(report: ImpactReportV1): string {
  return `${JSON.stringify(jsonValue(report), null, 2)}\n`;
}
