// Cross-platform release build driver: compiles the CLI for all five release
// targets into dist/ and writes dist/checksums.txt in sha256sum format
// ("<hash>  <filename>" lines). Run via `bun run build:all`; `--checksums`
// skips compilation and only (re)generates checksums for existing artifacts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bun compile targets; the windows output needs the .exe suffix.
const TARGETS = [
  { target: "bun-darwin-arm64", out: "o2a2o-darwin-arm64" },
  { target: "bun-darwin-x64", out: "o2a2o-darwin-x64" },
  { target: "bun-linux-arm64", out: "o2a2o-linux-arm64" },
  { target: "bun-linux-x64", out: "o2a2o-linux-x64" },
  { target: "bun-windows-x64", out: "o2a2o-windows-x64.exe" },
];

const distDir = join(process.cwd(), "dist");
// process.execPath is the bun binary whenever this script is launched with bun.
const bun = process.execPath;

function build() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  for (const { target, out } of TARGETS) {
    console.log(`building ${target} -> dist/${out}`);
    const r = spawnSync(
      bun,
      ["build", "--compile", `--target=${target}`, "--outfile", join(distDir, out), "src/index.ts"],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      console.error(`build failed for ${target} (exit ${r.status})`);
      process.exit(r.status ?? 1);
    }
  }
}

function checksums() {
  const lines = TARGETS.map(({ out }) => {
    const buf = readFileSync(join(distDir, out));
    return `${createHash("sha256").update(buf).digest("hex")}  ${out}`;
  });
  writeFileSync(join(distDir, "checksums.txt"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

if (process.argv.includes("--checksums")) checksums();
else {
  build();
  checksums();
}
