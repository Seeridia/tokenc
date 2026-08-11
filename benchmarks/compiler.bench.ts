import { performance } from "node:perf_hooks";

import { compileDocuments, IncrementalCompiler, type TokenSourceInput } from "@tokenc/core";

interface Measurement {
  readonly name: string;
  readonly milliseconds: number;
  readonly details?: string;
}

async function measure(
  name: string,
  operation: () => Promise<string | undefined>,
): Promise<Measurement> {
  const start = performance.now();
  const details = await operation();
  return {
    name,
    milliseconds: performance.now() - start,
    ...(details ? { details } : {}),
  };
}

function independentTokens(count: number): TokenSourceInput {
  return {
    file: `/benchmark/independent-${count}.json`,
    content: JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `token${index}`,
          { $type: "number", $value: index },
        ]),
      ),
    ),
  };
}

function aliasChain(count: number): TokenSourceInput {
  return {
    file: `/benchmark/aliases-${count}.json`,
    content: JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `alias${index}`,
          { $type: "number", $value: index === 0 ? 0 : `{alias${index - 1}}` },
        ]),
      ),
    ),
  };
}

function fanOut(count: number): readonly TokenSourceInput[] {
  return [
    { file: "/benchmark/base.json", content: '{"base":{"$type":"number","$value":1}}' },
    {
      file: "/benchmark/fanout.json",
      content: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `consumer${index}`,
            { $type: "number", $value: "{base}" },
          ]),
        ),
      ),
    },
  ];
}

function themedTokens(count: number): TokenSourceInput {
  return {
    file: "/benchmark/themes.json",
    content: JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `themed${index}`,
          {
            $type: "number",
            $value: index,
            $extensions: { "org.token-compiler.contexts": { "theme=dark": index + 1 } },
          },
        ]),
      ),
    ),
  };
}

const results: Measurement[] = [];
for (const count of [1_000, 10_000]) {
  results.push(
    // oxlint-disable-next-line eslint/no-await-in-loop -- Benchmarks run sequentially to avoid workload interference.
    await measure(`cold compile: ${count} independent tokens`, async () => {
      const result = await compileDocuments([independentTokens(count)]);
      return `${result.stats.tokens} tokens`;
    }),
  );
}
results.push(
  await measure("cold compile: 10,000-token alias chain", async () => {
    const result = await compileDocuments([aliasChain(10_000)]);
    return `${result.stats.references} references`;
  }),
  await measure("cold compile: 2,000-way fan-out", async () => {
    const result = await compileDocuments(fanOut(2_000));
    return `${result.stats.references} references`;
  }),
  await measure("cold compile: 1,000 themed tokens", async () => {
    const result = await compileDocuments([themedTokens(1_000)], {
      contexts: { theme: { default: "light", values: ["light", "dark"] } },
    });
    return `${result.stats.contexts} sparse contexts`;
  }),
);

const compiler = new IncrementalCompiler();
const primitive = (value: number): TokenSourceInput => ({
  file: "/benchmark/primitive.json",
  content: JSON.stringify({ base: { $type: "number", $value: value } }),
});
const semantic: TokenSourceInput = {
  file: "/benchmark/semantic.json",
  content: JSON.stringify({
    semantic: { $type: "number", $value: "{base}" },
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `component${index}`,
        { $type: "number", $value: "{semantic}" },
      ]),
    ),
  }),
};
await compiler.initialize([independentTokens(10_000), primitive(1), semantic]);
results.push(
  await measure("incremental: one primitive + 11 dependents", async () => {
    const update = await compiler.update(primitive(2));
    return `${update.graphDelta.touchedNodes} graph node patched, ${update.affected.size} affected, ${update.recomputed} recomputed, ${update.result.stats.checkedTokens ?? update.result.stats.tokens} checked`;
  }),
);

process.stdout.write(
  `${results
    .map(
      (result) =>
        `${result.name.padEnd(48)} ${result.milliseconds.toFixed(2).padStart(9)} ms${result.details ? `  (${result.details})` : ""}`,
    )
    .join("\n")}\n`,
);
