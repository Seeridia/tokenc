import type { CompilationContext, ContextDefinition } from "./model.js";

export const CONTEXT_PREDICATE_CLAUSE_LIMIT = 16_384;

export interface ContextDomainDimension {
  readonly name: string;
  readonly default: string;
  readonly values: readonly string[];
}

export interface ContextDomain {
  readonly dimensions: readonly ContextDomainDimension[];
  readonly key: string;
}

export type ContextPredicateClause = Readonly<Record<string, readonly string[]>>;

export interface ContextPredicate {
  readonly domain: ContextDomain;
  readonly clauses: readonly ContextPredicateClause[];
  readonly key: string;
}

export interface ContextPredicateError {
  readonly code:
    | "TOKEN_CONTEXT_DOMAIN_MISMATCH"
    | "TOKEN_CONTEXT_PREDICATE_LIMIT"
    | "TOKEN_CONTEXT_UNKNOWN_DIMENSION"
    | "TOKEN_CONTEXT_UNKNOWN_VALUE";
  readonly message: string;
  readonly estimate?: number;
}

export type ContextPredicateResult =
  | { readonly ok: true; readonly value: ContextPredicate }
  | { readonly ok: false; readonly error: ContextPredicateError };

type Cube = readonly (readonly string[])[];

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function createContextDomain(definition: ContextDefinition = {}): ContextDomain {
  const dimensions = Object.entries(definition).map(([name, dimension]) =>
    Object.freeze({
      name,
      default: dimension.default,
      values: Object.freeze(unique([dimension.default, ...dimension.values])),
    }),
  );
  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    key: JSON.stringify(
      dimensions.map(({ name, default: defaultValue, values }) => [name, defaultValue, values]),
    ),
  });
}

function failure(error: ContextPredicateError): ContextPredicateResult {
  return { ok: false, error };
}

function fullCube(domain: ContextDomain): Cube {
  return domain.dimensions.map((dimension) => dimension.values);
}

function cubeKey(cube: Cube, from = 0): string {
  return JSON.stringify(cube.slice(from));
}

function orderedSubset(
  domainValues: readonly string[],
  values: ReadonlySet<string>,
): readonly string[] {
  return domainValues.filter((value) => values.has(value));
}

function normalizeCube(domain: ContextDomain, cube: Cube): Cube | undefined {
  const normalized = domain.dimensions.map((dimension, index) => {
    const requested = new Set(cube[index] ?? dimension.values);
    return orderedSubset(dimension.values, requested);
  });
  return normalized.some((values) => values.length === 0) ? undefined : normalized;
}

interface CanonicalizationState {
  readonly memo: Map<string, readonly Cube[]>;
  produced: number;
}

function canonicalSuffix(
  domain: ContextDomain,
  cubes: readonly Cube[],
  index: number,
  state: CanonicalizationState,
): readonly Cube[] | undefined {
  if (cubes.length === 0) return [];
  if (index === domain.dimensions.length) return [[]];
  const inputs = [...new Set(cubes.map((cube) => cubeKey(cube, index)))].toSorted();
  const memoKey = `${index}:${inputs.join("|")}`;
  const cached = state.memo.get(memoKey);
  if (cached) return cached;
  const dimension = domain.dimensions[index];
  if (!dimension) return [];
  const groups = new Map<string, { values: string[]; suffixes: readonly Cube[] }>();
  for (const value of dimension.values) {
    const applicable = cubes.filter((cube) => cube[index]?.includes(value));
    const suffixes = canonicalSuffix(domain, applicable, index + 1, state);
    if (!suffixes) return undefined;
    if (suffixes.length === 0) continue;
    const signature = JSON.stringify(suffixes);
    const group = groups.get(signature);
    if (group) group.values.push(value);
    else groups.set(signature, { values: [value], suffixes });
  }
  const result: Cube[] = [];
  for (const group of groups.values()) {
    for (const suffix of group.suffixes) {
      state.produced += 1;
      if (state.produced > CONTEXT_PREDICATE_CLAUSE_LIMIT) return undefined;
      result.push([Object.freeze(group.values), ...suffix]);
    }
  }
  const frozen = Object.freeze(result);
  state.memo.set(memoKey, frozen);
  return frozen;
}

function clauseFromCube(domain: ContextDomain, cube: Cube): ContextPredicateClause {
  const entries = domain.dimensions.flatMap((dimension, index) => {
    const values = cube[index] ?? dimension.values;
    return values.length === dimension.values.length
      ? []
      : ([[dimension.name, Object.freeze([...values])]] as const);
  });
  return Object.freeze(Object.fromEntries(entries));
}

function predicateFromCubes(domain: ContextDomain, input: readonly Cube[]): ContextPredicateResult {
  const cubes = input.flatMap((cube) => {
    const normalized = normalizeCube(domain, cube);
    return normalized ? [normalized] : [];
  });
  const state: CanonicalizationState = { memo: new Map(), produced: 0 };
  const canonical = canonicalSuffix(domain, cubes, 0, state);
  if (!canonical)
    return failure({
      code: "TOKEN_CONTEXT_PREDICATE_LIMIT",
      message: `Context predicate exceeds the ${CONTEXT_PREDICATE_CLAUSE_LIMIT} clause limit`,
      estimate: state.produced,
    });
  const clauses = Object.freeze(canonical.map((cube) => clauseFromCube(domain, cube)));
  return {
    ok: true,
    value: Object.freeze({ domain, clauses, key: JSON.stringify(clauses) }),
  };
}

