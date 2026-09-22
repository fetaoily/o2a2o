// Unit tests for scripts/lib/checksums.ts: the sha256sum writer used by the
// per-platform package scripts (and, with the full set, by package-all.mjs).
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstallerChecksums } from "../scripts/lib/checksums";

function sha256(data: string): string {
  return createHash("sha256").update(Buffer.from(data, "latin1")).digest("hex");
}

test("writeInstallerChecksums writes exact <hex>  <basename> lines with a trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "o2a2o-sums-"));
  try {
    writeFileSync(join(dir, "o2a2o_v1_windows-x64.zip"), Buffer.from("win-bytes", "latin1"));
    writeFileSync(join(dir, "o2a2o_v1_linux-amd64.deb"), Buffer.from("deb-bytes", "latin1"));
    // a file NOT in the list must never appear in the output
    writeFileSync(join(dir, "stray.txt"), Buffer.from("ignore me", "latin1"));

    writeInstallerChecksums(dir, ["o2a2o_v1_windows-x64.zip", "o2a2o_v1_linux-amd64.deb"]);

    const text = readFileSync(join(dir, "checksums.txt"), "utf8");
    // basenames only (the updater looks checksums up by bare asset name),
    // sorted deterministically, two spaces between hash and name, \n-terminated
    expect(text).toBe(
      `${sha256("deb-bytes")}  o2a2o_v1_linux-amd64.deb\n` +
      `${sha256("win-bytes")}  o2a2o_v1_windows-x64.zip\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeInstallerChecksums overwrites a previous checksums.txt instead of appending", () => {
  const dir = mkdtempSync(join(tmpdir(), "o2a2o-sums-"));
  try {
    writeFileSync(join(dir, "a.bin"), Buffer.from("aaa", "latin1"));
    writeFileSync(join(dir, "b.bin"), Buffer.from("bbb", "latin1"));
    writeInstallerChecksums(dir, ["a.bin"]);
    writeInstallerChecksums(dir, ["b.bin"]);
    expect(readFileSync(join(dir, "checksums.txt"), "utf8")).toBe(`${sha256("bbb")}  b.bin\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
