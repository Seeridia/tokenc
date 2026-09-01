import { createDiagnostic } from "./diagnostic.js";
import type { CompilationContext, Diagnostic, DiagnosticSeverity, JsonValue } from "./model.js";
import {
  contextPredicateFromSelector,
  intersectContextPredicates,
  type ContextPredicate,
} from "./predicate.js";
import type { BackendChangeV1, SnapshotDiffV1, TokenChangeV1 } from "./snapshot-diff.js";

export const BREAKING_CHANGE_RULE_IDS = [
  "token-removal",
  "token-type-change",
  "context-coverage-loss",
  "backend-symbol-removal",
  "backend-artifact-path-removal",
  "direct-value-change",
  "propagated-value-change",
] as const;

export type BreakingChangeRuleId = (typeof BREAKING_CHANGE_RULE_IDS)[number];
export type PolicySeverity = DiagnosticSeverity | "off";

export interface BreakingChangeRuleV1 {
  readonly severity: PolicySeverity;
  readonly context?: CompilationContext;
}

export interface BreakingChangeAllowV1 {
  readonly changeId: string;
  readonly reason: string;
  readonly context?: CompilationContext;
}

/** Authored policy input. Omitted rules inherit the documented v1 defaults. */
export interface BreakingChangePolicyV1 {
  readonly schemaVersion: "1";
  readonly rules?: Readonly<Partial<Record<BreakingChangeRuleId, BreakingChangeRuleV1>>>;
  readonly allow?: readonly BreakingChangeAllowV1[];
}

export interface NormalizedBreakingChangePolicyV1 {
  readonly schemaVersion: "1";
  readonly rules: Readonly<Record<BreakingChangeRuleId, BreakingChangeRuleV1>>;
  readonly allow: readonly BreakingChangeAllowV1[];
}

export interface PolicyFindingV1 {
  readonly findingId: string;
  readonly ruleId: BreakingChangeRuleId;
  readonly changeId: string;
  readonly severity: DiagnosticSeverity;
  readonly allowed: boolean;
  readonly allowReason?: string;
  readonly diagnostic: Diagnostic;
}

export interface PolicyEvaluationV1 {
  readonly schemaVersion: "1";
  readonly verdict: "pass" | "fail" | "incomplete";
  /** The exact immutable comparison fact supplied by the caller. */
  readonly diff: SnapshotDiffV1;
  readonly policy: NormalizedBreakingChangePolicyV1;
  readonly findings: readonly PolicyFindingV1[];
  readonly diagnostics: readonly Diagnostic[];
}

const DEFAULT_SEVERITIES: Readonly<Record<BreakingChangeRuleId, PolicySeverity>> = Object.freeze({
  "token-removal": "error",
  "token-type-change": "error",
  "context-coverage-loss": "error",
  "backend-symbol-removal": "error",
  "backend-artifact-path-removal": "error",
  "direct-value-change": "warning",
  "propagated-value-change": "warning",
});

const FINDING_CODES: Readonly<Record<BreakingChangeRuleId, string>> = Object.freeze({
  "token-removal": "POLICY_TOKEN_REMOVAL",
  "token-type-change": "POLICY_TOKEN_TYPE_CHANGE",
  "context-coverage-loss": "POLICY_CONTEXT_COVERAGE_LOSS",
  "backend-symbol-removal": "POLICY_BACKEND_SYMBOL_REMOVAL",
  "backend-artifact-path-removal": "POLICY_BACKEND_ARTIFACT_PATH_REMOVAL",
  "direct-value-change": "POLICY_DIRECT_VALUE_CHANGE",
  "propagated-value-change": "POLICY_PROPAGATED_VALUE_CHANGE",
});

const RULE_ID_SET: ReadonlySet<string> = new Set(BREAKING_CHANGE_RULE_IDS);

interface Candidate {
  readonly ruleId: BreakingChangeRuleId;
  readonly changeId: string;
  readonly condition?: ContextPredicate;
  readonly description: string;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedContext(value: unknown): CompilationContext | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string" || entry.length === 0))
    return undefined;
  const context: Record<string, string> = {};
  for (const [name, entry] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
    if (typeof entry === "string") context[name] = entry;
  }
  return Object.freeze(context);
}

function invalidConfig(path: string, detail: string): Diagnostic {
  return createDiagnostic({
    code: "POLICY_INVALID_CONFIG",
    message: `Invalid breaking-change policy at ${path}: ${detail}`,
    parameters: { path },
  });
}

function rejectUnknownProperties(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: Diagnostic[],
): void {
  for (const name of Object.keys(value).toSorted()) {
    if (!allowed.has(name)) diagnostics.push(invalidConfig(`${path}.${name}`, "unknown property"));
  }
}

function validateContext(
  context: CompilationContext | undefined,
  path: string,
  domain: ContextPredicate | undefined,
  diagnostics: Diagnostic[],
): CompilationContext | undefined {
  if (!context) return undefined;
  if (!domain) {
    diagnostics.push(invalidConfig(path, "the comparison does not expose a Context domain"));
    return context;
  }
  const result = contextPredicateFromSelector(domain.domain, context);
  if (!result.ok) diagnostics.push(invalidConfig(path, result.error.message));
  return context;
}

