// Ensures the pinned nfpm binary is available under packaging/.tools/.
// Acquisition path verified in the M4 Task 1 spike: direct download of the
// v2.47.0 Windows x86_64 release zip (size + contents checked there), cached
// here and verified against the sha256 below on every use. Fallback (not
// automated): `go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractZipEntry } from "./archiver";

const NFPM_VERSION = "2.47.0";
const NFPM_ZIP_URL = `https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/nfpm_${NFPM_VERSION}_Windows_x86_64.zip`;
const NFPM_ZIP_SHA256 = "788f88a3bba0d89baa639aba54ba28b384958878700d440ce199a7ff4a567f11";

/** Path where ensureNfpm places (or finds) the nfpm executable. */
export function nfpmToolPath(root: string): string {
  return join(root, "packaging", ".tools", process.platform === "win32" ? "nfpm.exe" : "nfpm");
}

export async function ensureNfpm(root: string): Promise<string> {
  const exePath = nfpmToolPath(root);
  if (existsSync(exePath)) return exePath;

  const toolsDir = join(root, "packaging", ".tools");
  const zipPath = join(toolsDir, `nfpm_${NFPM_VERSION}_Windows_x86_64.zip`);
  mkdirSync(toolsDir, { recursive: true });

  let zip: Buffer;
  if (existsSync(zipPath)) {
    zip = readFileSync(zipPath);
  } else {
    console.log(`downloading ${NFPM_ZIP_URL}`);
    const res = await fetch(NFPM_ZIP_URL);
    if (!res.ok) throw new Error(`nfpm download failed: HTTP ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, zip);
  }

  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== NFPM_ZIP_SHA256) {
    throw new Error(`nfpm zip sha256 mismatch: expected ${NFPM_ZIP_SHA256}, got ${actual}`);
  }
  const exe = extractZipEntry(zip, "nfpm.exe");
  writeFileSync(exePath, exe, { mode: 0o755 });
  return exePath;
}
