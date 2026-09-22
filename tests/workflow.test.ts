// Pins the contract between release.yml's build matrix and package.json:
// every `platform:` value the matrix feeds to `bun run package:<platform>`
// must exist as a real npm script. Guards against the macos/windows vs
// mac/win naming mismatch class (a mismatch kills the build job on the
// first real tag push and silently skips the release job).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const platforms = [...release.matchAll(/^\s*platform:\s*(\w+)\s*$/gm)].map((m) => m[1]);

describe("release.yml matrix vs package.json scripts", () => {
  test("matrix declares at least one platform", () => {
    expect(platforms.length).toBeGreaterThan(0);
  });

  test("every matrix platform has a package:<platform> script", () => {
    for (const p of platforms) {
      expect(pkg.scripts, `missing script package:${p} (matrix platform "${p}")`).toHaveProperty(
        `package:${p}`,
      );
    }
  });
});
