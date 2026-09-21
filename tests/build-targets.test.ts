// Tests for the --only target filter of scripts/build-all.mjs (pure logic in
// scripts/lib/build-targets.ts): parsing of the CLI forms CI's
// `bun run build:platform -- <targets>` relies on, and target selection.
import { describe, expect, test } from "bun:test";
import { parseOnlyArgs, selectTargets, type BuildTarget } from "../scripts/lib/build-targets";

const TARGETS: BuildTarget[] = [
  { target: "bun-darwin-arm64", out: "o2a2o-darwin-arm64" },
  { target: "bun-darwin-x64", out: "o2a2o-darwin-x64" },
  { target: "bun-linux-arm64", out: "o2a2o-linux-arm64" },
  { target: "bun-linux-x64", out: "o2a2o-linux-x64" },
  { target: "bun-windows-x64", out: "o2a2o-windows-x64.exe" },
];

describe("parseOnlyArgs", () => {
  test("empty argv selects nothing", () => {
    expect(parseOnlyArgs([])).toEqual([]);
  });

  test("--only with comma-separated names", () => {
    expect(parseOnlyArgs(["--only", "darwin-arm64,linux-x64"])).toEqual(["darwin-arm64", "linux-x64"]);
  });

  test("--only= form", () => {
    expect(parseOnlyArgs(["--only=windows-x64"])).toEqual(["windows-x64"]);
  });

  test("bare -- separator (bun run passthrough)", () => {
    expect(parseOnlyArgs(["--", "darwin-arm64,darwin-x64"])).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(parseOnlyArgs(["--", "linux-arm64"])).toEqual(["linux-arm64"]);
  });

  test("bare positional names", () => {
    expect(parseOnlyArgs(["windows-x64"])).toEqual(["windows-x64"]);
  });

  test("unrelated flags are ignored", () => {
    expect(parseOnlyArgs(["--checksums"])).toEqual([]);
    expect(parseOnlyArgs(["--checksums", "--only", "linux-x64"])).toEqual(["linux-x64"]);
  });

  test("whitespace and empties are dropped", () => {
    expect(parseOnlyArgs(["--only", " darwin-x64 ,, linux-x64 "])).toEqual(["darwin-x64", "linux-x64"]);
  });

  test("the workflow's exact invocation form parses", () => {
    // release.yml: bun run build:platform -- ${{ matrix.targets }}
    for (const targets of ["darwin-arm64,darwin-x64", "linux-arm64,linux-x64", "windows-x64"]) {
      const parsed = parseOnlyArgs(["--", targets]);
      expect(selectTargets(TARGETS, parsed).map((t) => t.target)).toEqual(
        TARGETS.filter((t) => targets.split(",").some((s) => t.target.endsWith(s))).map((t) => t.target),
      );
    }
  });
});

describe("selectTargets", () => {
  test("empty selection = all targets", () => {
    expect(selectTargets(TARGETS, [])).toEqual(TARGETS);
  });

  test("filters by target name with or without the bun- prefix", () => {
    expect(selectTargets(TARGETS, ["linux-x64"]).map((t) => t.out)).toEqual(["o2a2o-linux-x64"]);
    expect(selectTargets(TARGETS, ["bun-windows-x64"]).map((t) => t.out)).toEqual(["o2a2o-windows-x64.exe"]);
  });

  test("selects multiple targets in declaration order", () => {
    expect(selectTargets(TARGETS, ["darwin-x64", "darwin-arm64"]).map((t) => t.out)).toEqual([
      "o2a2o-darwin-arm64",
      "o2a2o-darwin-x64",
    ]);
  });

  test("unknown target throws (a typo must not build the wrong set)", () => {
    expect(() => selectTargets(TARGETS, ["linuz-x64"])).toThrow(/unknown build target/);
  });
});
