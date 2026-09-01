import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compileTerrazzoBundle } from "./index.js";

const input = process.argv[2];
if (!input) throw new Error("Usage: vp run demo <bundled-dtcg.json>");

const identity = resolve(input);
const result = await compileTerrazzoBundle({
  identity,
  content: await readFile(identity, "utf8"),
});

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: result.schemaVersion,
      snapshotStatus: result.snapshot.status,
      tokens: result.snapshot.stats.tokens,
      extensions: result.extensions,
    },
    undefined,
    2,
  )}\n`,
);

if (result.snapshot.status !== "valid" || result.extensions.status === "invalid")
  process.exitCode = 1;
