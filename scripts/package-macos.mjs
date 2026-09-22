// Packages the macOS releases: .tar.gz tarballs with the binary and a
// launchd plist. Requires the build output in dist/ (run `bun run build:all`
// first, or use `bun run package:all` which builds everything in order).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTarGz } from "./lib/archiver.ts";
import { writeInstallerChecksums } from "./lib/checksums.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const outDir = join(dist, "installers");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

mkdirSync(outDir, { recursive: true });

// Asset names derive verbatim from the package.json version (which carries
// the prerelease suffix during the RC period) — nothing appends -rc.1.
const produced = [];
for (const arch of ["arm64", "x64"]) {
  const binPath = join(dist, `o2a2o-darwin-${arch}`);
  if (!existsSync(binPath)) {
    console.error(`dist/o2a2o-darwin-${arch} is missing; run \`bun run build:all\` first`);
    process.exit(1);
  }
  const tarball = writeTarGz([
    { name: "o2a2o", data: readFileSync(binPath), mode: 0o755 },
    { name: "com.o2a2o.plist", data: readFileSync(join(root, "packaging", "macos", "com.o2a2o.plist")), mode: 0o644 },
  ]);
  const tarPath = `o2a2o_v${version}_macos-${arch}.tar.gz`;
  writeFileSync(join(outDir, tarPath), tarball);
  produced.push(tarPath);
  console.log(`wrote dist/installers/${tarPath} (${tarball.length} bytes)`);
}

writeInstallerChecksums(outDir, produced);
