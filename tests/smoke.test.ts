import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { main } from "../src/index";
import { runCli, VERSION } from "../src/cli";

test("main is callable", () => {
  expect(() => main()).not.toThrow();
});

test("version prints 0.3.0", async () => {
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
  expect(logs).toContain("0.3.0");
});

test("printed version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
