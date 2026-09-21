// Ensures the pinned nfpm binary is available under packaging/.tools/.
// Acquisition paths verified against the official nfpm v2.47.0 checksums.txt
// (downloaded from the release and every archive's sha256 cross-checked):
// Windows x86_64 zip in the M4 Task 1 spike, Linux x86_64/arm64 tarballs in
// the CI pivot. Cached under packaging/.tools/ and verified against the
// sha256 below on every use. Fallback (not automated):
// `go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractTarGzEntry, extractZipEntry } from "./archiver";

const NFPM_VERSION = "2.47.0";
const NFPM_BASE = `https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}`;

interface NfpmAsset {
  /** Release asset file name (also the cache file name). */
  file: string;
  /** sha256 of the archive, from the official nfpm checksums.txt. */
  sha256: string;
  /** Binary member name inside the archive. */
  member: string;
}

// key: `${process.platform}-${process.arch}`
const NFPM_ASSETS: Record<string, NfpmAsset> = {
  "win32-x64": {
    file: `nfpm_${NFPM_VERSION}_Windows_x86_64.zip`,
    sha256: "788f88a3bba0d89baa639aba54ba28b384958878700d440ce199a7ff4a567f11",
    member: "nfpm.exe",
  },
  "linux-x64": {
    file: `nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz`,
    sha256: "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783",
    member: "nfpm",
  },
  "linux-arm64": {
    file: `nfpm_${NFPM_VERSION}_Linux_arm64.tar.gz`,
    sha256: "1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c",
    member: "nfpm",
  },
};

/** Path where ensureNfpm places (or finds) the nfpm executable. */
export function nfpmToolPath(root: string): string {
  return join(root, "packaging", ".tools", process.platform === "win32" ? "nfpm.exe" : "nfpm");
}

export async function ensureNfpm(root: string): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const asset = NFPM_ASSETS[key];
  if (!asset) {
    throw new Error(`nfpm auto-download is not supported on ${key} (available: ${Object.keys(NFPM_ASSETS).join(", ")})`);
  }

  const exePath = nfpmToolPath(root);
  if (existsSync(exePath)) return exePath;

  const toolsDir = join(root, "packaging", ".tools");
  const archivePath = join(toolsDir, asset.file);
  mkdirSync(toolsDir, { recursive: true });

  let archive: Buffer;
  let cached = false;
  if (existsSync(archivePath)) {
    archive = readFileSync(archivePath);
    cached = true;
  } else {
    const url = `${NFPM_BASE}/${asset.file}`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`nfpm download failed: HTTP ${res.status}`);
    archive = Buffer.from(await res.arrayBuffer());
  }

  // Verify before caching: a poisoned 200-response never lands in the cache,
  // and a cached file is re-verified on every use.
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(`nfpm archive sha256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}`);
  }
  if (!cached) writeFileSync(archivePath, archive);

  const exe = asset.file.endsWith(".zip") ? extractZipEntry(archive, asset.member) : extractTarGzEntry(archive, asset.member);
  writeFileSync(exePath, exe, { mode: 0o755 });
  return exePath;
}
