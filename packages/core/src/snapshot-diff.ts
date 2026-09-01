import { createHash } from "node:crypto";

import type { TokenBackend } from "./backend.js";
import { selectTokenCandidate } from "./context.js";
import { diagnosticLocation } from "./diagnostic.js";
import type {
  CompilationContext,
  Diagnostic,
  DiagnosticLocation,
  JsonValue,
  TokenExpression,
  TokenId,
  TokenNode,
  TokenType,
} from "./model.js";
import {
  contextPredicateFromSelector,
  createContextDomain,
  type ContextDomain,
  type ContextPredicate,
} from "./predicate.js";
import type { ImpactedTokenV1, QueryEdgeV1 } from "./query.js";
import type { CompilationSnapshot, ValidCompilationSnapshot } from "./snapshot.js";

export type SnapshotChangeSideV1 = "base" | "head";

export type TokenChangeKindV1 =
  | "added"
  | "removed"
  | "direct-value"
  | "propagated-value"
  | "type"
  | "metadata"
  | "dependency"
  | "context-coverage";

export interface SnapshotIdentityV1 {
  readonly label: string;
  readonly sourceRevision: string;
  readonly configurationIdentity: string;
  readonly status: "valid" | "invalid";
}

export type ComparisonOmissionReasonV1 =
  | "limit-exceeded"
  | "invalid-base"
  | "invalid-head"
  | "configuration-unavailable"
  | "backend-prepare-failed"
  | "unsupported";

export interface ComparisonCoverageOmissionV1 {
  readonly predicate: ContextPredicate;
  readonly reason: ComparisonOmissionReasonV1;
  readonly detail?: string;
}

export interface ComparisonCoverageV1 {
  readonly requested: readonly ContextPredicate[];
  readonly compared: readonly ContextPredicate[];
  readonly omitted: readonly ComparisonCoverageOmissionV1[];
}

export interface TokenStateV1 {
  readonly source: DiagnosticLocation;
  readonly type: TokenType;
  readonly expression: JsonValue;
  readonly resolvedValue?: JsonValue;
  readonly metadata: JsonValue;
  readonly dependencies: readonly TokenId[];
}

export interface TokenChangeV1 {
  readonly changeId: string;
  readonly kind: TokenChangeKindV1;
  readonly token: TokenId;
  readonly condition: ContextPredicate;
  readonly sides: readonly SnapshotChangeSideV1[];
  readonly before?: TokenStateV1;
  readonly after?: TokenStateV1;
}

export type RenameEvidenceV1 =
  | "equal-type"
  | "equal-value"
  | "equal-metadata"
  | "equal-dependencies"
  | "source-proximity";

export interface RenameCandidateV1 {
  readonly candidateId: string;
  readonly removed: TokenId;
  readonly added: TokenId;
  readonly ambiguity: "unambiguous" | "ambiguous";
  readonly score: number;
  readonly evidence: readonly RenameEvidenceV1[];
}

export interface SnapshotImpactEntryV1 {
  readonly token: TokenId;
  readonly condition: ContextPredicate;
  readonly sides: readonly SnapshotChangeSideV1[];
}

export interface SnapshotImpactV1 {
  readonly schemaVersion: "1";
  readonly changed: readonly SnapshotImpactEntryV1[];
  readonly directlyAffected: readonly SnapshotImpactEntryV1[];
  readonly indirectlyAffected: readonly SnapshotImpactEntryV1[];
}

export interface BackendChangeV1 {
  readonly changeId: string;
  readonly backendId: string;
  readonly kind: "symbol" | "artifact-path";
  readonly identity: string;
  readonly token?: TokenId;
  readonly before?: string;
  readonly after?: string;
}

export interface SidedDiagnosticV1 {
  readonly side: "base" | "head" | "comparison" | "backend";
  readonly diagnostic: Diagnostic;
}

