// UpdateManager: the self-update core (TECH-DESIGN §11). Downloads a release
// asset, verifies it against the release checksums file, then swaps the
// binary: backup -> atomic rename replace -> self-verify via
// `<binary> --version`. Any verification failure restores the exact original
// bytes. All network I/O goes through fetchFn and all process spawning
// through spawnFn so tests run fully offline.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { error, log, warn } from "../utils/logger";
import { fetchLatestRelease, type ReleaseInfo } from "./github-releases";

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type SpawnFn = (cmd: string, args: string[]) => SpawnResult;

export interface UpdateResult {
  ok: boolean;
  rolledBack: boolean;
}

export interface UpdateManagerOpts {
  repo: string;
  currentVersion: string;
  binaryPath: string;
  allowPrerelease: boolean;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
  now?: () => Date;
  /** Test seam: defaults to node:fs renameSync; lets tests inject mid-rename failures. */
  renameFn?: (from: string, to: string) => void;
}

function defaultSpawnFn(cmd: string, args: string[]): SpawnResult {
  const r = spawnSync(cmd, args, { timeout: 10_000 });
  return { status: r.status, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function assetFileName(url: string): string {
  return url.split("/").pop() ?? "";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Locate "<hash>  <fileName>" in a sha256sum-style checksums text.
function findChecksum(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  return null;
}

// Identity probe for the CLI update preflight: true only when binaryPath is
// an o2a2o binary, i.e. its `--version` output carries the brand. IDENTITY
// only, deliberately NOT a version comparison — an older o2a2o binary is a
// legitimate update source, so its stale version still passes.
export function identifiesAsO2a2o(binaryPath: string, spawnFn: SpawnFn = defaultSpawnFn): boolean {
  const r = spawnFn(binaryPath, ["--version"]);
  return r.status === 0 && r.stdout.includes("o2a2o");
}

export class UpdateManager {
  // Timestamp of the last check() call (from `now` when provided).
  lastCheckAt: Date | null = null;
  private opts: UpdateManagerOpts;

  constructor(opts: UpdateManagerOpts) {
    this.opts = opts;
  }

  check(): Promise<ReleaseInfo | null> {
    this.lastCheckAt = this.opts.now ? this.opts.now() : new Date();
    return fetchLatestRelease(this.opts.repo, {
      allowPrerelease: this.opts.allowPrerelease,
      currentVersion: this.opts.currentVersion,
      fetchFn: this.opts.fetchFn,
    });
  }

  async update(rel: ReleaseInfo): Promise<UpdateResult> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const spawnFn = this.opts.spawnFn ?? defaultSpawnFn;
    const renameFn = this.opts.renameFn ?? renameSync;
    const binaryPath = this.opts.binaryPath;
    const newPath = binaryPath + ".new";
    const backupPath = binaryPath + ".backup";
    const oldPath = binaryPath + ".old";
    // True once the original binary is no longer at binaryPath (Windows
    // rename-aside done, or the POSIX rename applied). From that moment any
    // failure must end in a rollback attempt.
    let originalMoved = false;

    // Undo an applied replace atomically: park the failed binary at .new,
    // then rename the original back. After the Windows branch the original
    // sits in .old; after the POSIX branch only the .backup copy exists.
    // If the replace died between the two Windows renames, binaryPath is
    // missing and the original is still in .old — restore from whichever
    // recovery copy exists before anything is deleted.
    const restoreOriginal = (): void => {
      if (existsSync(binaryPath)) {
        rmSync(newPath, { force: true });
        renameFn(binaryPath, newPath);
      }
      if (existsSync(oldPath)) renameFn(oldPath, binaryPath);
      else renameFn(backupPath, binaryPath);
    };

    // restoreOriginal plus temp cleanup. Temps are removed only after a
    // successful restore — after a failed one they hold the only remaining
    // original bytes. Returns whether the original was actually restored.
    const rollback = (): boolean => {
      try {
        restoreOriginal();
      } catch (e) {
        error(
          `rollback failed, keeping recovery copies ${newPath}, ${oldPath}, ${backupPath}: ${errorMessage(e)}`,
        );
        return false;
      }
      rmSync(newPath, { force: true });
      rmSync(oldPath, { force: true });
      rmSync(backupPath, { force: true });
      return true;
    };

    try {
      // 1. the release must publish a checksums file (SHA256 is mandatory):
      //    without one we refuse rather than install unverified bytes
      if (!rel.sha256Url) {
        warn(`update to ${rel.version}: release has no checksums asset, refusing unverified update`);
        return { ok: false, rolledBack: false };
      }

      // 2. download the new binary to <binaryPath>.new
      const assetResp = await fetchFn(rel.assetUrl);
      if (!assetResp.ok) throw new Error(`asset download failed: HTTP ${assetResp.status}`);
      const bytes = new Uint8Array(await assetResp.arrayBuffer());
      writeFileSync(newPath, bytes);

      // 3. verify against the checksums file; a missing line or a hash
      //    mismatch aborts before the current binary is ever touched
      const sumsResp = await fetchFn(rel.sha256Url);
      if (!sumsResp.ok) throw new Error(`checksum download failed: HTTP ${sumsResp.status}`);
      const expected = findChecksum(await sumsResp.text(), assetFileName(rel.assetUrl));
      if (expected === null || expected !== sha256Hex(bytes)) {
        warn(`update to ${rel.version}: checksum mismatch, keeping current binary`);
        rmSync(newPath, { force: true });
        return { ok: false, rolledBack: false };
      }

      // 4. backup the current binary
      copyFileSync(binaryPath, backupPath);

      // 5. atomic replace; a running Windows exe cannot be overwritten but
      //    can be renamed, so move it aside first (TECH-DESIGN §11)
      if (process.platform === "win32") {
        renameFn(binaryPath, oldPath);
        originalMoved = true; // the original now exists only at .old
        renameFn(newPath, binaryPath);
      } else {
        renameFn(newPath, binaryPath);
        originalMoved = true;
      }

      // 6. self-verify: the new binary must run and report the new version
      const r = spawnFn(binaryPath, ["--version"]);
      if (r.status !== 0 || !r.stdout.includes(rel.version)) {
        warn(`update to ${rel.version}: self-verify failed (exit ${r.status}), rolling back`);
        return { ok: false, rolledBack: rollback() };
      }

      // 7. success: clean up temps and backups
      rmSync(oldPath, { force: true });
      rmSync(backupPath, { force: true });
      log(`updated to ${rel.version}`);
      return { ok: true, rolledBack: false };
    } catch (e) {
      error(`update to ${rel.version} failed: ${errorMessage(e)}`);
      if (!originalMoved) {
        // the current binary was never touched; drop the temp download
        rmSync(newPath, { force: true });
        return { ok: false, rolledBack: false };
      }
      return { ok: false, rolledBack: rollback() };
    }
  }
}
