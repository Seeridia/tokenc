import { createHash } from "node:crypto";

import {
  ALL_TOKEN_TYPES,
  compareSnapshots,
  compileDocuments,
  evaluateSnapshotPolicy,
  type BackendPlan,
  type CompilationContext,
  type SnapshotDiffV1,
  type TokenBackend,
} from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { createDiffReport, serializeReportJson, serializeReportSarif } from "../src/report.js";

type ReferenceValue = number | { readonly ref: string };

interface ReferenceToken {
  readonly type?: "number" | "string";
  readonly value: ReferenceValue;
  readonly dark?: ReferenceValue;
  readonly description?: string;
}

type ReferenceRevision = Readonly<Record<string, ReferenceToken>>;
type ChangeKind = SnapshotDiffV1["changes"][number]["kind"];

interface ReferenceChange {
  readonly token: string;
  readonly kind: ChangeKind;
  readonly sides: readonly ("base" | "head")[];
  readonly before?: ReferenceValue | string;
  readonly after?: ReferenceValue | string;
}

const contexts = {
  theme: { default: "light", values: ["light", "dark"] },
} as const;

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

function source(revision: ReferenceRevision, valid = true) {
  if (!valid) return { file: "/workspace/tokens.json", content: '{"broken":' };
  return {
    file: "/workspace/tokens.json",
    content: JSON.stringify(
      Object.fromEntries(
        Object.entries(revision).map(([name, token]) => [
          name,
          {
            $type: token.type ?? "number",
            $value: authoredValue(token.value),
            ...(token.description === undefined ? {} : { $description: token.description }),
            ...(token.dark === undefined
              ? {}
              : {
                  $extensions: {
                    "org.token-compiler.contexts": { "theme=dark": authoredValue(token.dark) },
                  },
                }),
          },
        ]),
      ),
    ),
  };
}

function authoredValue(value: ReferenceValue): number | string {
  return typeof value === "number" ? value : `{${value.ref}}`;
}

function selected(token: ReferenceToken, context: CompilationContext): ReferenceValue {
  return context.theme === "dark" && token.dark !== undefined ? token.dark : token.value;
}

function resolved(
  revision: ReferenceRevision,
  token: string,
  context: CompilationContext,
  seen: ReadonlySet<string> = new Set(),
): number {
  if (seen.has(token)) throw new Error(`Reference model cycle at ${token}`);
  const definition = revision[token];
  if (!definition) throw new Error(`Reference model missing token ${token}`);
  const value = selected(definition, context);
  return typeof value === "number"
    ? value
    : resolved(revision, value.ref, context, new Set([...seen, token]));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function referenceChanges(
  base: ReferenceRevision,
  head: ReferenceRevision,
  context: CompilationContext,
): readonly ReferenceChange[] {
  const changes: ReferenceChange[] = [];
  for (const token of [...new Set([...Object.keys(base), ...Object.keys(head)])].toSorted()) {
    const before = base[token];
    const after = head[token];
    if (!before) {
      changes.push({
        token,
        kind: "added",
        sides: ["head"],
        after: resolved(head, token, context),
      });
      continue;
    }
    if (!after) {
      changes.push({
        token,
        kind: "removed",
        sides: ["base"],
        before: resolved(base, token, context),
      });
      continue;
    }
    const beforeValue = selected(before, context);
    const afterValue = selected(after, context);
    const beforeResolved = resolved(base, token, context);
    const afterResolved = resolved(head, token, context);
    if (!same(beforeValue, afterValue))
      changes.push({
        token,
        kind: "direct-value",
        sides: ["base", "head"],
        before: beforeResolved,
        after: afterResolved,
      });
    else if (!same(beforeResolved, afterResolved))
      changes.push({
        token,
        kind: "propagated-value",
        sides: ["base", "head"],
        before: beforeResolved,
        after: afterResolved,
      });
    if ((before.type ?? "number") !== (after.type ?? "number"))
      changes.push({
        token,
        kind: "type",
        sides: ["base", "head"],
        before: beforeResolved,
        after: afterResolved,
      });
    if (before.description !== after.description)
      changes.push({
        token,
        kind: "metadata",
        sides: ["base", "head"],
        before: beforeResolved,
        after: afterResolved,
      });
    const beforeDependency = typeof beforeValue === "number" ? undefined : beforeValue.ref;
    const afterDependency = typeof afterValue === "number" ? undefined : afterValue.ref;
    if (beforeDependency !== afterDependency)
      changes.push({
        token,
        kind: "dependency",
        sides: ["base", "head"],
        before: beforeResolved,
        after: afterResolved,
      });
    if ((before.dark === undefined) !== (after.dark === undefined))
      changes.push({
        token,
        kind: "context-coverage",
        sides: ["base", "head"],
        before: beforeResolved,
        after: afterResolved,
      });
  }
  const order: Readonly<Record<ChangeKind, number>> = {
    added: 0,
    removed: 1,
    "direct-value": 2,
    "propagated-value": 3,
    type: 4,
    metadata: 5,
    dependency: 6,
    "context-coverage": 7,
  };
  return changes.toSorted(
    (left, right) => left.token.localeCompare(right.token) || order[left.kind] - order[right.kind],
  );
}

function reverseGraph(
  revision: ReferenceRevision,
  context: CompilationContext,
): ReadonlyMap<string, readonly string[]> {
  const reverse = new Map<string, string[]>();
  for (const [token, definition] of Object.entries(revision)) {
    const value = selected(definition, context);
    if (typeof value === "number") continue;
    reverse.set(value.ref, [...(reverse.get(value.ref) ?? []), token]);
  }
  return reverse;
}

function affected(
  revision: ReferenceRevision,
  roots: ReadonlySet<string>,
  context: CompilationContext,
): ReadonlyMap<string, number> {
  const reverse = reverseGraph(revision, context);
  const depths = new Map<string, number>();
  const queue = [...roots].filter((token) => revision[token]).map((token) => ({ token, depth: 0 }));
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const consumer of reverse.get(current.token) ?? []) {
      const depth = current.depth + 1;
      if ((depths.get(consumer) ?? Number.POSITIVE_INFINITY) <= depth) continue;
      depths.set(consumer, depth);
      queue.push({ token: consumer, depth });
    }
  }
  return depths;
}