function normalizePolicy(
  input: unknown,
  domain: ContextPredicate | undefined,
): { policy: NormalizedBreakingChangePolicyV1; diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const root = isRecord(input) ? input : {};
  if (!isRecord(input)) diagnostics.push(invalidConfig("$", "expected an object"));
  rejectUnknownProperties(root, new Set(["schemaVersion", "rules", "allow"]), "$", diagnostics);
  if (root.schemaVersion !== "1")
    diagnostics.push(invalidConfig("$.schemaVersion", 'expected the string "1"'));

  const authoredRules = isRecord(root.rules) ? root.rules : {};
  if (root.rules !== undefined && !isRecord(root.rules))
    diagnostics.push(invalidConfig("$.rules", "expected an object"));
  for (const ruleId of Object.keys(authoredRules).toSorted()) {
    if (!RULE_ID_SET.has(ruleId))
      diagnostics.push(
        createDiagnostic({
          code: "POLICY_UNKNOWN_RULE",
          message: `Unknown breaking-change policy rule: ${ruleId}`,
          parameters: { ruleId },
        }),
      );
  }

  const normalizeRule = (ruleId: BreakingChangeRuleId): BreakingChangeRuleV1 => {
    const path = `$.rules.${ruleId}`;
    const authored = authoredRules[ruleId];
    if (authored === undefined) return Object.freeze({ severity: DEFAULT_SEVERITIES[ruleId] });
    if (!isRecord(authored)) {
      diagnostics.push(invalidConfig(path, "expected an object"));
      return Object.freeze({ severity: DEFAULT_SEVERITIES[ruleId] });
    }
    rejectUnknownProperties(authored, new Set(["severity", "context"]), path, diagnostics);
    const severity = authored.severity;
    const accepted =
      severity === "error" || severity === "warning" || severity === "info" || severity === "off";
    if (!accepted)
      diagnostics.push(invalidConfig(`${path}.severity`, "expected error, warning, info, or off"));
    let context: CompilationContext | undefined;
    if (authored.context !== undefined) {
      context = sortedContext(authored.context);
      if (!context)
        diagnostics.push(
          invalidConfig(`${path}.context`, "expected string-valued Context entries"),
        );
      else validateContext(context, `${path}.context`, domain, diagnostics);
    }
    return Object.freeze({
      severity: accepted ? severity : DEFAULT_SEVERITIES[ruleId],
      ...(context ? { context } : {}),
    });
  };
  const rules: Readonly<Record<BreakingChangeRuleId, BreakingChangeRuleV1>> = Object.freeze({
    "token-removal": normalizeRule("token-removal"),
    "token-type-change": normalizeRule("token-type-change"),
    "context-coverage-loss": normalizeRule("context-coverage-loss"),
    "backend-symbol-removal": normalizeRule("backend-symbol-removal"),
    "backend-artifact-path-removal": normalizeRule("backend-artifact-path-removal"),
    "direct-value-change": normalizeRule("direct-value-change"),
    "propagated-value-change": normalizeRule("propagated-value-change"),
  });

  const authoredAllow = root.allow;
  if (authoredAllow !== undefined && !Array.isArray(authoredAllow))
    diagnostics.push(invalidConfig("$.allow", "expected an array"));
  const allow = (Array.isArray(authoredAllow) ? authoredAllow : []).flatMap((entry, index) => {
    const path = `$.allow[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(invalidConfig(path, "expected an object"));
      return [];
    }
    rejectUnknownProperties(entry, new Set(["changeId", "reason", "context"]), path, diagnostics);
    if (typeof entry.changeId !== "string" || entry.changeId.length === 0) {
      diagnostics.push(invalidConfig(`${path}.changeId`, "expected a non-empty string"));
      return [];
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      diagnostics.push(invalidConfig(`${path}.reason`, "expected a non-empty string"));
      return [];
    }
    let context: CompilationContext | undefined;
    if (entry.context !== undefined) {
      context = sortedContext(entry.context);
      if (!context)
        diagnostics.push(
          invalidConfig(`${path}.context`, "expected string-valued Context entries"),
        );
      else validateContext(context, `${path}.context`, domain, diagnostics);
    }
    return [
      Object.freeze({
        changeId: entry.changeId,
        reason: entry.reason,
        ...(context ? { context } : {}),
      }),
    ];
  });
  allow.sort(
    (left, right) =>
      left.changeId.localeCompare(right.changeId) ||
      JSON.stringify(left.context ?? {}).localeCompare(JSON.stringify(right.context ?? {})) ||
      left.reason.localeCompare(right.reason),
  );

  return {
    policy: deepFreeze({ schemaVersion: "1", rules, allow }),
    diagnostics: Object.freeze(diagnostics),
  };
}

function tokenRule(change: TokenChangeV1): BreakingChangeRuleId | undefined {
  switch (change.kind) {
    case "removed":
      return "token-removal";
    case "type":
      return "token-type-change";
    case "context-coverage":
      return "context-coverage-loss";
    case "direct-value":
      return "direct-value-change";
    case "propagated-value":
      return "propagated-value-change";
    default:
      return undefined;
  }
}

function backendRule(change: BackendChangeV1): BreakingChangeRuleId | undefined {
  if (change.before === undefined || change.before === change.after) return undefined;
  return change.kind === "symbol" ? "backend-symbol-removal" : "backend-artifact-path-removal";
}

function candidates(diff: SnapshotDiffV1): readonly Candidate[] {
  return Object.freeze(
    [
      ...diff.changes.flatMap((change) => {
        const ruleId = tokenRule(change);
        return ruleId
          ? [
              {
                ruleId,
                changeId: change.changeId,
                condition: change.condition,
                description: `${change.token}: ${change.kind}`,
              },
            ]
          : [];
      }),
      ...diff.backends.flatMap((change) => {
        const ruleId = backendRule(change);
        return ruleId
          ? [
              {
                ruleId,
                changeId: change.changeId,
                description: `${change.backendId}: ${change.kind} ${change.before ?? change.identity}`,
              },
            ]
          : [];
      }),
    ].toSorted(
      (left, right) =>
        BREAKING_CHANGE_RULE_IDS.indexOf(left.ruleId) -
          BREAKING_CHANGE_RULE_IDS.indexOf(right.ruleId) ||
        left.changeId.localeCompare(right.changeId),
    ),
  );
}

function scopeMatches(
  condition: ContextPredicate | undefined,
  scope: CompilationContext | undefined,
): boolean {
  if (!scope) return true;
  if (!condition) return false;
  const selected = contextPredicateFromSelector(condition.domain, scope);
  if (!selected.ok) return false;
  const intersection = intersectContextPredicates(condition, selected.value);
  return intersection.ok && intersection.value.clauses.length > 0;
}

function findingDiagnostic(candidate: Candidate, severity: DiagnosticSeverity): Diagnostic {
  return createDiagnostic({
    code: FINDING_CODES[candidate.ruleId],
    severity,
    message: `${candidate.description} violates ${candidate.ruleId}`,
    parameters: { ruleId: candidate.ruleId, changeId: candidate.changeId },
  });
}

/** Evaluate an authored Policy v1 value exclusively from immutable Snapshot Diff v1 facts. */
export function evaluateSnapshotPolicy(diff: SnapshotDiffV1, input: unknown): PolicyEvaluationV1 {
  const domain = diff.coverage.requested[0];
  const normalized = normalizePolicy(input, domain);
  const diagnostics = [...normalized.diagnostics];
  const applicable = candidates(diff).filter((candidate) =>
    scopeMatches(candidate.condition, normalized.policy.rules[candidate.ruleId].context),
  );

  const matchedAllow = new Set<BreakingChangeAllowV1>();
  const findings = applicable.flatMap((candidate): readonly PolicyFindingV1[] => {
    const severity = normalized.policy.rules[candidate.ruleId].severity;
    const allowance = normalized.policy.allow.find(
      (entry) =>
        entry.changeId === candidate.changeId && scopeMatches(candidate.condition, entry.context),
    );
    if (allowance) matchedAllow.add(allowance);
    if (severity === "off") return [];
    const diagnostic = findingDiagnostic(candidate, severity);
    return [
      deepFreeze({
        findingId: diagnostic.fingerprint,
        ruleId: candidate.ruleId,
        changeId: candidate.changeId,
        severity,
        allowed: allowance !== undefined,
        ...(allowance ? { allowReason: allowance.reason } : {}),
        diagnostic,
      }),
    ];
  });

  for (const allowance of normalized.policy.allow) {
    if (matchedAllow.has(allowance)) continue;
    diagnostics.push(
      createDiagnostic({
        code: "POLICY_STALE_ALLOW",
        message: `Allow entry does not match an applicable change: ${allowance.changeId}`,
        parameters: { changeId: allowance.changeId },
      }),
    );
  }
  if (diff.status === "incomplete")
    diagnostics.push(
      createDiagnostic({
        code: "POLICY_INCOMPLETE_COMPARISON",
        message: `Cannot decide breaking-change policy from incomplete comparison ${diff.base.label}..${diff.head.label}`,
        parameters: { base: diff.base.label, head: diff.head.label },
      }),
    );

  const verdict =
    diagnostics.length > 0 || diff.status === "incomplete"
      ? "incomplete"
      : findings.some((finding) => finding.severity === "error" && !finding.allowed)
        ? "fail"
        : "pass";
  return deepFreeze({
    schemaVersion: "1",
    verdict,
    diff,
    policy: normalized.policy,
    findings: Object.freeze(findings),
    diagnostics: Object.freeze(diagnostics),
  });
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  throw new TypeError(`Policy evaluation cannot serialize ${typeof value}`);
}

/** Deterministic JSON projection of Policy Evaluation v1. */
export function serializePolicyEvaluation(evaluation: PolicyEvaluationV1): string {
  return `${JSON.stringify(jsonValue(evaluation), null, 2)}\n`;
}
