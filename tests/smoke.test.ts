import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { main } from "../src/index";
import { runCli, VERSION } from "../src/cli";

test("main is callable", () => {
  expect(() => main()).not.toThrow();
});

test("version prints the branded version line", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  let code: number;
  try {
    code = await runCli(["version"]);
  } finally {
    console.log = origLog;
  }
  expect(code).toBe(0);
  // brand + semver on one line: the channel the updater's self-verify and the
  // update identity guard both rely on
  expect(logs).toContain(`o2a2o ${VERSION}`);
});

test("--version reaches the version command", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  let code: number;
  try {
    code = await runCli(["--version"]);
  } finally {
    console.log = origLog;
  }
  expect(code).toBe(0);
  expect(logs).toContain(`o2a2o ${VERSION}`);
});

test("printed version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