function referenceImpact(
  base: ReferenceRevision,
  head: ReferenceRevision,
  changes: readonly ReferenceChange[],
  context: CompilationContext,
) {
  const roots = new Set(
    changes.filter((change) => change.kind !== "propagated-value").map((change) => change.token),
  );
  const baseDepths = affected(base, roots, context);
  const headDepths = affected(head, roots, context);
  const entries = (depth: "direct" | "indirect") =>
    [...new Set([...baseDepths.keys(), ...headDepths.keys()])]
      .filter((token) => {
        const distances = [baseDepths.get(token), headDepths.get(token)].filter(
          (value): value is number => value !== undefined,
        );
        return depth === "direct"
          ? distances.some((value) => value === 1)
          : distances.every((value) => value > 1);
      })
      .toSorted();
  const direct = entries("direct");
  return {
    changed: [...roots].toSorted(),
    directlyAffected: direct,
    indirectlyAffected: entries("indirect").filter((token) => !direct.includes(token)),
  };
}

function backend(prefix: string, path: string): TokenBackend {
  return {
    id: "reference",
    capabilities,
    prepare: (ir): BackendPlan => ({
      backendId: "reference",
      diagnostics: [],
      symbols: ir.sourceTokens.map((token) => ({
        id: String(token.id),
        token: token.id,
        namespace: "differential",
        name: `${prefix}${token.id}`,
        source: token.source,
      })),
      artifacts: [
        {
          id: "main",
          path,
          mediaType: "text/plain",
          tokenIds: ir.tokens.map((token) => token.id),
          payload: null,
        },
      ],
      data: null,
    }),
    emit: () => [],
  };
}

function referenceBackendChanges(base: ReferenceRevision, head: ReferenceRevision) {
  return [
    {
      kind: "artifact-path",
      identity: "main",
      before: "dist/base.txt",
      after: "dist/head.txt",
    },
    ...[...new Set([...Object.keys(base), ...Object.keys(head)])].toSorted().map((token) => {
      if (base[token] && head[token])
        return {
          kind: "symbol",
          identity: token,
          token,
          before: `base-${token}`,
          after: `head-${token}`,
        };
      if (base[token]) return { kind: "symbol", identity: token, token, before: `base-${token}` };
      return { kind: "symbol", identity: token, token, after: `head-${token}` };
    }),
  ].toSorted(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.identity.localeCompare(right.identity),
  );
}

