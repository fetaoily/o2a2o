// Packaging tests: assert the OUTPUTS of scripts/package-*.mjs (the files in
// dist/installers/), not the scripts themselves. Zip/tar assertions are pure
// JS (scripts/lib/archiver.ts readers); deb/rpm assertions only check file
// existence, naming and size — and are skipped when the nfpm tool is absent
// (platform/tool availability guard).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractZipEntry, readTarGzEntries, readZipEntries } from "../scripts/lib/archiver";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const installers = join(dist, "installers");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const v = `v${pkg.version}-rc.1`;

const EXPECTED_ASSETS = [
  `o2a2o_${v}_windows-x64.zip`,
  `o2a2o_${v}_linux-amd64.deb`,
  `o2a2o_${v}_linux-arm64.deb`,
  `o2a2o_${v}_linux-amd64.rpm`,
  `o2a2o_${v}_linux-arm64.rpm`,
  `o2a2o_${v}_linux-amd64.tar.gz`,
  `o2a2o_${v}_linux-arm64.tar.gz`,
  `o2a2o_${v}_macos-arm64.tar.gz`,
  `o2a2o_${v}_macos-x64.tar.gz`,
];

// nfpm availability guard: deb/rpm are produced by the pinned nfpm binary in
// packaging/.tools/ (downloaded by scripts/package-linux.mjs) or a system nfpm.
const nfpmTool = join(root, "packaging", ".tools", process.platform === "win32" ? "nfpm.exe" : "nfpm");
const nfpmAvailable = existsSync(nfpmTool);

const isExec = (mode: number) => (mode & 0o111) !== 0;

// CI runners check out the repo without a build; every test below asserts
// real dist/ artifacts, so the whole file only runs where dist/installers
// exists (produce it locally with `bun run build:all && bun run package:all`).
const distPresent = existsSync(installers);