export interface SnapshotDiffV1 {
  readonly schemaVersion: "1";
  readonly status: "complete" | "incomplete";
  readonly base: SnapshotIdentityV1;
  readonly head: SnapshotIdentityV1;
  readonly coverage: ComparisonCoverageV1;
  readonly changes: readonly TokenChangeV1[];
  readonly renameCandidates: readonly RenameCandidateV1[];
  readonly impact: SnapshotImpactV1;
  readonly backends: readonly BackendChangeV1[];
  readonly diagnostics: readonly SidedDiagnosticV1[];
}

export interface SnapshotBackendComparison {
  /** Stable report identity. Both Backend instances must use this ID. */
  readonly id: string;
  readonly base: TokenBackend;
  readonly head?: TokenBackend;
}

export interface SnapshotComparisonOptions {
  readonly context?: CompilationContext;
  readonly baseLabel?: string;
  readonly headLabel?: string;
  /** Explicitly trusted Backend instances. Historical configuration is never loaded by Core. */
  readonly backends?: readonly SnapshotBackendComparison[];
}

interface ComparedToken {
  readonly node: TokenNode;
  readonly state: TokenStateV1;
  readonly selection: JsonValue;
  readonly coverage: JsonValue;
  readonly dependencyFacts: JsonValue;
  readonly resolved?: JsonValue;
}