function changeProjection(diff: SnapshotDiffV1) {
  return diff.changes.map((change) => ({
    token: String(change.token),
    kind: change.kind,
    sides: change.sides,
    ...(change.before?.resolvedValue === undefined ? {} : { before: change.before.resolvedValue }),
    ...(change.after?.resolvedValue === undefined ? {} : { after: change.after.resolvedValue }),
  }));
}

function impactProjection(diff: SnapshotDiffV1) {
  return {
    changed: diff.impact.changed.map((entry) => String(entry.token)).toSorted(),
    directlyAffected: diff.impact.directlyAffected.map((entry) => String(entry.token)).toSorted(),
    indirectlyAffected: diff.impact.indirectlyAffected
      .map((entry) => String(entry.token))
      .toSorted(),
  };
}

function policyRule(kind: ChangeKind): string | undefined {
  switch (kind) {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sarifResults(sourceValue: string): readonly Readonly<Record<string, unknown>>[] {
  const value: unknown = JSON.parse(sourceValue);
  if (!isRecord(value) || !Array.isArray(value.runs) || !isRecord(value.runs[0]))
    throw new TypeError("Expected a SARIF run");
  const results = value.runs[0].results;
  if (!Array.isArray(results) || !results.every(isRecord))
    throw new TypeError("Expected SARIF results");
  return results;
}

async function compareAgainstReference(
  baseRevision: ReferenceRevision,
  headRevision: ReferenceRevision,
  context: CompilationContext,
): Promise<readonly string[]> {
  const [base, head] = await Promise.all([
    compileDocuments([source(baseRevision)], { contexts }),
    compileDocuments([source(headRevision)], { contexts }),
  ]);
  const options = {
    context,
    baseLabel: "reference-base",
    headLabel: "reference-head",
    backends: [
      {
        id: "reference",
        base: backend("base-", "dist/base.txt"),
        head: backend("head-", "dist/head.txt"),
      },
    ],
  } as const;
  const [diff, repeated] = await Promise.all([
    compareSnapshots(base, head, options),
    compareSnapshots(base, head, options),
  ]);
  const reference = referenceChanges(baseRevision, headRevision, context);
  const mismatches: string[] = [];
  const actualChanges = changeProjection(diff);
  if (!same(actualChanges, reference))
    mismatches.push(
      `structural-or-resolved-facts actual=${JSON.stringify(actualChanges)} expected=${JSON.stringify(reference)}`,
    );
  const actualImpact = impactProjection(diff);
  const expectedImpact = referenceImpact(baseRevision, headRevision, reference, context);
  if (!same(actualImpact, expectedImpact))
    mismatches.push(
      `impact actual=${JSON.stringify(actualImpact)} expected=${JSON.stringify(expectedImpact)}`,
    );
  const actualBackends = diff.backends
    .map(({ kind, identity, token, before, after }) => ({
      kind,
      identity,
      ...(token ? { token: String(token) } : {}),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }))
    .toSorted(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.identity.localeCompare(right.identity),
    );
  if (!same(actualBackends, referenceBackendChanges(baseRevision, headRevision)))
    mismatches.push("backend-plans");

  const evaluation = evaluateSnapshotPolicy(diff, { schemaVersion: "1" });
  const expectedFindings = diff.changes
    .flatMap((change) => {
      const ruleId = policyRule(change.kind);
      return ruleId ? [{ ruleId, changeId: change.changeId }] : [];
    })
    .concat(
      diff.backends.flatMap((change) =>
        change.before === undefined
          ? []
          : [
              {
                ruleId:
                  change.kind === "symbol"
                    ? "backend-symbol-removal"
                    : "backend-artifact-path-removal",
                changeId: change.changeId,
              },
            ],
      ),
    )
    .toSorted(
      (left, right) =>
        left.ruleId.localeCompare(right.ruleId) || left.changeId.localeCompare(right.changeId),
    );
  const actualFindings = evaluation.findings
    .map((finding) => ({ ruleId: finding.ruleId, changeId: finding.changeId }))
    .toSorted(
      (left, right) =>
        left.ruleId.localeCompare(right.ruleId) || left.changeId.localeCompare(right.changeId),
    );
  if (!same(actualFindings, expectedFindings)) mismatches.push("policy-findings");
  if (
    evaluation.findings.some(
      (finding) =>
        finding.findingId !== finding.diagnostic.fingerprint ||
        !/^[A-Za-z0-9_-]{43}$/u.test(finding.findingId),
    )
  )
    mismatches.push("diagnostic-fingerprints");

  const report = createDiffReport(diff, "/workspace", evaluation);
  const repeatedReport = createDiffReport(
    repeated,
    "/workspace",
    evaluateSnapshotPolicy(repeated, { schemaVersion: "1" }),
  );
  const json = serializeReportJson(report);
  const jsonDigest = createHash("sha256").update(json).digest("hex");
  const repeatedDigest = createHash("sha256")
    .update(serializeReportJson(repeatedReport))
    .digest("hex");
  if (jsonDigest !== repeatedDigest) mismatches.push("report-json");
  const sarifFacts = sarifResults(serializeReportSarif(report)).map((result) => {
    const fingerprints = isRecord(result.partialFingerprints) ? result.partialFingerprints : {};
    const properties = isRecord(result.properties) ? result.properties : {};
    return {
      ruleId: result.ruleId,
      fingerprint: fingerprints["tokenc/v1"],
      changeId: properties.changeId,
    };
  });
  const reportFacts = report.diagnostics.map((entry) => ({
    ruleId: entry.diagnostic.code,
    fingerprint: entry.diagnostic.fingerprint,
    changeId: entry.changeId,
  }));
  if (!same(sarifFacts, reportFacts)) mismatches.push("sarif-facts");
  return mismatches;
}

function makeRevision(state: number): ReferenceRevision {
  return {
    root: { value: state + 1 },
    direct: { value: { ref: "root" } },
    transitive: { value: { ref: "direct" } },
    stable: { value: 99 },
    contextual: { value: 10, dark: state + 101 },
    metadata: { value: 7, description: state % 2 === 0 ? "even" : "odd" },
    switcher: { value: { ref: state % 2 === 0 ? "root" : "stable" } },
    ...(state % 3 === 0 ? { optional: { value: state + 500 } } : {}),
  };
}

function seededStates(seed: number, length: number): readonly number[] {
  let state = seed >>> 0;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % 10_000;
  });
}

