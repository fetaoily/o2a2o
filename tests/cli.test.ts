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