describe.skipIf(!distPresent)("installer asset set", () => {
  test("dist/installers contains exactly the nine RC assets", () => {
    const files = readdirSync(installers).filter((f) => f !== "checksums.txt").sort();
    expect(files).toEqual([...EXPECTED_ASSETS].sort());
  });

  test("every installer is nonzero", () => {
    for (const asset of EXPECTED_ASSETS) {
      expect(statSync(join(installers, asset)).size).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!distPresent)("windows zip", () => {
  const zipPath = () => readFileSync(join(installers, `o2a2o_${v}_windows-x64.zip`));

  test("contains the binary, install.ps1 and README", () => {
    const names = readZipEntries(zipPath()).map((e) => e.name);
    expect(names).toContain("o2a2o-windows-x64.exe");
    expect(names).toContain("install.ps1");
    expect(names).toContain("README.md");
  });

  test("zip member holds the full windows binary (size and exec mode)", () => {
    const exe = readZipEntries(zipPath()).find((e) => e.name === "o2a2o-windows-x64.exe");
    expect(exe).toBeDefined();
    expect(isExec(exe!.mode)).toBe(true);
    const distBinary = statSync(join(dist, "o2a2o-windows-x64.exe"));
    expect(exe!.size).toBe(distBinary.size);
  });

  test("install.ps1 supports the default per-user install dir and -AddToPath", () => {
    const script = extractZipEntry(zipPath(), "install.ps1").toString("utf8");
    expect(script).toContain("AddToPath");
    expect(script).toContain("LOCALAPPDATA");
  });
});

describe.skipIf(!distPresent)("linux deb/rpm", () => {
  const packages = EXPECTED_ASSETS.filter((a) => a.endsWith(".deb") || a.endsWith(".rpm"));

  test.skipIf(!nfpmAvailable)("deb and rpm files exist with nonzero size", () => {
    for (const asset of packages) {
      const path = join(installers, asset);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
  });

  // ar-level structural check (pure JS, names only): a deb is an ar archive
  // carrying the three canonical members. The inner tars may be compressed
  // with any codec, so only member NAMES are asserted, never decompressed.
  function arMemberNames(deb: Buffer): string[] {
    expect(deb.subarray(0, 8).toString("utf8")).toBe("!<arch>\n");
    const names: string[] = [];
    let off = 8;
    while (off + 60 <= deb.length) {
      names.push(deb.toString("utf8", off, off + 16).trim());
      const size = parseInt(deb.toString("utf8", off + 48, off + 58).trim(), 10);
      if (!Number.isFinite(size) || size < 0) throw new Error(`ar: bad member size at offset ${off}`);
      off += 60 + size + (size % 2);
    }
    // members must tile the file exactly — catches truncated archives whose
    // headers all survived
    expect(off).toBe(deb.length);
    return names;
  }

  test.skipIf(!nfpmAvailable)("deb has canonical ar members (debian-binary, control.tar*, data.tar*)", () => {
    for (const arch of ["amd64", "arm64"] as const) {
      const names = arMemberNames(readFileSync(join(installers, `o2a2o_${v}_linux-${arch}.deb`)));
      expect(names).toContain("debian-binary");
      expect(names.some((n) => n.startsWith("control.tar"))).toBe(true);
      expect(names.some((n) => n.startsWith("data.tar"))).toBe(true);
    }
  });
});

describe.skipIf(!distPresent)("linux tarballs", () => {
  // asset arch name (amd64) -> build-all.mjs binary name (x64)
  const DIST_BINARY = { amd64: "o2a2o-linux-x64", arm64: "o2a2o-linux-arm64" } as const;
  for (const arch of ["amd64", "arm64"] as const) {
    test(`${arch}: contains binary + o2a2o.service + install.sh`, () => {
      const gz = readFileSync(join(installers, `o2a2o_${v}_linux-${arch}.tar.gz`));
      const entries = readTarGzEntries(gz);
      const byName = new Map(entries.map((e) => [e.name, e]));
      expect([...byName.keys()].sort()).toEqual(["install.sh", "o2a2o", "o2a2o.service"]);

      const bin = byName.get("o2a2o")!;
      expect(isExec(bin.mode)).toBe(true);
      expect(bin.size).toBe(statSync(join(dist, DIST_BINARY[arch])).size);

      const unit = byName.get("o2a2o.service")!;
      expect(isExec(unit.mode)).toBe(false);
      expect(unit.size).toBeGreaterThan(0);

      const install = byName.get("install.sh")!;
      expect(isExec(install.mode)).toBe(true);
    });
  }
});

describe.skipIf(!distPresent)("macos tarballs", () => {
  for (const arch of ["arm64", "x64"] as const) {
    test(`${arch}: contains binary + launchd plist`, () => {
      const gz = readFileSync(join(installers, `o2a2o_${v}_macos-${arch}.tar.gz`));
      const entries = readTarGzEntries(gz);
      const byName = new Map(entries.map((e) => [e.name, e]));
      expect([...byName.keys()].sort()).toEqual(["com.o2a2o.plist", "o2a2o"]);

      const bin = byName.get("o2a2o")!;
      expect(isExec(bin.mode)).toBe(true);
      expect(bin.size).toBe(statSync(join(dist, `o2a2o-darwin-${arch}`)).size);

      const plist = byName.get("com.o2a2o.plist")!;
      expect(isExec(plist.mode)).toBe(false);
      expect(plist.size).toBeGreaterThan(0);
    });
  }
});

describe.skipIf(!distPresent)("installer checksums", () => {
  test("dist/installers/checksums.txt lists every asset with its real sha256", () => {
    const text = readFileSync(join(installers, "checksums.txt"), "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(EXPECTED_ASSETS.length);
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{64})  (.+)$/);
      expect(m).not.toBeNull();
      const [, hash, name] = m!;
      expect(EXPECTED_ASSETS).toContain(name);
      const actual = createHash("sha256").update(readFileSync(join(installers, name))).digest("hex");
      expect(hash).toBe(actual);
    }
  });
});
