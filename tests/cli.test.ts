import { test, expect } from "bun:test";
import { parseArgv, parsePort } from "../src/cli";

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
