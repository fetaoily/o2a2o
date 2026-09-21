// CLI update command and startup-check tests: fully offline via stubbed
// UpdateManager instances (no network, no spawns, no real binaries touched).
import { expect, test } from "bun:test";
import { VERSION, startupUpdateCheck, updateCommand } from "../../src/cli";
import type { UpdateConfig } from "../../src/config/loader";
import type { ReleaseInfo } from "../../src/update/github-releases";
import type { UpdateManager } from "../../src/update/update-manager";

const REL: ReleaseInfo = {
  version: "0.4.0",
  prerelease: false,
  assetUrl: "https://example.invalid/download/o2a2o-windows-x64.exe",
  sha256Url: "https://example.invalid/download/checksums.txt",
};

const UC: UpdateConfig = {
  enabled: true,
  repo: "fetaoily/o2a2o",
  check_on_start: true,
  allow_prerelease: true,
};

// Minimal manager stand-in: only the two members the CLI touches.
function stubManager(
  checkImpl: () => Promise<ReleaseInfo | null>,
  updateImpl?: (rel: ReleaseInfo) => Promise<{ ok: boolean; rolledBack: boolean }>,
): UpdateManager {
  return {
    lastCheckAt: null,
    check: checkImpl,
    update: updateImpl ?? (async () => ({ ok: true, rolledBack: false })),
  } as unknown as UpdateManager;
}

function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  return { logs, errors, restore: () => { console.log = origLog; console.error = origError; } };
}

// --- o2a2o update command -------------------------------------------------

test("update command: disabled config exits 1 without consulting the manager", async () => {
  let called = false;
  const mgr = stubManager(async () => { called = true; return REL; });
  const cap = capture();
  let code: number;
  try { code = await updateCommand(mgr, false); } finally { cap.restore(); }
  expect(code).toBe(1);
  expect(called).toBe(false);
  expect(cap.errors.some((m) => m.includes("disabled"))).toBe(true);
});

test("update command: already latest exits 0 with the current version", async () => {
  const mgr = stubManager(async () => null);
  const cap = capture();
  let code: number;
  try { code = await updateCommand(mgr, true); } finally { cap.restore(); }
  expect(code).toBe(0);
  expect(cap.logs).toContain(`already up to date (${VERSION})`);
});

test("update command: newer release installs and exits 0", async () => {
  const mgr = stubManager(async () => REL, async (rel) => {
    expect(rel.version).toBe("0.4.0");
    return { ok: true, rolledBack: false };
  });
  const cap = capture();
  let code: number;
  try { code = await updateCommand(mgr, true); } finally { cap.restore(); }
  expect(code).toBe(0);
  expect(cap.logs).toContain("updated to 0.4.0");
});

test("update command: check failure exits 1 with a distinct message", async () => {
  const mgr = stubManager(async () => { throw new Error("GitHub API request failed: HTTP 500"); });
  const cap = capture();
  let code: number;
  try { code = await updateCommand(mgr, true); } finally { cap.restore(); }
  expect(code).toBe(1);
  expect(cap.errors).toContain("update check failed: GitHub API request failed: HTTP 500");
});

test("update command: missing-checksums refusal reason is surfaced on stderr", async () => {
  const rel: ReleaseInfo = { ...REL, sha256Url: undefined };
  const mgr = stubManager(async () => rel, async () => ({ ok: false, rolledBack: false }));
  const cap = capture();
  let code: number;
  try { code = await updateCommand(mgr, true); } finally { cap.restore(); }
  expect(code).toBe(1);
  expect(cap.errors).toContain("update refused: release has no checksums asset; refusing unverified install");
});

test("update command: rollback outcome exits 1 with the rolled-back message", async () => {
  const mgr = stubManager(async () => REL, async () => ({ ok: false, rolledBack: true }));
  const cap = capture();
  let code: number;
  try { code = await updateCommand(mgr, true); } finally { cap.restore(); }
  expect(code).toBe(1);
  expect(cap.errors).toContain("update failed, rolled back");
});

// --- startup check (check_on_start) ----------------------------------------

test("startup check: prints exactly one line when a newer release exists", async () => {
  const mgr = stubManager(async () => REL);
  const cap = capture();
  try { await startupUpdateCheck(UC, { manager: mgr }); } finally { cap.restore(); }
  expect(cap.logs).toEqual(["update available: 0.4.0 (run `o2a2o update`)"]);
  expect(cap.errors).toEqual([]);
});

test("startup check: check_on_start false never consults the manager", async () => {
  let called = false;
  const mgr = stubManager(async () => { called = true; return REL; });
  const cap = capture();
  try { await startupUpdateCheck({ ...UC, check_on_start: false }, { manager: mgr }); } finally { cap.restore(); }
  expect(called).toBe(false);
  expect(cap.logs).toEqual([]);
});

test("startup check: up to date prints nothing", async () => {
  const mgr = stubManager(async () => null);
  const cap = capture();
  try { await startupUpdateCheck(UC, { manager: mgr }); } finally { cap.restore(); }
  expect(cap.logs).toEqual([]);
});

test("startup check: check errors are silent and never reject", async () => {
  const mgr = stubManager(async () => { throw new Error("network unreachable"); });
  const cap = capture();
  try {
    await expect(startupUpdateCheck(UC, { manager: mgr })).resolves.toBeUndefined();
  } finally { cap.restore(); }
  expect(cap.logs).toEqual([]);
  expect(cap.errors).toEqual([]);
});
