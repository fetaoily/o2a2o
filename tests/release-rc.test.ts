// Offline tests for the RC release gate logic (scripts/lib/release-gates.ts,
// used by scripts/release-rc.mjs). The publish side effects (git tag/push and
// the CI release workflow) are NOT exercised here — evaluateGates runs on
// injected state so every gate combination is checkable without network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { evaluateGates, type GateState } from "../scripts/lib/release-gates";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
// Version-true RC scheme: the tag derives verbatim from the package.json
// version, which itself carries the prerelease suffix during the RC period.
const TAG = `v${pkg.version}`;

const PASSING: GateState = {
  tag: TAG,
  testsGreen: true,
  tagExistsLocal: false,
  tagMatchesHead: false,
  releaseExists: false,
  treeClean: true,
  resume: false,
};

describe("evaluateGates", () => {
  test("all gates passing evaluates ok", () => {
    expect(evaluateGates(PASSING).ok).toBe(true);
  });

  test("each failing gate is reported by number", () => {
    const failures = (patch: Partial<GateState>) =>
      evaluateGates({ ...PASSING, ...patch }).failures.join("\n");

    expect(failures({ testsGreen: false })).toContain("gate 1");
    expect(failures({ tagExistsLocal: true })).toContain("gate 2");
    expect(failures({ releaseExists: true })).toContain("gate 2");
    expect(failures({ treeClean: false })).toContain("gate 3");
  });

  test("a pre-existing GitHub release fails in every mode (never overwritten)", () => {
    for (const resume of [false, true]) {
      const v = evaluateGates({ ...PASSING, resume, releaseExists: true });
      expect(v.ok).toBe(false);
      expect(v.failures.join(" ")).toContain("never overwritten");
    }
  });

  test("--resume tolerates a local tag only when it points at HEAD", () => {
    expect(evaluateGates({ ...PASSING, resume: true, tagExistsLocal: true, tagMatchesHead: true }).ok).toBe(true);
    const v = evaluateGates({ ...PASSING, resume: true, tagExistsLocal: true, tagMatchesHead: false });
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("does not point at HEAD");
  });

  test("default mode rejects an existing local tag even at HEAD", () => {
    expect(evaluateGates({ ...PASSING, tagExistsLocal: true, tagMatchesHead: true }).ok).toBe(false);
  });

  test("multiple gate failures are all reported", () => {
    const v = evaluateGates({ ...PASSING, testsGreen: false, treeClean: false });
    expect(v.ok).toBe(false);
    expect(v.failures).toHaveLength(2);
  });
});

// Version-true RC scheme pin (same style as tests/workflow.test.ts): the
// script must derive the tag exactly as `v<package.json version>` — no
// appended -rc.1 — so the scheme cannot silently drift back.
describe("release-rc.mjs tag derivation", () => {
  test("tag is exactly v<pkg.version> with no suffix", () => {
    const script = readFileSync(new URL("../scripts/release-rc.mjs", import.meta.url), "utf8");
    expect(script).toContain("const tag = `v${version}`;");
    expect(script).not.toContain("-rc.1");
  });
});
