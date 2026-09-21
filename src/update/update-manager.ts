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
    const binaryPath = this.opts.binaryPath;
    const newPath = binaryPath + ".new";
    const backupPath = binaryPath + ".backup";
    const oldPath = binaryPath + ".old";
    let replaced = false;

    // Undo an applied replace atomically: move the failed binary aside, then
    // rename the original back. After the Windows branch the original sits in
    // .old; after the POSIX branch only the .backup copy exists.
    const restoreOriginal = (): void => {
      rmSync(newPath, { force: true });
      renameSync(binaryPath, newPath);
      if (existsSync(oldPath)) renameSync(oldPath, binaryPath);
      else renameSync(backupPath, binaryPath);
    };

    try {
      // 1. download the new binary to <binaryPath>.new
      const assetResp = await fetchFn(rel.assetUrl);
      if (!assetResp.ok) throw new Error(`asset download failed: HTTP ${assetResp.status}`);
      const bytes = new Uint8Array(await assetResp.arrayBuffer());
      writeFileSync(newPath, bytes);

      // 2. verify against the release checksums file; a missing line or a
      //    hash mismatch aborts before the current binary is ever touched
      if (rel.sha256Url) {
        const sumsResp = await fetchFn(rel.sha256Url);
        if (!sumsResp.ok) throw new Error(`checksum download failed: HTTP ${sumsResp.status}`);
        const expected = findChecksum(await sumsResp.text(), assetFileName(rel.assetUrl));
        if (expected === null || expected !== sha256Hex(bytes)) {
          warn(`update to ${rel.version}: checksum mismatch, keeping current binary`);
          rmSync(newPath, { force: true });
          return { ok: false, rolledBack: false };
        }
      }

      // 3. backup the current binary
      copyFileSync(binaryPath, backupPath);

      // 4. atomic replace; a running Windows exe cannot be overwritten but
      //    can be renamed, so move it aside first (TECH-DESIGN §11)
      if (process.platform === "win32") {
        renameSync(binaryPath, oldPath);
        renameSync(newPath, binaryPath);
      } else {
        renameSync(newPath, binaryPath);
      }
      replaced = true;

      // 5. self-verify: the new binary must run and report the new version
      const r = spawnFn(binaryPath, ["--version"]);
      if (r.status !== 0 || !r.stdout.includes(rel.version)) {
        warn(`update to ${rel.version}: self-verify failed (exit ${r.status}), rolling back`);
        restoreOriginal();
        // restoreOriginal parks the failed binary at .new; drop it and the
        // now-redundant backup (force: whichever of them the rename consumed).
        rmSync(newPath, { force: true });
        rmSync(backupPath, { force: true });
        return { ok: false, rolledBack: true };
      }

      // 6. success: clean up temps and backups
      rmSync(oldPath, { force: true });
      rmSync(backupPath, { force: true });
      log(`updated to ${rel.version}`);
      return { ok: true, rolledBack: false };
    } catch (e) {
      error(`update to ${rel.version} failed: ${errorMessage(e)}`);
      if (replaced) {
        try {
          restoreOriginal();
        } catch (restoreErr) {
          error(`rollback failed: ${errorMessage(restoreErr)}`);
        }
      }
      rmSync(newPath, { force: true });
      rmSync(oldPath, { force: true });
      rmSync(backupPath, { force: true });
      return { ok: false, rolledBack: replaced };
    }
  }
}
