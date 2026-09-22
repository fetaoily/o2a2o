// sha256sum writer for the installer packaging pipeline: one
// "<64-hex>  <basename>" line per listed installer, trailing newline.
// Basenames ONLY — the updater looks checksums up by bare asset name
// (src/update/update-manager.ts findChecksum), never by path. Each
// per-platform package script writes its own subset into
// dist/installers/checksums.txt so a per-platform CI job still produces a
// usable file; scripts/package-all.mjs overwrites it with the full set when
// run locally. Mirrors build-all.mjs's binary checksums format.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeInstallerChecksums(installersDir: string, fileNames: string[]): void {
  const lines = [...fileNames].sort().map((name) => {
    const hash = createHash("sha256").update(readFileSync(join(installersDir, name))).digest("hex");
    return `${hash}  ${name}`;
  });
  writeFileSync(join(installersDir, "checksums.txt"), `${lines.join("\n")}\n`);
}
