import { describe, expect, it } from "vitest";

import { IncrementalCompiler } from "../src/incremental.js";

const primitive = (value: number) => ({
  file: "/tokens/primitive.json",
  content: JSON.stringify({ base: { $type: "number", $value: value } }),
});
const semantic = {
  file: "/tokens/semantic.json",
  content: JSON.stringify({ alias: { $type: "number", $value: "{base}" } }),
};
const unrelated = {
  file: "/tokens/unrelated.json",
  content: JSON.stringify({ other: { $type: "number", $value: 10 } }),
};

describe("IncrementalCompiler", () => {
  it("invalidates reverse dependencies but retains unrelated evaluations", async () => {
    const compiler = new IncrementalCompiler();
    const initial = await compiler.initialize([primitive(1), semantic, unrelated]);
    expect(initial.recomputed).toBe(3);
    const update = await compiler.update(primitive(2));
    expect(update.changed).toEqual(["base"]);
    expect([...update.affected]).toEqual(["base", "alias"]);
    expect(update.recomputed).toBe(2);
    expect(update.result.compilation.resolveToken("alias" as never)?.value).toBe(2);
  });

  it("handles file removal using the old reverse graph", async () => {
    const compiler = new IncrementalCompiler();
    await compiler.initialize([primitive(1), semantic]);
    const update = await compiler.remove(primitive(1).file);
    expect(update.changed).toEqual(["base"]);
    expect([...update.affected]).toContain("alias");
    expect(update.result.diagnostics[0]?.code).toBe("TOKEN_UNKNOWN_REFERENCE");
  });

  it("survives invalid JSON and recovers after the next update", async () => {
    const compiler = new IncrementalCompiler();
    await compiler.initialize([primitive(1), semantic]);
    const broken = await compiler.update({ file: primitive(1).file, content: "{" });
    expect(broken.result.success).toBe(false);
    const recovered = await compiler.update(primitive(3));
    expect(recovered.result.success).toBe(true);
    expect(recovered.result.compilation.resolveToken("alias" as never)?.value).toBe(3);
  });

  it("supports added files without reparsing cached documents", async () => {
    const compiler = new IncrementalCompiler();
    await compiler.initialize([primitive(1)]);
    const update = await compiler.update(semantic);
    expect(update.changed).toEqual(["alias"]);
    expect(update.result.stats.tokens).toBe(2);
  });
});