const CHANGE_KIND_ORDER: Readonly<Record<TokenChangeKindV1, number>> = {
  added: 0,
  removed: 1,
  "direct-value": 2,
  "propagated-value": 3,
  type: 4,
  metadata: 5,
  dependency: 6,
  "context-coverage": 7,
};

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Snapshot comparison values must be finite");
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
  throw new TypeError(`Snapshot comparison cannot serialize ${typeof value}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(jsonValue(value));
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function expressionFact(expression: TokenExpression): JsonValue {
  switch (expression.kind) {
    case "literal":
      return jsonValue({ kind: expression.kind, value: expression.value });
    case "reference":
      return jsonValue({
        kind: expression.kind,
        target: expression.target,
        ...(expression.pointer ? { pointer: expression.pointer } : {}),
      });
    case "json-pointer-reference":
      return jsonValue({
        kind: expression.kind,
        pointer: expression.pointer,
        target: expression.target,
        value: expression.value,
      });
    default:
      throw new Error("Unknown Token expression kind");
  }
}

function metadataFact(token: TokenNode): JsonValue {
  const extensions = Object.fromEntries(
    Object.entries(token.extensions ?? {}).filter(
      ([name]) => name !== "org.token-compiler.contexts",
    ),
  );
  return jsonValue({
    ...(token.description === undefined ? {} : { description: token.description }),
    ...(token.deprecated === undefined ? {} : { deprecated: token.deprecated }),
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
  });
}

function dependencyFacts(edges: readonly QueryEdgeV1[]): JsonValue {
  return jsonValue(
    edges.map((edge) => ({
      candidate: edge.candidate,
      target: edge.to,
      kind: edge.kind,
      fieldPath: [...edge.fieldPath],
    })),
  );
}

function contextDomain(snapshot: CompilationSnapshot, context: CompilationContext): ContextDomain {
  if (snapshot.status === "valid") return createContextDomain(snapshot.ir.contexts);
  const edge = snapshot.query.graph()[0];
  if (edge) return edge.condition.domain;
  return createContextDomain(
    Object.fromEntries(
      Object.entries(context).map(([name, value]) => [name, { default: value, values: [value] }]),
    ),
  );
}

function exactPredicate(
  snapshot: CompilationSnapshot,
  context: CompilationContext,
): ContextPredicate | undefined {
  const result = contextPredicateFromSelector(contextDomain(snapshot, context), context);
  return result.ok ? result.value : undefined;
}

function tokenState(
  snapshot: CompilationSnapshot,
  id: TokenId,
  context: CompilationContext,
): ComparedToken | undefined {
  const node = snapshot.query.token(id);
  if (!node) return undefined;
  const completeContext = snapshot.query.context(context);
  const selected = selectTokenCandidate(node, completeContext);
  const edges = snapshot.query.dependencies(id, { context: completeContext });
  const resolved =
    snapshot.status === "valid" ? snapshot.query.resolve(id, completeContext) : undefined;
  const resolvedValue = resolved ? jsonValue(resolved.value) : undefined;
  const state: TokenStateV1 = {
    source: diagnosticLocation(selected.source, {
      kind: "candidate",
      token: id,
      candidate: selected.candidate,
    }),
    type: node.type,
    expression: expressionFact(selected.expression),
    ...(resolvedValue === undefined ? {} : { resolvedValue }),
    metadata: metadataFact(node),
    dependencies: Object.freeze(
      [...new Set(edges.map((edge) => edge.to))].toSorted((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    ),
  };
  return {
    node,
    state,
    selection: state.expression,
    coverage: jsonValue({
      selector: selected.selector ?? {},
      ...(selected.precedence === undefined ? {} : { precedence: selected.precedence }),
      ...(selected.origin === undefined ? {} : { origin: selected.origin }),
    }),
    dependencyFacts: dependencyFacts(edges),
    ...(resolvedValue === undefined ? {} : { resolved: resolvedValue }),
  };
}

function sourceIdentity(state: TokenStateV1 | undefined): JsonValue {
  if (!state) return null;
  return jsonValue({
    document: state.source.document,
    anchor: state.source.anchor ?? null,
  });
}

function createChange(
  kind: TokenChangeKindV1,
  token: TokenId,
  condition: ContextPredicate,
  sides: readonly SnapshotChangeSideV1[],
  before: TokenStateV1 | undefined,
  after: TokenStateV1 | undefined,
): TokenChangeV1 {
  const changeId = digest({
    schemaVersion: "1",
    kind,
    token,
    condition: condition.key,
    before: sourceIdentity(before),
    after: sourceIdentity(after),
  });
  return deepFreeze({
    changeId,
    kind,
    token,
    condition,
    sides: [...sides],
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  });
}

function compareChanges(left: TokenChangeV1, right: TokenChangeV1): number {
  return (
    String(left.token).localeCompare(String(right.token)) ||
    CHANGE_KIND_ORDER[left.kind] - CHANGE_KIND_ORDER[right.kind] ||
    left.condition.key.localeCompare(right.condition.key) ||
    (left.before?.source.document ?? "").localeCompare(right.before?.source.document ?? "") ||
    (left.before?.source.range.offset ?? -1) - (right.before?.source.range.offset ?? -1) ||
    (left.after?.source.document ?? "").localeCompare(right.after?.source.document ?? "") ||
    (left.after?.source.range.offset ?? -1) - (right.after?.source.range.offset ?? -1) ||
    left.changeId.localeCompare(right.changeId)
  );
}

function same(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return stableJson(left ?? null) === stableJson(right ?? null);
}

function parent(id: TokenId): string {
  const value = String(id);
  const boundary = value.lastIndexOf(".");
  return boundary < 0 ? "" : value.slice(0, boundary);
}

function renameEvidence(removed: ComparedToken, added: ComparedToken): readonly RenameEvidenceV1[] {
  if (removed.node.type !== added.node.type) return [];
  const evidence: RenameEvidenceV1[] = ["equal-type"];
  if (
    removed.resolved !== undefined &&
    added.resolved !== undefined &&
    same(removed.resolved, added.resolved)
  )
    evidence.push("equal-value");
  if (same(removed.state.metadata, added.state.metadata)) evidence.push("equal-metadata");
  if (same(removed.dependencyFacts, added.dependencyFacts)) evidence.push("equal-dependencies");
  if (
    removed.state.source.document === added.state.source.document &&
    parent(removed.node.id) === parent(added.node.id)
  )
    evidence.push("source-proximity");
  return evidence;
}

function renameScore(evidence: readonly RenameEvidenceV1[]): number {
  const weights: Readonly<Record<RenameEvidenceV1, number>> = {
    "equal-type": 0.2,
    "equal-value": 0.45,
    "equal-metadata": 0.1,
    "equal-dependencies": 0.2,
    "source-proximity": 0.05,
  };
  return evidence.reduce((score, entry) => score + weights[entry], 0);
}

function renameCandidates(
  removed: ReadonlyMap<TokenId, ComparedToken>,
  added: ReadonlyMap<TokenId, ComparedToken>,
): readonly RenameCandidateV1[] {
  const candidates = [...removed].flatMap(([removedId, before]) =>
    [...added].flatMap(([addedId, after]) => {
      const evidence = renameEvidence(before, after);
      const score = renameScore(evidence);
      return score < 0.75
        ? []
        : [
            {
              candidateId: digest(
                jsonValue({
                  schemaVersion: "1",
                  removed: removedId,
                  added: addedId,
                  evidence,
                }),
              ),
              removed: removedId,
              added: addedId,
              score,
              evidence,
            },
          ];
    }),
  );
  const maximumForRemoved = new Map<TokenId, number>();
  const maximumForAdded = new Map<TokenId, number>();
  for (const candidate of candidates) {
    maximumForRemoved.set(
      candidate.removed,
      Math.max(maximumForRemoved.get(candidate.removed) ?? 0, candidate.score),
    );
    maximumForAdded.set(
      candidate.added,
      Math.max(maximumForAdded.get(candidate.added) ?? 0, candidate.score),
    );
  }
  return Object.freeze(
    candidates
      .map((candidate): RenameCandidateV1 => {
        const removedTies = candidates.filter(
          (entry) =>
            entry.removed === candidate.removed &&
            entry.score === maximumForRemoved.get(candidate.removed),
        ).length;
        const addedTies = candidates.filter(
          (entry) =>
            entry.added === candidate.added && entry.score === maximumForAdded.get(candidate.added),
        ).length;
        return deepFreeze({
          ...candidate,
          ambiguity: removedTies === 1 && addedTies === 1 ? "unambiguous" : "ambiguous",
        });
      })
      .toSorted(
        (left, right) =>
          String(left.removed).localeCompare(String(right.removed)) ||
          right.score - left.score ||
          String(left.added).localeCompare(String(right.added)),
      ),
  );
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
      .map((entry) =>
        deepFreeze({
          token: entry.token,
          condition: entry.condition,
          sides: [...entry.sides],
        }),
      )
      .toSorted(
        (left, right) =>
          String(left.token).localeCompare(String(right.token)) ||
          left.condition.key.localeCompare(right.condition.key),
      ),
  );
}

function identity(snapshot: CompilationSnapshot, label: string): SnapshotIdentityV1 {
  return Object.freeze({
    label,
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

function backendChanges(
  backendId: string,
  baseSymbols: readonly { readonly id: string; readonly token: TokenId; readonly name: string }[],
  headSymbols: readonly { readonly id: string; readonly token: TokenId; readonly name: string }[],
  baseArtifacts: readonly { readonly id: string; readonly path: string }[],
  headArtifacts: readonly { readonly id: string; readonly path: string }[],
): readonly BackendChangeV1[] {
  const changes: BackendChangeV1[] = [];
  const symbols = new Set([
    ...baseSymbols.map((entry) => entry.id),
    ...headSymbols.map((entry) => entry.id),
  ]);
  for (const symbolId of [...symbols].toSorted()) {
    const before = baseSymbols.find((entry) => entry.id === symbolId);
    const after = headSymbols.find((entry) => entry.id === symbolId);
    if (before?.name === after?.name) continue;
    const token = after?.token ?? before?.token;
    changes.push(
      deepFreeze({
        changeId: digest({
          schemaVersion: "1",
          backendId,
          kind: "symbol",
          identity: symbolId,
          before: before?.name ?? null,
          after: after?.name ?? null,
        }),
        backendId,
        kind: "symbol",
        identity: symbolId,
        ...(token ? { token } : {}),
        ...(before ? { before: before.name } : {}),
        ...(after ? { after: after.name } : {}),
      }),
    );
  }
  const artifacts = new Set([
    ...baseArtifacts.map((entry) => entry.id),
    ...headArtifacts.map((entry) => entry.id),
  ]);
  for (const artifactId of [...artifacts].toSorted()) {
    const before = baseArtifacts.find((entry) => entry.id === artifactId);
    const after = headArtifacts.find((entry) => entry.id === artifactId);
    if (before?.path === after?.path) continue;
    changes.push(
      deepFreeze({
        changeId: digest({
          schemaVersion: "1",
          backendId,
          kind: "artifact-path",
          identity: artifactId,
          before: before?.path ?? null,
          after: after?.path ?? null,
        }),
        backendId,
        kind: "artifact-path",
        identity: artifactId,
        ...(before ? { before: before.path } : {}),
        ...(after ? { after: after.path } : {}),
      }),
    );
  }
  return changes;
}

async function compareBackends(
  base: ValidCompilationSnapshot,
  head: ValidCompilationSnapshot,
  pairs: readonly SnapshotBackendComparison[],
): Promise<{
  readonly changes: readonly BackendChangeV1[];
  readonly diagnostics: readonly SidedDiagnosticV1[];
  readonly complete: boolean;
}> {
  const changes: BackendChangeV1[] = [];
  const diagnostics: SidedDiagnosticV1[] = [];
  let complete = true;
  for (const pair of pairs) {
    const headBackend = pair.head ?? pair.base;
    if (pair.base.id !== pair.id || headBackend.id !== pair.id)
      throw new TypeError(`Backend comparison ${pair.id} must use matching Backend IDs`);
    // Backend pairs run serially so callbacks cannot interfere with another comparison.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Deterministic isolation is intentional.
    const basePreparation = await base.prepare([pair.base]);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Deterministic isolation is intentional.
    const headPreparation = await head.prepare([headBackend]);
    diagnostics.push(...sideDiagnostics("backend", basePreparation.diagnostics));
    diagnostics.push(...sideDiagnostics("backend", headPreparation.diagnostics));
    if (!basePreparation.success || !headPreparation.success) complete = false;
    const basePlan = basePreparation.plans[0];
    const headPlan = headPreparation.plans[0];
    if (!basePlan || !headPlan) {
      complete = false;
      continue;
    }
    changes.push(
      ...backendChanges(
        pair.id,
        basePlan.symbols,
        headPlan.symbols,
        basePlan.artifacts,
        headPlan.artifacts,
      ),
    );
  }
  return {
    changes: Object.freeze(
      changes.toSorted(
        (left, right) =>
          left.backendId.localeCompare(right.backendId) ||
          (left.token ? String(left.token) : "").localeCompare(
            right.token ? String(right.token) : "",
          ) ||
          left.identity.localeCompare(right.identity) ||
          left.kind.localeCompare(right.kind),
      ),
    ),
    diagnostics: Object.freeze(diagnostics),
    complete,
  };
}

/** Compare two immutable snapshots in one explicit Context. */
export async function compareSnapshots(
  base: CompilationSnapshot,
  head: CompilationSnapshot,
  options: SnapshotComparisonOptions = {},
): Promise<SnapshotDiffV1> {
  const requestedContext = options.context ?? head.query.context();
  const baseContext = base.query.context(requestedContext);
  const headContext = head.query.context(requestedContext);
  const basePredicate = exactPredicate(base, baseContext);
  const headPredicate = exactPredicate(head, headContext);
  const condition = headPredicate ?? basePredicate ?? exactPredicate(head, {});
  if (!condition) throw new RangeError("Comparison Context cannot be represented");

  const omissions: ComparisonCoverageOmissionV1[] = [];
  if (!basePredicate)
    omissions.push({
      predicate: condition,
      reason: "unsupported",
      detail: "Base Context is invalid",
    });
  if (!headPredicate)
    omissions.push({
      predicate: condition,
      reason: "unsupported",
      detail: "Head Context is invalid",
    });
  if (basePredicate && headPredicate && basePredicate.domain.key !== headPredicate.domain.key)
    omissions.push({
      predicate: condition,
      reason: "unsupported",
      detail: "Base and head Context domains differ",
    });
  if (base.status === "invalid") omissions.push({ predicate: condition, reason: "invalid-base" });
  if (head.status === "invalid") omissions.push({ predicate: condition, reason: "invalid-head" });

  const ids = [...new Set([...base.query.completions(), ...head.query.completions()])].toSorted(
    (left, right) => String(left).localeCompare(String(right)),
  );
  const beforeStates = new Map<TokenId, ComparedToken>();
  const afterStates = new Map<TokenId, ComparedToken>();
  const changes: TokenChangeV1[] = [];
  const directRoots = new Set<TokenId>();

  for (const id of ids) {
    const before = tokenState(base, id, baseContext);
    const after = tokenState(head, id, headContext);
    if (before) beforeStates.set(id, before);
    if (after) afterStates.set(id, after);
    if (!before && after) {
      changes.push(createChange("added", id, condition, ["head"], undefined, after.state));
      directRoots.add(id);
      continue;
    }
    if (before && !after) {
      changes.push(createChange("removed", id, condition, ["base"], before.state, undefined));
      directRoots.add(id);
      continue;
    }
    if (!before || !after) continue;

    const facts: readonly [TokenChangeKindV1, boolean][] = [
      ["direct-value", !same(before.selection, after.selection)],
      ["type", before.node.type !== after.node.type],
      ["metadata", !same(before.state.metadata, after.state.metadata)],
      ["dependency", !same(before.dependencyFacts, after.dependencyFacts)],
      ["context-coverage", !same(before.coverage, after.coverage)],
    ];
    for (const [kind, changed] of facts) {
      if (!changed) continue;
      changes.push(createChange(kind, id, condition, ["base", "head"], before.state, after.state));
      directRoots.add(id);
    }
    if (
      base.status === "valid" &&
      head.status === "valid" &&
      same(before.selection, after.selection) &&
      !same(before.resolved, after.resolved)
    )
      changes.push(
        createChange(
          "propagated-value",
          id,
          condition,
          ["base", "head"],
          before.state,
          after.state,
        ),
      );
  }

  const roots = [...directRoots].toSorted((left, right) =>
    String(left).localeCompare(String(right)),
  );
  const baseRoots = roots.filter((id) => base.query.token(id));
  const headRoots = roots.filter((id) => head.query.token(id));
  const baseImpact = base.query.impact(baseRoots, { context: baseContext });
  const headImpact = head.query.impact(headRoots, { context: headContext });
  const changedImpact = mergeImpactEntries(baseImpact.changed, headImpact.changed);
  const changedIds = new Set(changedImpact.map((entry) => entry.token));
  const directImpact = mergeImpactEntries(baseImpact.directlyAffected, headImpact.directlyAffected);
  const directIds = new Set(directImpact.map((entry) => entry.token));
  const indirectImpact = mergeImpactEntries(
    baseImpact.indirectlyAffected,
    headImpact.indirectlyAffected,
  ).filter((entry) => !changedIds.has(entry.token) && !directIds.has(entry.token));

  const diagnostics: SidedDiagnosticV1[] = [
    ...sideDiagnostics("base", base.diagnostics),
    ...sideDiagnostics("head", head.diagnostics),
  ];
  let backends: readonly BackendChangeV1[] = [];
  if (base.status === "valid" && head.status === "valid" && options.backends?.length) {
    const comparison = await compareBackends(base, head, options.backends);
    backends = comparison.changes;
    diagnostics.push(...comparison.diagnostics);
    if (!comparison.complete)
      omissions.push({ predicate: condition, reason: "backend-prepare-failed" });
  }

  const complete = omissions.length === 0;
  return deepFreeze({
    schemaVersion: "1",
    status: complete ? "complete" : "incomplete",
    base: identity(base, options.baseLabel ?? "base"),
    head: identity(head, options.headLabel ?? "head"),
    coverage: {
      requested: [condition],
      compared: complete ? [condition] : [],
      omitted: omissions,
    },
    changes: changes.toSorted(compareChanges),
    renameCandidates: renameCandidates(
      new Map([...beforeStates].filter(([id]) => !afterStates.has(id))),
      new Map([...afterStates].filter(([id]) => !beforeStates.has(id))),
    ),
    impact: {
      schemaVersion: "1",
      changed: changedImpact,
      directlyAffected: directImpact,
      indirectlyAffected: indirectImpact,
    },
    backends,
    diagnostics,
  });
}

/** Deterministic JSON projection of Snapshot Diff v1. */
export function serializeSnapshotDiff(diff: SnapshotDiffV1): string {
  return `${JSON.stringify(jsonValue(diff), null, 2)}\n`;
}
