// Offline tests for scripts/release-rc.mjs: the pure pre-flight gate logic
// (evaluateGates) and the artifact/checksum validation (checkArtifacts,
// parseChecksums) against a synthetic dist tree. The publish steps (git
// tag/push, gh release create) are network side effects and are NOT
// exercised here — the script handles them behind the same gates.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARIES, checkArtifacts, evaluateGates, expectedInstallers, parseChecksums } from "../scripts/release-rc.mjs";

const VERSION = "0.3.0";
const TAG = "v0.3.0-rc.1";
const INSTALLERS = expectedInstallers(VERSION);

const PASSING = {
  testsGreen: true,
  artifactProblems: [] as string[],
  tag: TAG,
  tagExistsLocal: false,
  tagMatchesHead: false,
  releaseExists: false,
  treeClean: true,
  resume: false,
};

describe("expectedInstallers", () => {
  test("derives the nine o2a2o_v<version>-rc.1_* names", () => {
    expect(INSTALLERS).toEqual([
      "o2a2o_v0.3.0-rc.1_windows-x64.zip",
      "o2a2o_v0.3.0-rc.1_linux-amd64.deb",
      "o2a2o_v0.3.0-rc.1_linux-arm64.deb",
      "o2a2o_v0.3.0-rc.1_linux-amd64.rpm",
      "o2a2o_v0.3.0-rc.1_linux-arm64.rpm",
      "o2a2o_v0.3.0-rc.1_linux-amd64.tar.gz",
      "o2a2o_v0.3.0-rc.1_linux-arm64.tar.gz",
      "o2a2o_v0.3.0-rc.1_macos-arm64.tar.gz",
      "o2a2o_v0.3.0-rc.1_macos-x64.tar.gz",
    ]);
  });
});

describe("parseChecksums", () => {
  test("reads sha256sum-format lines", () => {
    const entries = parseChecksums(
      `${"0".repeat(64)}  o2a2o-linux-x64\n${"f".repeat(64)}  o2a2o-windows-x64.exe\n`,
    );
    expect(entries).toEqual([
      { hash: "0".repeat(64), name: "o2a2o-linux-x64" },
      { hash: "f".repeat(64), name: "o2a2o-windows-x64.exe" },
    ]);
  });

  test("rejects malformed lines", () => {
    expect(parseChecksums("nothex  name\n")).toBeNull();
    expect(parseChecksums(`${"z".repeat(64)}  name\n`)).toBeNull();
    expect(parseChecksums(`${"0".repeat(64)} name\n`)).toBeNull(); // single space
  });
});

describe("evaluateGates", () => {
  test("all gates passing evaluates ok", () => {
    expect(evaluateGates(PASSING).ok).toBe(true);
  });

  test("each failing gate is reported by number", () => {
    const failures = (patch: Partial<typeof PASSING>) =>
      evaluateGates({ ...PASSING, ...patch }).failures.join("\n");

    expect(failures({ testsGreen: false })).toContain("gate 1");
    expect(failures({ artifactProblems: ["missing binary: dist/o2a2o-linux-x64"] })).toContain("gates 2/3");
    expect(failures({ tagExistsLocal: true })).toContain("gate 4");
    expect(failures({ releaseExists: true })).toContain("gate 4");
    expect(failures({ treeClean: false })).toContain("gate 5");
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
});

describe("checkArtifacts", () => {
  const root = join(tmpdir(), `o2a2o-release-rc-test-${process.pid}`);

  function makeDist() {
    const dist = join(root, "dist");
    const inst = join(dist, "installers");
    mkdirSync(inst, { recursive: true });
    const sums = (dir: string, names: string[]) =>
      names
        .map((n) => {
          const body = `body of ${n}`;
          writeFileSync(join(dir, n), body);
          return `${createHash("sha256").update(body).digest("hex")}  ${n}`;
        })
        .join("\n") + "\n";
    writeFileSync(join(dist, "checksums.txt"), sums(dist, [...BINARIES]));
    writeFileSync(join(inst, "checksums.txt"), sums(inst, INSTALLERS));
    return dist;
  }

  test("a complete synthetic dist passes", () => {
    makeDist();
    expect(checkArtifacts(root, VERSION)).toEqual([]);
  });

  test("a missing binary is reported", () => {
    rmSync(join(root, "dist", "o2a2o-linux-x64"));
    const problems = checkArtifacts(root, VERSION);
    expect(problems).toContain("missing binary: dist/o2a2o-linux-x64");
    // and its absence makes the checksum file list a missing file too
    expect(problems).toContain("checksums file lists a missing file: o2a2o-linux-x64");
  });

  test("a missing installer is reported", () => {
    makeDist();
    rmSync(join(root, "dist", "installers", INSTALLERS[0]));
    const problems = checkArtifacts(root, VERSION);
    expect(problems).toContain(`missing installer: dist/installers/${INSTALLERS[0]}`);
    expect(problems).toContain(`checksums file lists a missing file: ${INSTALLERS[0]}`);
  });

  test("a corrupted hash is a mismatch", () => {
    makeDist();
    const file = join(root, "dist", "checksums.txt");
    const bad = readFileSync(file, "utf8").trimEnd().split("\n").map((l, i) =>
      i === 0 ? `${"0".repeat(64)}  ${BINARIES[0]}` : l,
    );
    writeFileSync(file, bad.join("\n") + "\n");
    expect(checkArtifacts(root, VERSION)).toContain(`sha256 mismatch for ${BINARIES[0]}`);
  });

  test("an unlisted or unexpected artifact breaks one-to-one correspondence", () => {
    makeDist();
    const file = join(root, "dist", "installers", "checksums.txt");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, lines.slice(1).join("\n") + "\n"); // drop the first installer
    const problems = checkArtifacts(root, VERSION);
    expect(problems).toContain(`checksums file does not list ${INSTALLERS[0]}`);
  });

  test("a missing checksum file is reported", () => {
    makeDist();
    rmSync(join(root, "dist", "checksums.txt"));
    expect(checkArtifacts(root, VERSION)).toContain(`missing checksum file: ${join(root, "dist", "checksums.txt")}`);
  });

  rmSync(root, { recursive: true, force: true });
});
