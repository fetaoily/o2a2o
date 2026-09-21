// Target selection for scripts/build-all.mjs (--only filter): CI's
// per-platform release jobs each build only their native targets, so both
// the workflow and the unit tests share this one typed parser.

export interface BuildTarget {
  /** bun compile target, e.g. "bun-darwin-arm64". */
  target: string;
  /** dist/ output file name, e.g. "o2a2o-darwin-arm64". */
  out: string;
}

// Accepts any of: `--only a,b`, `--only=a,b`, a bare `--` separator followed
// by the list (bun/npm script passthrough form: `bun run build:platform --
// linux-x64`), or bare positional names. Unrecognized flags are ignored —
// they belong to build-all itself (--checksums).
export function parseOnlyArgs(argv: string[]): string[] {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) raw.push(argv[++i]);
    } else if (a.startsWith("--only=")) {
      raw.push(a.slice("--only=".length));
    } else if (a === "--") {
      raw.push(...argv.slice(i + 1).filter((s) => s !== "" && !s.startsWith("-")));
      break;
    } else if (!a.startsWith("-")) {
      raw.push(a);
    }
  }
  return raw
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// Filters targets by name; names may be given with or without the "bun-"
// prefix ("bun-linux-x64" or "linux-x64"). An empty selection means all
// targets. Unknown names throw: a typo must not silently build the wrong set.
export function selectTargets(targets: BuildTarget[], only: string[]): BuildTarget[] {
  if (only.length === 0) return targets;
  const strip = (s: string) => (s.startsWith("bun-") ? s.slice(4) : s);
  const wanted = new Set(only.map(strip));
  const known = new Map(targets.map((t) => [strip(t.target), t]));
  const unknown = [...wanted].filter((w) => !known.has(w));
  if (unknown.length > 0) {
    throw new Error(`unknown build target(s): ${unknown.join(", ")} (known: ${[...known.keys()].join(", ")})`);
  }
  return targets.filter((t) => wanted.has(strip(t.target)));
}
