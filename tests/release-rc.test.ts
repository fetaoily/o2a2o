// Offline tests for the RC release gate logic (scripts/lib/release-gates.ts,
// used by scripts/release-rc.mjs). The publish side effects (git tag/push and
// the CI release workflow) are NOT exercised here — evaluateGates runs on
// injected state so every gate combination is checkable without network.
import { describe, expect, test } from "bun:test";
import { evaluateGates, type GateState } from "../scripts/lib/release-gates";

const TAG = "v0.3.0-rc.1";

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
