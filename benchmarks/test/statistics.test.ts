import { describe, expect, it } from "vite-plus/test";

import { assertFiniteNumbers, percentileR7, summarizeDistribution } from "../statistics.js";

describe("benchmark statistics", () => {
  it("computes Hyndman-Fan type 7 percentiles without mutating samples", () => {
    const samples = [4, 1, 3, 2];
    expect(percentileR7(samples, 0)).toBe(1);
    expect(percentileR7(samples, 0.5)).toBe(2.5);
    expect(percentileR7(samples, 0.95)).toBeCloseTo(3.85);
    expect(percentileR7(samples, 1)).toBe(4);
    expect(samples).toEqual([4, 1, 3, 2]);
  });

  it("handles a singleton distribution", () => {
    expect(percentileR7([7], 0.95)).toBe(7);
    expect(summarizeDistribution([7])).toEqual({
      count: 1,
      min: 7,
      p50: 7,
      p95: 7,
      max: 7,
    });
  });

  it("summarizes p50 and p95 with the declared method", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(summarizeDistribution(samples)).toEqual({
      count: 20,
      min: 1,
      p50: 10.5,
      p95: 19.05,
      max: 20,
    });
  });

  it("rejects empty, invalid-percentile, and non-finite inputs", () => {
    expect(() => percentileR7([], 0.5)).toThrow("at least one sample");
    expect(() => percentileR7([1], -0.1)).toThrow("between 0 and 1");
    expect(() => percentileR7([1], 1.1)).toThrow("between 0 and 1");
    expect(() => summarizeDistribution([1, Number.NaN])).toThrow("values[1]");
  });

  it("finds non-finite numbers at their report path", () => {
    expect(() =>
      assertFiniteNumbers({ cases: [{ samples: [{ wallMs: Number.POSITIVE_INFINITY }] }] }),
    ).toThrow("$.cases[0].samples[0].wallMs");
    expect(() => assertFiniteNumbers({ summary: { p95: Number.NaN } })).toThrow("$.summary.p95");
    expect(() => assertFiniteNumbers({ summary: { p95: 12.5 } })).not.toThrow();
  });

  it("rejects actual cycles but permits shared report objects", () => {
    const shared = { value: 1 };
    expect(() => assertFiniteNumbers({ first: shared, second: shared })).not.toThrow();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertFiniteNumbers(cyclic)).toThrow("circular references");
  });
});
