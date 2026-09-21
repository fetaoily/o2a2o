// UpdateManager tests: fully offline. A local Bun.serve mocks the GitHub
// releases API and serves asset/checksum bytes; spawnFn is stubbed; the
// binary under update is a real file in a temp dir, so the checksum,
// backup, rename-replace and rollback paths run for real on this platform.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  fetchLatestRelease,
  platformAssetName,
  type ReleaseInfo,
} from "../../src/update/github-releases";
import { UpdateManager, type SpawnFn } from "../../src/update/update-manager";

// --- offline mock: GitHub releases API + asset bytes -------------------

const ASSET = platformAssetName();
const ORIGINAL = "CURRENT-BINARY-BYTES-0.3.0";
const NEW_TEXT = "#!/o2a2o-mock\nO2A2O-MOCK-NEW-BINARY-0.4.0\n";
const NEW_BYTES = new TextEncoder().encode(NEW_TEXT);
const NEW_HASH = createHash("sha256").update(NEW_BYTES).digest("hex");

interface MockAsset {
  name: string;
  browser_download_url: string;
}
interface MockRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: MockAsset[];
}

const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: 0,
  fetch(req) {
    // GitHub path shape: /repos/{owner}/{repo}/releases
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    if (parts[0] === "repos" && parts[3] === "releases") {
      return Response.json([
        releaseJson("v0.5.0-rc.1", true, false),
        releaseJson("v0.9.0", false, true), // draft: must never be offered
        releaseJson("v0.4.0", false, false),
        releaseJson("v0.3.1", false, false),
        releaseJson("v0.3.0-rc.2", true, false),
      ]);
    }
    if (parts[0] === "download") {
      const file = parts[parts.length - 1];
      if (file === ASSET) return new Response(NEW_BYTES);
      if (file === "checksums.txt") return new Response(checksumsFor(parts[parts.length - 2]));
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE: string = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function releaseJson(tag: string, prerelease: boolean, draft: boolean): MockRelease {
  return {
    tag_name: tag,
    prerelease,
    draft,
    assets: [
      { name: ASSET, browser_download_url: `${BASE}/download/${tag}/${ASSET}` },
      { name: "checksums.txt", browser_download_url: `${BASE}/download/${tag}/checksums.txt` },
    ],
  };
}

// fetchFn stub: rewrites the hardcoded api.github.com URL onto the local mock
// and lets every other URL (asset/checksum downloads) pass through unchanged.
// Nothing ever leaves the machine. Cast needed because Bun's typeof fetch
// carries an extra preconnect property a plain function lacks.
const mockFetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return fetch(url.replace("https://api.github.com", BASE), init);
}) as unknown as typeof fetch;

// checksums.txt served per tag; special tags are used by the failure tests.
function checksumsFor(tag: string): string {
  if (tag === "badsum") return `${"ab".repeat(32)}  ${ASSET}\n`;      // wrong hash, line present
  if (tag === "noline") return `${NEW_HASH}  some-other-asset\n`;      // asset line missing
  return `${NEW_HASH}  ${ASSET}\n`;
}

// --- temp-dir binary fixture -------------------------------------------

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function makeBinaryDir(): { dir: string; binaryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "o2a2o-update-"));
  tmpDirs.push(dir);
  const binaryPath = join(dir, "o2a2o-mock-bin");
  writeFileSync(binaryPath, ORIGINAL);
  return { dir, binaryPath };
}

function makeManager(
  binaryPath: string,
  o: {
    allowPrerelease?: boolean;
    currentVersion?: string;
    spawnFn?: SpawnFn;
    now?: () => Date;
    renameFn?: (from: string, to: string) => void;
  } = {},
): UpdateManager {
  return new UpdateManager({
    repo: "acme/o2a2o",
    currentVersion: o.currentVersion ?? "0.3.0",
    binaryPath,
    allowPrerelease: o.allowPrerelease ?? false,
    fetchFn: mockFetch,
    spawnFn: o.spawnFn ?? (() => ({ status: 0, stdout: "o2a2o 0.4.0", stderr: "" })),
    now: o.now,
    renameFn: o.renameFn,
  });
}

