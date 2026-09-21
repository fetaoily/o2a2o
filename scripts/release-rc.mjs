// RC release orchestration (M4): reads the version from package.json, tags
// v<version>-rc.1, pushes the tag and publishes a GitHub prerelease carrying
// the built binaries, installers and checksum files.
//
// Pre-flight gates — ALL must pass, evaluated in order:
//   1. `bun test` is green
//   2. dist/ holds the five binaries and dist/installers/ the nine installers
//      under the names expected for the version (o2a2o_v<version>-rc.1_*)
//   3. dist/checksums.txt and dist/installers/checksums.txt exist, list
//      exactly the expected artifact set, every listed file exists and its
//      sha256 matches (one-to-one correspondence)
//   4. the tag exists neither locally (git rev-parse) nor as a GitHub
//      release (gh release view) — a pre-existing tag is a hard error, it is
//      never overwritten
//   5. the working tree has no uncommitted changes to tracked files
//      (untracked files such as IDE dirs are not release content)
//
// Network failure at any publish step reports BLOCKED-partial: prints what
// succeeded, ONE retry command, exits 1 — the script never retries on its
// own. `--resume` re-runs all gates, tolerates an already-created tag after
// verifying it still points at HEAD, and continues from the first incomplete
// publish step. A pre-existing GitHub release aborts in every mode.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dist/ binary names, build-all.mjs naming (bun "win32" spelled "windows").
export const BINARIES = [
  "o2a2o-darwin-arm64",
  "o2a2o-darwin-x64",
  "o2a2o-linux-arm64",
  "o2a2o-linux-x64",
  "o2a2o-windows-x64.exe",
];

// The nine installer names for a version, matching scripts/package-*.mjs
// (o2a2o_v<version>-rc.1_<platform>-<arch>.<ext>).
export function expectedInstallers(version) {
  const tag = `v${version}-rc.1`;
  return [
    `o2a2o_${tag}_windows-x64.zip`,
    `o2a2o_${tag}_linux-amd64.deb`,
    `o2a2o_${tag}_linux-arm64.deb`,
    `o2a2o_${tag}_linux-amd64.rpm`,
    `o2a2o_${tag}_linux-arm64.rpm`,
    `o2a2o_${tag}_linux-amd64.tar.gz`,
    `o2a2o_${tag}_linux-arm64.tar.gz`,
    `o2a2o_${tag}_macos-arm64.tar.gz`,
    `o2a2o_${tag}_macos-x64.tar.gz`,
  ];
}

// Parse sha256sum-format text ("<64 hex>  <name>" lines). Returns entries or
// null when the file is malformed.
export function parseChecksums(text) {
  const entries = [];
  for (const line of text.trimEnd().split("\n")) {
    if (line === "") continue;
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!m) return null;
    entries.push({ hash: m[1], name: m[2] });
  }
  return entries;
}

// Gate 4 evaluation is mode-aware: by default an existing local tag is an
// error; with --resume it is tolerated only when it still points at HEAD. A
// pre-existing GitHub release aborts in every mode.
export function evaluateGates(state) {
  const failures = [];
  if (!state.testsGreen) failures.push("gate 1: bun test is not green");
  if (state.artifactProblems.length > 0) {
    failures.push(
      `gates 2/3: artifacts or checksums failed validation:\n  - ${state.artifactProblems.join("\n  - ")}`,
    );
  }
  if (state.releaseExists) {
    failures.push(`gate 4: GitHub release ${state.tag} already exists — never overwritten`);
  }
  if (state.resume) {
    if (state.tagExistsLocal && !state.tagMatchesHead) {
      failures.push(`gate 4 (--resume): tag ${state.tag} exists locally but does not point at HEAD`);
    }
  } else if (state.tagExistsLocal) {
    failures.push(`gate 4: tag ${state.tag} already exists locally — it is never overwritten`);
  }
  if (!state.treeClean) {
    failures.push("gate 5: working tree has uncommitted changes to tracked files — commit or clean first");
  }
  return { ok: failures.length === 0, failures };
}

