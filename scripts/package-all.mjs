// Full packaging pipeline: rebuild all five binaries (`bun run build:all`),
// then build every native installer into dist/installers/, and finally write
// dist/installers/checksums.txt (sha256sum format, one line per installer —
// the release/upload step consumes it). dist/checksums.txt stays binary-only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bun = process.execPath;

function run(script) {
  const r = spawnSync(bun, [join(root, "scripts", script)], { stdio: "inherit", cwd: root });
  if (r.status !== 0) {
    console.error(`${script} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

run("build-all.mjs");
run("package-windows.mjs");
run("package-linux.mjs");
run("package-macos.mjs");

const outDir = join(root, "dist", "installers");
const assets = readdirSync(outDir).filter((f) => f !== "checksums.txt").sort();
const lines = assets.map((name) => {
  const hash = createHash("sha256").update(readFileSync(join(outDir, name))).digest("hex");
  return `${hash}  ${name}`;
});
writeFileSync(join(outDir, "checksums.txt"), `${lines.join("\n")}\n`);
console.log(`wrote dist/installers/checksums.txt (${assets.length} assets)`);
