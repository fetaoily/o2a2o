import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, parsePort, runCli } from "../src/cli";

test("serve with defaults", () =>
  expect(parseArgv(["serve"])).toEqual({ cmd: "serve", configPath: "./o2a2o.yaml", port: undefined }));
test("serve with flags", () =>
  expect(parseArgv(["serve", "--config", "x.yaml", "--port", "9090"])).toEqual({ cmd: "serve", configPath: "x.yaml", port: 9090 }));
test("config subcommands", () => {
  expect(parseArgv(["config", "init"])).toEqual({ cmd: "config", sub: "init", configPath: undefined });
  expect(parseArgv(["config", "validate", "y.yaml"])).toEqual({ cmd: "config", sub: "validate", configPath: "y.yaml" });
});
test("version and unknown", () => {
  expect(parseArgv(["version"]).cmd).toBe("version");
  expect(parseArgv(["wat"]).cmd).toBe("help");
});
test("update parses", () => {
  expect(parseArgv(["update"])).toEqual({ cmd: "update" });
});
test("parsePort warns and ignores non-numeric", () => {
  expect(parsePort("abc")).toBeUndefined();
  expect(parsePort("9090")).toBe(9090);
});
test("convert parses args", () => {
  expect(parseArgv(["convert", "--input", "r.json"])).toEqual({ cmd: "convert", inputPath: "r.json", to: undefined });
  expect(parseArgv(["convert", "--input", "r.json", "--to", "anthropic"])).toEqual({ cmd: "convert", inputPath: "r.json", to: "anthropic" });
});
test("convert rejects prototype-chain property names as --to", () => {
  // parseArgv accepts it; runCli must exit 1 — assert at the parse level that the
  // value survives, and rely on runCli ownership check for the exit path.
  expect(parseArgv(["convert", "--input", "r.json", "--to", "toString"]).cmd).toBe("convert");
});
test("convert --to toString exits 1 at the runCli level", async () => {
  // runCli already returns the process exit code, so the rejection path is
  // exercised in-process (no subprocess spawn). The temp file holds a valid,
  // detectable chat body so the exit can only come from the --to check.
  const dir = mkdtempSync(join(tmpdir(), "o2a2o-convert-"));
  const inputPath = join(dir, "req.json");
  writeFileSync(inputPath, JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "reply with ok" }] }));
  try {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    let code: number;
    try {
      code = await runCli(["convert", "--input", inputPath, "--to", "toString"]);
    } finally {
      console.error = origError;
    }
    expect(code).toBe(1);
    expect(errors.some((m) => m.includes("invalid --to value: toString"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
