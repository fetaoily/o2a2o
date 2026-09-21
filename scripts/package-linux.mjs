// Packages the Linux releases: deb + rpm via the pinned nfpm binary, plus
// self-contained .tar.gz tarballs (binary + systemd unit + install.sh).
// Requires the build output in dist/ (run `bun run build:all` first, or use
// `bun run package:all` which builds everything in order).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTarGz } from "./lib/archiver.ts";
import { ensureNfpm } from "./lib/nfpm.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const outDir = join(dist, "installers");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const nfpm = await ensureNfpm(root);
mkdirSync(outDir, { recursive: true });

// nfpm resolves the config's relative contents paths against its working
// directory, so run it from the repo root and stage one binary at a fixed
// path per run (keeps a single config file valid for both arches).
// Asset names use the Debian/Go "amd64" while build-all.mjs names the
// compiled binary with bun's "x64" — map them here.
const DIST_BINARY = { amd64: "o2a2o-linux-x64", arm64: "o2a2o-linux-arm64" };
const stagingDir = join(dist, ".staging");
mkdirSync(stagingDir, { recursive: true });

for (const arch of ["amd64", "arm64"]) {
  const binPath = join(dist, DIST_BINARY[arch]);
  if (!existsSync(binPath)) {
    console.error(`dist/${DIST_BINARY[arch]} is missing; run \`bun run build:all\` first`);
    process.exit(1);
  }
  copyFileSync(binPath, join(stagingDir, "o2a2o"));

  for (const packager of ["deb", "rpm"]) {
    const target = join(outDir, `o2a2o_v${version}-rc.1_linux-${arch}.${packager}`);
    const r = spawnSync(
      nfpm,
      ["package", "-f", "packaging/nfpm.yaml", "-p", packager, "-t", target],
      { stdio: "inherit", cwd: root, env: { ...process.env, NFPM_ARCH: arch, NFPM_VERSION: version } },
    );
    if (r.status !== 0) {
      console.error(`nfpm ${packager} ${arch} failed (exit ${r.status})`);
      process.exit(r.status ?? 1);
    }
  }

  const tarball = writeTarGz([
    { name: "o2a2o", data: readFileSync(binPath), mode: 0o755 },
    { name: "o2a2o.service", data: readFileSync(join(root, "packaging", "o2a2o.service")), mode: 0o644 },
    { name: "install.sh", data: readFileSync(join(root, "packaging", "linux", "install.sh")), mode: 0o755 },
  ]);
  const tarPath = `o2a2o_v${version}-rc.1_linux-${arch}.tar.gz`;
  writeFileSync(join(outDir, tarPath), tarball);
  console.log(`wrote dist/installers/${tarPath} (${tarball.length} bytes)`);
}