function manualRel(checksumTag: string): ReleaseInfo {
  return {
    version: "0.4.0",
    prerelease: false,
    assetUrl: `${BASE}/download/v0.4.0/${ASSET}`,
    sha256Url: `${BASE}/download/${checksumTag}/checksums.txt`,
  };
}

// --- check() ------------------------------------------------------------

test("check: newest stable newer than current, with platform asset and checksums urls", async () => {
  const info = await fetchLatestRelease("acme/o2a2o", {
    allowPrerelease: false,
    currentVersion: "0.3.0",
    fetchFn: mockFetch,
  });
  // 0.5.0-rc.1 and the draft v0.9.0 are both newer but must be filtered out.
  expect(info).toEqual({
    version: "0.4.0",
    prerelease: false,
    assetUrl: `${BASE}/download/v0.4.0/${ASSET}`,
    sha256Url: `${BASE}/download/v0.4.0/checksums.txt`,
  });
});

test("check: prerelease returned when allowPrerelease is true", async () => {
  const info = await fetchLatestRelease("acme/o2a2o", {
    allowPrerelease: true,
    currentVersion: "0.3.0",
    fetchFn: mockFetch,
  });
  expect(info).toMatchObject({ version: "0.5.0-rc.1", prerelease: true });
});

test("check: null when already up to date (stable and prerelease, drafts ignored)", async () => {
  const stable = await fetchLatestRelease("acme/o2a2o", {
    allowPrerelease: false, currentVersion: "0.4.0", fetchFn: mockFetch,
  });
  expect(stable).toBeNull();
  const pre = await fetchLatestRelease("acme/o2a2o", {
    allowPrerelease: true, currentVersion: "0.5.0-rc.1", fetchFn: mockFetch,
  });
  expect(pre).toBeNull(); // only the draft v0.9.0 is newer; drafts are never offered
});

test("UpdateManager.check delegates to fetchLatestRelease and stamps lastCheckAt via now", async () => {
  const { binaryPath } = makeBinaryDir();
  const at = new Date("2026-09-22T00:00:00Z");
  const mgr = makeManager(binaryPath, { now: () => at });
  expect(await mgr.check()).toMatchObject({ version: "0.4.0" });
  expect(mgr.lastCheckAt).toBe(at);
});

// --- minimal semver -----------------------------------------------------

test("semver: rc sorts before its release, later rcs sort higher, cores decide first", () => {
  expect(compareVersions("0.3.0-rc.1", "0.3.0")).toBeLessThan(0);
  expect(compareVersions("0.3.0-rc.2", "0.3.0-rc.1")).toBeGreaterThan(0);
  expect(compareVersions("0.4.0", "0.3.0-rc.9")).toBeGreaterThan(0);
  expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
  expect(compareVersions("v0.4.0", "0.4.0")).toBe(0); // v prefix tolerated
});

// --- update() -----------------------------------------------------------

test("update happy path: new bytes land at binaryPath, temps cleaned", async () => {
  const { binaryPath } = makeBinaryDir();
  const mgr = makeManager(binaryPath);
  const rel = await mgr.check();
  expect(rel).not.toBeNull();
  const result = await mgr.update(rel!);
  expect(result).toEqual({ ok: true, rolledBack: false });
  expect(readFileSync(binaryPath).equals(Buffer.from(NEW_BYTES))).toBe(true);
  expect(existsSync(binaryPath + ".new")).toBe(false);
  expect(existsSync(binaryPath + ".backup")).toBe(false);
  expect(existsSync(binaryPath + ".old")).toBe(false);
});

test("update: checksum mismatch keeps the current binary and removes .new", async () => {
  const { binaryPath } = makeBinaryDir();
  const mgr = makeManager(binaryPath);
  const result = await mgr.update(manualRel("badsum"));
  expect(result).toEqual({ ok: false, rolledBack: false });
  expect(readFileSync(binaryPath, "utf8")).toBe(ORIGINAL);
  expect(existsSync(binaryPath + ".new")).toBe(false);
  expect(existsSync(binaryPath + ".backup")).toBe(false);
  expect(existsSync(binaryPath + ".old")).toBe(false);
});

