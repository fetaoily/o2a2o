// GitHub Releases discovery for the self-update flow (TECH-DESIGN §11).
// Queries the release LIST endpoint (not /latest) so prereleases can be
// filtered, and picks the highest version strictly newer than the current
// one. Semver handling is a minimal local implementation (no dependency).
// All network I/O goes through the injectable fetchFn so tests stay offline.

export interface ReleaseInfo {
  version: string;
  prerelease: boolean;
  assetUrl: string;
  sha256Url?: string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}
interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubAsset[];
}

const GITHUB_API = "https://api.github.com";
const CHECKSUMS_ASSET = "checksums.txt";

// Name of the release asset built for a platform/arch (scripts/build-all.mjs
// naming: o2a2o-<os>-<arch>[.exe], with bun's "win32" spelled "windows").
export function platformAssetName(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const ext = platform === "win32" ? ".exe" : "";
  return `o2a2o-${os}-${arch}${ext}`;
}

// --- minimal semver -----------------------------------------------------

interface ParsedVersion {
  core: number[]; // [major, minor, patch]
  pre: string[]; // empty for a plain release ("0.3.0" vs "0.3.0-rc.1")
}

function parseVersion(v: string): ParsedVersion | null {
  const t = v.trim().replace(/^v/i, "");
  const dash = t.indexOf("-");
  const core = (dash === -1 ? t : t.slice(0, dash)).split(".").map(Number);
  if (core.length !== 3 || core.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const preStr = dash === -1 ? "" : t.slice(dash + 1);
  if (preStr === "") return { core, pre: [] };
  const pre = preStr.split(".");
  if (pre.some((p) => p === "")) return null;
  return { core, pre };
}

// Prerelease identifiers per semver: a release outranks any prerelease of the
// same core; numeric identifiers compare numerically and rank below
// alphanumeric ones; fewer fields rank below more fields when equal so far.
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// Negative when a < b, positive when a > b, 0 when equal. Unparseable input
// compares as equal; callers drop unparseable versions before comparing.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

// --- releases API -------------------------------------------------------

// Returns the highest release strictly newer than opts.currentVersion, or
// null when already up to date. Drafts are never offered; prereleases only
// when opts.allowPrerelease. A release without an asset for the running
// platform cannot be installed and is skipped.
export async function fetchLatestRelease(
  repo: string,
  opts: { allowPrerelease: boolean; currentVersion: string; fetchFn?: typeof fetch },
): Promise<ReleaseInfo | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const resp = await fetchFn(`${GITHUB_API}/repos/${repo}/releases`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "o2a2o-update" },
  });
  if (!resp.ok) throw new Error(`GitHub API request failed: HTTP ${resp.status}`);
  const releases = (await resp.json()) as GitHubRelease[];

  const want = platformAssetName();
  let best: ReleaseInfo | null = null;
  for (const r of releases) {
    if (r.draft) continue;
    if (r.prerelease && !opts.allowPrerelease) continue;
    const asset = r.assets.find((a) => a.name === want);
    if (!asset) continue;
    const parsed = parseVersion(r.tag_name);
    if (!parsed) continue;
    const version = r.tag_name.trim().replace(/^v/i, "");
    if (compareVersions(version, opts.currentVersion) <= 0) continue;
    const info: ReleaseInfo = { version, prerelease: r.prerelease, assetUrl: asset.browser_download_url };
    const sums = r.assets.find((a) => a.name === CHECKSUMS_ASSET);
    if (sums) info.sha256Url = sums.browser_download_url;
    if (best === null || compareVersions(info.version, best.version) > 0) best = info;
  }
  return best;
}
