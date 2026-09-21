// Minimal leveled logger (M1). Gated by cfg.server.log_level ("info" default).
// Invariant: no code path may log a raw API key — always pass keys through
// maskKey first.
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = "info";

export function setLogLevel(level: string): void {
  if (level in LEVELS) currentLevel = level as Level;
}

function enabled(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function emit(level: Level, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function log(msg: string): void { if (enabled("info")) emit("info", msg); }
export function warn(msg: string): void { if (enabled("warn")) emit("warn", msg); }
export function error(msg: string): void { if (enabled("error")) emit("error", msg); }

export function maskKey(key: string): string {
  if (key.length <= 8) return "***";                    // slice(-4) would leak half the key or more
  if (key.length <= 12) return "***" + key.slice(-4);
  return key.slice(0, 8) + "..." + key.slice(-4);
}