// Gates 2/3 against the real filesystem: returns a list of problems (empty
// means pass). dist/ must hold every binary, dist/installers/ every
// installer, and both checksum files must list exactly the expected artifact
// set with matching sha256 hashes.
export function checkArtifacts(root, version) {
  const problems = [];
  const dist = join(root, "dist");
  const installersDir = join(dist, "installers");
  for (const name of BINARIES) {
    if (!existsSync(join(dist, name))) problems.push(`missing binary: dist/${name}`);
  }
  for (const name of expectedInstallers(version)) {
    if (!existsSync(join(installersDir, name))) problems.push(`missing installer: dist/installers/${name}`);
  }
  problems.push(...checkChecksumsFile(dist, BINARIES));
  problems.push(...checkChecksumsFile(installersDir, expectedInstallers(version)));
  return problems;
}

function checkChecksumsFile(dir, expectedNames) {
  const file = join(dir, "checksums.txt");
  if (!existsSync(file)) return [`missing checksum file: ${file}`];
  const entries = parseChecksums(readFileSync(file, "utf8"));
  if (entries === null) return [`malformed checksum file: ${file} (expected "<64-hex sha256>  <name>" lines)`];
  const problems = [];
  const listed = new Set(entries.map((e) => e.name));
  for (const e of entries) {
    const p = join(dir, e.name);
    if (!existsSync(p)) {
      problems.push(`checksums file lists a missing file: ${e.name}`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (actual !== e.hash) problems.push(`sha256 mismatch for ${e.name}`);
  }
  for (const name of expectedNames) {
    if (!listed.has(name)) problems.push(`checksums file does not list ${name}`);
  }
  for (const name of listed) {
    if (!expectedNames.includes(name)) problems.push(`checksums file lists an unexpected artifact: ${name}`);
  }
  return problems;
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function run(cmd, args, step) {
  console.log(`[publish] ${step}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${step} failed (exit ${r.status})`);
}

function buildNotes(version, tag) {
  const bins = BINARIES.map((b) => `- \`${b}\``).join("\n");
  const insts = expectedInstallers(version).map((a) => `- \`${a}\``).join("\n");
  return `# o2a2o ${tag} (Release Candidate)

**RC for testing — not stable.** Release candidate for version ${version}, published for testing only.

## Binaries

${bins}

## Installers

${insts}

## Checksums

- \`checksums.txt\` — sha256 of the five binaries
- \`installers-checksums.txt\` — sha256 of the nine installers
- verified sha256 checksums in checksums.txt files (recomputed against the built artifacts before upload)
- to re-verify by hand run \`sha256sum -c checksums.txt\` from INSIDE the matching directory (\`dist/\` or \`dist/installers/\`) — entries are bare file names

## Updating an existing installation

The built-in \`o2a2o update\` command can consume this release when \`allow_prerelease: true\` is set under \`update\` in the config (the default). It picks the asset for the running platform and verifies it against \`checksums.txt\` before the atomic replace.
`;
}

function main() {
  const root = join(import.meta.dir, "..");
  process.chdir(root);
  const resume = process.argv.includes("--resume");
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const tag = `v${version}-rc.1`;
  console.log(`o2a2o RC release: version ${version} -> tag ${tag}${resume ? " (--resume)" : ""}`);

  // --- pre-flight gates (results collected, published only after all probes) ---
  console.log("[gate 1/5] bun test");
  const tests = spawnSync(process.execPath, ["test"], { stdio: "inherit" });
  const testsGreen = tests.status === 0;
  if (!testsGreen) console.error(`bun test exited ${tests.status}`);

  console.log("[gates 2/5 and 3/5] artifacts + checksums");
  const artifactProblems = checkArtifacts(root, version);
  if (artifactProblems.length === 0) {
    console.log("  all binaries, installers and checksum entries verified (sha256 recomputed)");
    console.log("  note: `sha256sum -c checksums.txt` must run from INSIDE each directory — dist/ and dist/installers/ list bare names");
  } else {
    for (const p of artifactProblems) console.error(`  - ${p}`);
  }

  console.log("[gate 4/5] tag/uniqueness probes");
  const tagExistsLocal = sh("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).ok;
  const view = sh("gh", ["release", "view", tag, "--json", "name"]);
  let releaseExists = false;
  let probeError = null;
  if (view.ok) releaseExists = true;
  else if (!/not found|not known/i.test(view.stderr)) {
    probeError = `cannot determine whether GitHub release ${tag} exists: ${view.stderr}`;
  }
  let tagMatchesHead = false;
  if (tagExistsLocal) {
    const head = sh("git", ["rev-parse", "HEAD"]).stdout;
    tagMatchesHead = head !== "" && head === sh("git", ["rev-parse", `${tag}^{commit}`]).stdout;
  }
  console.log(`  local tag: ${tagExistsLocal ? (tagMatchesHead ? "exists at HEAD" : "exists at another commit") : "absent"}`);
  console.log(`  GitHub release: ${releaseExists ? "EXISTS" : probeError ?? "absent"}`);

  console.log("[gate 5/5] clean tree (tracked files)");
  const treeClean = sh("git", ["status", "--porcelain", "--untracked-files=no"]).stdout === "";
  console.log(`  working tree: ${treeClean ? "clean" : "has uncommitted tracked changes"}`);

  const verdict = evaluateGates({ testsGreen, artifactProblems, tag, tagExistsLocal, tagMatchesHead, releaseExists, treeClean, resume });
  if (probeError) verdict.failures.push(probeError);
  if (!verdict.ok) {
    console.error("\npre-flight gates FAILED — nothing was published:");
    for (const f of verdict.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("all pre-flight gates passed\n");

  // --- publish: tag -> push tag -> gh release create (BLOCKED-partial aware) ---
  const done = { tagCreated: false, pushed: false, released: false };
  const tmp = mkdtempSync(join(tmpdir(), "o2a2o-release-"));
  try {
    if (resume && tagExistsLocal) {
      console.log(`[publish] tag ${tag} already exists at HEAD — skipping creation (--resume)`);
      done.tagCreated = true;
    } else {
      run("git", ["tag", tag], "create tag");
      done.tagCreated = true;
    }
    run("git", ["push", "origin", tag], "push tag");
    done.pushed = true;

    const notesFile = join(tmp, "notes.md");
    writeFileSync(notesFile, buildNotes(version, tag));
    // dist/installers/checksums.txt shares its basename with dist/checksums.txt;
    // release asset names are basenames, so the installer sums go up under a
    // distinct name from a temp copy (referenced in the release notes).
    const installerSums = join(tmp, "installers-checksums.txt");
    copyFileSync(join(root, "dist", "installers", "checksums.txt"), installerSums);
    const assets = [
      ...BINARIES.map((b) => join(root, "dist", b)),
      join(root, "dist", "checksums.txt"),
      ...expectedInstallers(version).map((a) => join(root, "dist", "installers", a)),
      installerSums,
    ];
    run(
      "gh",
      [
        "release", "create", tag,
        "--prerelease",
        "--title", `${tag} (Release Candidate)`,
        "--notes-file", notesFile,
        ...assets,
      ],
      "create release",
    );
    done.released = true;
  } catch (err) {
    console.error(`\nPUBLISH FAILED: ${err.message}`);
    console.error(`succeeded steps: tagCreated=${done.tagCreated} pushed=${done.pushed} released=${done.released} — BLOCKED-partial`);
    const retry = !done.tagCreated
      ? "bun scripts/release-rc.mjs"
      : !done.pushed
        ? `git push origin ${tag} && bun scripts/release-rc.mjs --resume`
        : "bun scripts/release-rc.mjs --resume";
    console.error(`retry ONCE with:\n  ${retry}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  rmSync(tmp, { recursive: true, force: true });

  // --- post-publish verification ---
  const check = sh("gh", ["release", "view", tag, "--json", "isPrerelease,assets,url"]);
  if (!check.ok) {
    console.error(`post-publish verification could not read the release: ${check.stderr}`);
    process.exit(1);
  }
  const info = JSON.parse(check.stdout);
  const expectedCount = BINARIES.length + 1 + expectedInstallers(version).length + 1;
  console.log(`\nrelease URL: ${info.url}`);
  console.log(`isPrerelease: ${info.isPrerelease}`);
  console.log(`assets: ${info.assets.length}/${expectedCount}`);
  if (info.isPrerelease !== true || info.assets.length !== expectedCount) {
    console.error("post-publish verification FAILED");
    process.exit(1);
  }
  console.log("post-publish verification passed");
}

if (import.meta.main) main();