function cubesFromPredicate(predicate: ContextPredicate): readonly Cube[] {
  return predicate.clauses.map((clause) =>
    predicate.domain.dimensions.map((dimension) =>
      Object.hasOwn(clause, dimension.name) ? clause[dimension.name]! : dimension.values,
    ),
  );
}

function compatible(
  left: ContextPredicate,
  right: ContextPredicate,
): ContextPredicateError | undefined {
  return left.domain.key === right.domain.key
    ? undefined
    : {
        code: "TOKEN_CONTEXT_DOMAIN_MISMATCH",
        message: "Context predicates belong to different Context domains",
      };
}

export function falseContextPredicate(domain: ContextDomain): ContextPredicate {
  const result = predicateFromCubes(domain, []);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function trueContextPredicate(domain: ContextDomain): ContextPredicate {
  const result = predicateFromCubes(domain, [fullCube(domain)]);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function contextPredicateFromSelector(
  domain: ContextDomain,
  selector: CompilationContext,
): ContextPredicateResult {
  const dimensions = new Map(domain.dimensions.map((dimension) => [dimension.name, dimension]));
  for (const [name, value] of Object.entries(selector)) {
    const dimension = dimensions.get(name);
    if (!dimension)
      return failure({
        code: "TOKEN_CONTEXT_UNKNOWN_DIMENSION",
        message: `Unknown context dimension \`${name}\``,
      });
    if (!dimension.values.includes(value))
      return failure({
        code: "TOKEN_CONTEXT_UNKNOWN_VALUE",
        message: `Unknown value \`${value}\` for context \`${name}\``,
      });
  }
  return predicateFromCubes(domain, [
    domain.dimensions.map((dimension) =>
      Object.hasOwn(selector, dimension.name) ? [selector[dimension.name]!] : dimension.values,
    ),
  ]);
}

export function unionContextPredicates(
  left: ContextPredicate,
  right: ContextPredicate,
): ContextPredicateResult {
  const mismatch = compatible(left, right);
  return mismatch
    ? failure(mismatch)
    : predicateFromCubes(left.domain, [...cubesFromPredicate(left), ...cubesFromPredicate(right)]);
}

export function intersectContextPredicates(
  left: ContextPredicate,
  right: ContextPredicate,
): ContextPredicateResult {
  const mismatch = compatible(left, right);
  if (mismatch) return failure(mismatch);
  const intersections: Cube[] = [];
  for (const leftCube of cubesFromPredicate(left)) {
    for (const rightCube of cubesFromPredicate(right)) {
      const cube = left.domain.dimensions.map((dimension, index) => {
        const rightValues = new Set(rightCube[index] ?? dimension.values);
        return (leftCube[index] ?? dimension.values).filter((value) => rightValues.has(value));
      });
      if (cube.every((values) => values.length > 0)) intersections.push(cube);
    }
  }
  return predicateFromCubes(left.domain, intersections);
}

function subtractCube(domain: ContextDomain, left: Cube, right: Cube): readonly Cube[] {
  const intersection = domain.dimensions.map((dimension, index) => {
    const rightValues = new Set(right[index] ?? dimension.values);
    return (left[index] ?? dimension.values).filter((value) => rightValues.has(value));
  });
  if (intersection.some((values) => values.length === 0)) return [left];
  if (intersection.every((values, index) => values.length === left[index]?.length)) return [];
  const prefix = left.map((values) => [...values]);
  const result: Cube[] = [];
  for (const [index, inside] of intersection.entries()) {
    const insideSet = new Set(inside);
    const outside = (prefix[index] ?? []).filter((value) => !insideSet.has(value));
    if (outside.length > 0) {
      const branch = prefix.map((values) => [...values]);
      branch[index] = outside;
      result.push(branch);
    }
    prefix[index] = [...inside];
  }
  return result;
}

export function subtractContextPredicates(
  left: ContextPredicate,
  right: ContextPredicate,
): ContextPredicateResult {
  const mismatch = compatible(left, right);
  if (mismatch) return failure(mismatch);
  let remaining = [...cubesFromPredicate(left)];
  for (const rightCube of cubesFromPredicate(right)) {
    remaining = remaining.flatMap((leftCube) => subtractCube(left.domain, leftCube, rightCube));
    if (remaining.length > CONTEXT_PREDICATE_CLAUSE_LIMIT)
      return failure({
        code: "TOKEN_CONTEXT_PREDICATE_LIMIT",
        message: `Context predicate exceeds the ${CONTEXT_PREDICATE_CLAUSE_LIMIT} clause limit`,
        estimate: remaining.length,
      });
  }
  return predicateFromCubes(left.domain, remaining);
}

export function complementContextPredicate(predicate: ContextPredicate): ContextPredicateResult {
  return subtractContextPredicates(trueContextPredicate(predicate.domain), predicate);
}

export function contextPredicateMatches(
  predicate: ContextPredicate,
  context: CompilationContext,
): boolean {
  return predicate.clauses.some((clause) =>
    predicate.domain.dimensions.every((dimension) => {
      const value = Object.hasOwn(context, dimension.name)
        ? context[dimension.name]!
        : dimension.default;
      const values = Object.hasOwn(clause, dimension.name)
        ? clause[dimension.name]!
        : dimension.values;
      return values.includes(value);
    }),
  );
}

export function isContextPredicateSatisfiable(predicate: ContextPredicate): boolean {
  return predicate.clauses.length > 0;
}
