import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function workflow(name) {
  return readFileSync(`${repositoryRoot}/.github/workflows/${name}`, "utf8");
}

function expectInOrder(contents, markers) {
  let previous = -1;
  for (const marker of markers) {
    const position = contents.indexOf(marker);
    expect(position, `Missing workflow marker: ${marker}`).toBeGreaterThan(previous);
    previous = position;
  }
}

describe("release workflow policy", () => {
  it("uses least-privilege permissions for CI, versioning, preflight, and publishing", () => {
    expect(workflow("ci.yml")).toMatch(/permissions:\n  contents: read/u);
    expect(workflow("version-packages.yml")).toMatch(
      /permissions:\n  contents: write\n  pull-requests: write/u,
    );

    const publish = workflow("publish.yml");
    expect(publish).toMatch(/permissions: \{\}/u);
    expect(publish).toMatch(
      /preflight:[\s\S]*?permissions: \{\}[\s\S]*?publish:[\s\S]*?permissions:\n      contents: write\n      id-token: write/u,
    );
    expect(publish).toMatch(/publish:\n[\s\S]*?timeout-minutes: 20/u);
  });

  it("blocks non-main dispatches before the npm environment or publish job", () => {
    const publish = workflow("publish.yml");
    expect(publish).toContain('if [[ "$RELEASE_REF" != "refs/heads/main" ]]');
    expect(publish).toMatch(/publish:\n[\s\S]*?needs: preflight/u);
    expectInOrder(publish, ["preflight:", "Verify release ref", "publish:", "environment: npm"]);
  });

  it("configures the release path from the runner environment at step runtime", () => {
    const publish = workflow("publish.yml");
    expect(publish).not.toContain("${{ runner.temp }}");
    expect(publish).toContain('echo "RELEASE_OUTPUT=$RUNNER_TEMP/tokenc-release" >> "$GITHUB_ENV"');
  });

  it("packs once, preflights npm, publishes, verifies, then pushes tags", () => {
    expect(() =>
      expectInOrder(workflow("publish.yml"), [
        "name: Verify release inputs are clean",
        "--phase packed",
        "--phase prepublish",
        "name: Publish packages",
        "--phase published",
        "name: Push release tags",
        "--phase remote-tags",
      ]),
    ).not.toThrow();
  });

  it("pins every third-party action to a full commit SHA", () => {
    for (const name of ["ci.yml", "publish.yml", "version-packages.yml"]) {
      const uses = [...workflow(name).matchAll(/^\s*uses:\s+([^\s#]+)/gmu)].map(
        (match) => match[1],
      );
      expect(uses.length, `${name} should use at least one action`).toBeGreaterThan(0);
      for (const action of uses) expect(action).toMatch(/^[^@\s]+@[a-f\d]{40}$/u);
    }
  });
});