describe("M2 independent differential proof", () => {
  it("matches deterministic facts, plans, policy, JSON, and SARIF projections", async () => {
    const results = await Promise.all(
      [{ theme: "light" }, { theme: "dark" }].map((context) =>
        compareAgainstReference(makeRevision(0), makeRevision(1), context),
      ),
    );
    for (const mismatches of results) {
      expect(mismatches).toEqual([]);
    }
  });

  it("has zero mismatches across seeded revision sequences", async () => {
    for (const seed of [1, 42, 2_026, 0x5eed]) {
      const states = seededStates(seed, 8);
      for (let index = 1; index < states.length; index += 1) {
        const before = states[index - 1];
        const after = states[index];
        if (before === undefined || after === undefined) throw new Error("Missing seeded state");
        const context = { theme: index % 2 === 0 ? "light" : "dark" };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each revision pair is an ordered proof step.
        const mismatches = await compareAgainstReference(
          makeRevision(before),
          makeRevision(after),
          context,
        );
        expect(mismatches, `seed=${seed} step=${index}`).toEqual([]);
      }
    }
  });

  it("normalizes incomplete-comparison locations identically in JSON and SARIF", async () => {
    const [base, head] = await Promise.all([
      compileDocuments([source(makeRevision(0), false)], { contexts }),
      compileDocuments([source(makeRevision(1))], { contexts }),
    ]);
    const diff = await compareSnapshots(base, head, { context: { theme: "light" } });
    const report = createDiffReport(
      diff,
      "/workspace",
      evaluateSnapshotPolicy(diff, { schemaVersion: "1" }),
    );
    const locatedDiagnostics = report.diagnostics.filter((entry) => entry.diagnostic.source);
    const sarif = serializeReportSarif(report);
    const locatedResults = sarifResults(sarif).filter((entry) => Array.isArray(entry.locations));
    expect(locatedResults.map((entry) => entry.ruleId)).toEqual(
      locatedDiagnostics.map((entry) => entry.diagnostic.code),
    );
    expect(sarif).not.toContain("/workspace/");
  });
});
