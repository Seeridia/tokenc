import { describe, expect, it } from "vite-plus/test";

import {
  complementContextPredicate,
  contextPredicateFromSelector,
  contextPredicateMatches,
  createContextDomain,
  intersectContextPredicates,
  isContextPredicateSatisfiable,
  subtractContextPredicates,
  trueContextPredicate,
  unionContextPredicates,
} from "../src/index.js";

const domain = createContextDomain({
  theme: { default: "light", values: ["light", "dark"] },
  density: { default: "comfortable", values: ["comfortable", "compact"] },
});

function predicate(selector: Readonly<Record<string, string>>) {
  const result = contextPredicateFromSelector(domain, selector);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function value(result: ReturnType<typeof unionContextPredicates>) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("ContextPredicate", () => {
  it("normalizes equivalent unions deterministically", () => {
    const dark = predicate({ theme: "dark" });
    const compact = predicate({ density: "compact" });
    expect(value(unionContextPredicates(dark, compact)).key).toBe(
      value(unionContextPredicates(compact, dark)).key,
    );
  });

  it("represents non-convex subtraction exactly", () => {
    const removed = value(
      unionContextPredicates(predicate({ theme: "dark" }), predicate({ density: "compact" })),
    );
    const result = value(subtractContextPredicates(trueContextPredicate(domain), removed));
    expect(contextPredicateMatches(result, { theme: "light", density: "comfortable" })).toBe(true);
    expect(contextPredicateMatches(result, { theme: "dark", density: "comfortable" })).toBe(false);
    expect(contextPredicateMatches(result, { theme: "light", density: "compact" })).toBe(false);
    expect(contextPredicateMatches(result, { theme: "dark", density: "compact" })).toBe(false);
  });

  it("supports exact intersection and complement", () => {
    const dark = predicate({ theme: "dark" });
    const compact = predicate({ density: "compact" });
    const intersection = value(intersectContextPredicates(dark, compact));
    expect(contextPredicateMatches(intersection, { theme: "dark", density: "compact" })).toBe(true);
    expect(contextPredicateMatches(intersection, { theme: "dark", density: "comfortable" })).toBe(
      false,
    );
    const notDark = value(complementContextPredicate(dark));
    expect(contextPredicateMatches(notDark, { theme: "light", density: "compact" })).toBe(true);
    expect(contextPredicateMatches(notDark, { theme: "dark", density: "compact" })).toBe(false);
  });

  it("returns false for disjoint intersections", () => {
    const result = value(
      intersectContextPredicates(predicate({ theme: "light" }), predicate({ theme: "dark" })),
    );
    expect(isContextPredicateSatisfiable(result)).toBe(false);
  });

  it("rejects selectors outside the finite domain", () => {
    expect(contextPredicateFromSelector(domain, { brand: "acme" })).toMatchObject({
      ok: false,
      error: { code: "TOKEN_CONTEXT_UNKNOWN_DIMENSION" },
    });
    expect(contextPredicateFromSelector(domain, { theme: "system" })).toMatchObject({
      ok: false,
      error: { code: "TOKEN_CONTEXT_UNKNOWN_VALUE" },
    });
  });

  it("satisfies Boolean identities across every finite Context", () => {
    const selectors = [
      {},
      { theme: "light" },
      { theme: "dark" },
      { density: "comfortable" },
      { density: "compact" },
      { theme: "dark", density: "compact" },
    ];
    const contexts = [
      { theme: "light", density: "comfortable" },
      { theme: "light", density: "compact" },
      { theme: "dark", density: "comfortable" },
      { theme: "dark", density: "compact" },
    ];
    for (const leftSelector of selectors) {
      for (const rightSelector of selectors) {
        const left = predicate(leftSelector);
        const right = predicate(rightSelector);
        const union = value(unionContextPredicates(left, right));
        const reverseUnion = value(unionContextPredicates(right, left));
        const intersection = value(intersectContextPredicates(left, right));
        const difference = value(subtractContextPredicates(left, right));
        expect(union.key).toBe(reverseUnion.key);
        for (const context of contexts) {
          const leftMatches = contextPredicateMatches(left, context);
          const rightMatches = contextPredicateMatches(right, context);
          expect(contextPredicateMatches(union, context)).toBe(leftMatches || rightMatches);
          expect(contextPredicateMatches(intersection, context)).toBe(leftMatches && rightMatches);
          expect(contextPredicateMatches(difference, context)).toBe(leftMatches && !rightMatches);
        }
      }
    }
  });
});