test("update: checksums file without the asset line is treated as a mismatch", async () => {
  const { binaryPath } = makeBinaryDir();
  const mgr = makeManager(binaryPath);
  const result = await mgr.update(manualRel("noline"));
  expect(result).toEqual({ ok: false, rolledBack: false });
  expect(readFileSync(binaryPath, "utf8")).toBe(ORIGINAL);
  expect(existsSync(binaryPath + ".new")).toBe(false);
});

test("update: failed self-verify rolls back to the exact original bytes", async () => {
  const { binaryPath } = makeBinaryDir();
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 1, stdout: "", stderr: "boom" };
  };
  const mgr = makeManager(binaryPath, { spawnFn });
  const rel = await mgr.check();
  const result = await mgr.update(rel!);
  expect(result).toEqual({ ok: false, rolledBack: true });
  expect(readFileSync(binaryPath, "utf8")).toBe(ORIGINAL);
  expect(calls).toEqual([{ cmd: binaryPath, args: ["--version"] }]);
  expect(existsSync(binaryPath + ".new")).toBe(false);
  expect(existsSync(binaryPath + ".backup")).toBe(false);
  expect(existsSync(binaryPath + ".old")).toBe(false);
});

test("update: self-verify exit 0 but output missing the new version also rolls back", async () => {
  const { binaryPath } = makeBinaryDir();
  const mgr = makeManager(binaryPath, {
    spawnFn: () => ({ status: 0, stdout: "o2a2o 0.3.0", stderr: "" }),
  });
  const rel = await mgr.check();
  const result = await mgr.update(rel!);
  expect(result).toEqual({ ok: false, rolledBack: true });
  expect(readFileSync(binaryPath, "utf8")).toBe(ORIGINAL);
});

// --- fix round 1 ---------------------------------------------------------

test("update: release without a checksums asset is refused, current binary untouched", async () => {
  const { binaryPath } = makeBinaryDir();
  const mgr = makeManager(binaryPath);
  const rel: ReleaseInfo = {
    version: "0.4.0",
    prerelease: false,
    assetUrl: `${BASE}/download/v0.4.0/${ASSET}`,
  };
  const result = await mgr.update(rel);
  expect(result).toEqual({ ok: false, rolledBack: false });
  expect(readFileSync(binaryPath, "utf8")).toBe(ORIGINAL);
  expect(existsSync(binaryPath + ".new")).toBe(false);
  expect(existsSync(binaryPath + ".backup")).toBe(false);
});

test("update: crash between the two Windows renames restores the original from .old", async () => {
  if (process.platform !== "win32") return; // the two-rename window exists only on win32
  const { binaryPath } = makeBinaryDir();
  let replaceRenameFailed = false; // fail only the replace's 2nd rename, not the restore's
  const mgr = makeManager(binaryPath, {
    renameFn: (from, to) => {
      if (to === binaryPath && !replaceRenameFailed) {
        replaceRenameFailed = true;
        throw new Error("simulated crash between renames");
      }
      renameSync(from, to);
    },
  });
  const result = await mgr.update(manualRel("v0.4.0"));
  expect(result).toEqual({ ok: false, rolledBack: true });
  // after the crash the original existed only at .old; it must come back
  expect(readFileSync(binaryPath, "utf8")).toBe(ORIGINAL);
  expect(existsSync(binaryPath + ".new")).toBe(false);
  expect(existsSync(binaryPath + ".old")).toBe(false);
  expect(existsSync(binaryPath + ".backup")).toBe(false);
});

test("update: failed rollback keeps the recovery copies and reports rolledBack false", async () => {
  const { binaryPath } = makeBinaryDir();
  const mgr = makeManager(binaryPath, {
    spawnFn: () => ({ status: 1, stdout: "", stderr: "boom" }), // force the rollback path
    renameFn: (from, to) => {
      if (to === binaryPath + ".new") throw new Error("simulated restore failure"); // park move fails
      renameSync(from, to);
    },
  });
  const result = await mgr.update(manualRel("v0.4.0"));
  expect(result).toEqual({ ok: false, rolledBack: false }); // restore did NOT succeed
  expect(readFileSync(binaryPath, "utf8")).toBe(NEW_TEXT); // still the unverified binary
  expect(existsSync(binaryPath + ".old")).toBe(true); // recovery copies retained
  expect(existsSync(binaryPath + ".backup")).toBe(true);
});
