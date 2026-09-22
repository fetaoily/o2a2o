import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { main } from "../src/index";
import { runCli, VERSION } from "../src/cli";

test("main is callable", () => {
  expect(() => main()).not.toThrow();
});

test("version prints the running version", async () => {
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
  // substring match: the exact line shape is pinned where the output format
  // is defined (src/cli.ts) and tightened in tests/update/cli.test.ts
  expect(logs.some((l) => l.includes(VERSION))).toBe(true);
});

test("printed version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
