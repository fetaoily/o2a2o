// Manual RC release fallback (M4): the normal path is pushing a v* tag and
// letting .github/workflows/release.yml build and publish the prerelease on
// CI. This script only performs the safe local part of that atom:
//
//   gates:  1. `bun test` is green
//           2. the tag exists neither locally (git rev-parse) nor as a
//              GitHub release (gh release view) — never overwritten
//           3. the working tree has no uncommitted changes to tracked files
//   publish: git tag v<version>-rc.1  ->  git push origin <tag>  (triggers CI)
//
// No artifacts are built or uploaded here; CI owns that. On failure the
// script prints what succeeded plus a single retry command and exits 1 — it
// never retries on its own. `--resume` re-runs all gates, tolerates an
// already-created tag after verifying it still points at HEAD, and continues
// from the first incomplete publish step.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGates } from "./lib/release-gates.ts";

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function run(cmd, args, step) {
  console.log(`[publish] ${step}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${step} failed (exit ${r.status})`);
}

function originActionsUrl() {
  // https://github.com/<owner>/<repo>[.git] -> actions URL of the release workflow
  const url = sh("git", ["remote", "get-url", "origin"]).stdout;
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/actions/workflows/release.yml` : null;
}

function main() {
  const root = join(import.meta.dir, "..");
  process.chdir(root);
  const resume = process.argv.includes("--resume");
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const tag = `v${version}-rc.1`;
  console.log(`o2a2o RC release (tag + CI trigger): version ${version} -> tag ${tag}${resume ? " (--resume)" : ""}`);

  // --- pre-flight gates ---
  console.log("[gate 1/3] bun test");
  const tests = spawnSync(process.execPath, ["test"], { stdio: "inherit" });
  const testsGreen = tests.status === 0;
  if (!testsGreen) console.error(`bun test exited ${tests.status}`);

  console.log("[gate 2/3] tag/uniqueness probes");
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

  console.log("[gate 3/3] clean tree (tracked files)");
  const treeClean = sh("git", ["status", "--porcelain", "--untracked-files=no"]).stdout === "";
  console.log(`  working tree: ${treeClean ? "clean" : "has uncommitted tracked changes"}`);

  const verdict = evaluateGates({ tag, testsGreen, tagExistsLocal, tagMatchesHead, releaseExists, treeClean, resume });
  if (probeError) verdict.failures.push(probeError);
  if (!verdict.ok) {
    console.error("\npre-flight gates FAILED — nothing was tagged or pushed:");
    for (const f of verdict.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("all pre-flight gates passed\n");

  // --- publish: tag -> push (CI does the rest) ---
  const done = { tagCreated: false, pushed: false };
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
  } catch (err) {
    console.error(`\nPUBLISH FAILED: ${err.message}`);
    console.error(`succeeded steps: tagCreated=${done.tagCreated} pushed=${done.pushed} — BLOCKED-partial`);
    const retry = !done.tagCreated
      ? "bun scripts/release-rc.mjs"
      : "bun scripts/release-rc.mjs --resume";
    console.error(`retry ONCE with:\n  ${retry}`);
    process.exit(1);
  }

  const url = originActionsUrl();
  console.log(`\ntag ${tag} pushed — release.yml is now building the prerelease on CI`);
  if (url) console.log(`watch: ${url}\nwatch run: gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`);
}

if (import.meta.main) main();
