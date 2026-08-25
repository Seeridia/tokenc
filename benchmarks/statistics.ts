import type { BenchmarkDistribution } from "./types.js";

function finiteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${label} must be a finite number`);
}

/** Hyndman-Fan type 7 percentile, matching the default used by R and NumPy. */
export function percentileR7(values: readonly number[], percentile: number): number {
  finiteNumber(percentile, "percentile");
  if (percentile < 0 || percentile > 1) throw new RangeError("percentile must be between 0 and 1");
  if (values.length === 0) throw new RangeError("percentile requires at least one sample");
  values.forEach((value, index) => finiteNumber(value, `values[${index}]`));

  const sorted = values.toSorted((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * percentile;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (rank - lowerIndex);
}

export function summarizeDistribution(values: readonly number[]): BenchmarkDistribution {
  if (values.length === 0) throw new RangeError("distribution requires at least one sample");
  values.forEach((value, index) => finiteNumber(value, `values[${index}]`));
  const sorted = values.toSorted((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentileR7(sorted, 0.5),
    p95: percentileR7(sorted, 0.95),
    max: sorted.at(-1)!,
  };
}

/** Reject values that JSON.stringify would silently convert to null. */
export function assertFiniteNumbers(
  value: unknown,
  label = "$",
  seen = new WeakSet<object>(),
): void {
  if (typeof value === "number") {
    finiteNumber(value, label);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError(`${label} must not contain circular references`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteNumbers(entry, `${label}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value))
      assertFiniteNumbers(entry, `${label}.${key}`, seen);
  }
  seen.delete(value);
}
