// Packages the Windows release: zip with the binary, install.ps1 and a README.
// Requires the build output in dist/ (run `bun run build:all` first, or use
// `bun run package:all` which builds everything in order).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip } from "./lib/archiver.ts";
import { writeInstallerChecksums } from "./lib/checksums.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const outDir = join(dist, "installers");
const binary = join(dist, "o2a2o-windows-x64.exe");

if (!existsSync(binary)) {
  console.error("dist/o2a2o-windows-x64.exe is missing; run `bun run build:all` first");
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// Asset names derive verbatim from the package.json version (which carries
// the prerelease suffix during the RC period) — nothing appends -rc.1.
const asset = `o2a2o_v${version}_windows-x64.zip`;

mkdirSync(outDir, { recursive: true });
const zip = writeZip([
  { name: "o2a2o-windows-x64.exe", data: readFileSync(binary), mode: 0o755 },
  { name: "install.ps1", data: readFileSync(join(root, "packaging", "windows", "install.ps1")), mode: 0o644 },
  { name: "README.md", data: readFileSync(join(root, "packaging", "windows", "README.md")), mode: 0o644 },
]);
writeFileSync(join(outDir, asset), zip);
writeInstallerChecksums(outDir, [asset]);
console.log(`wrote dist/installers/${asset} (${zip.length} bytes)`);
