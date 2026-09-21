import { test, expect } from "bun:test";
import { main } from "../src/index";
import { runCli } from "../src/cli";

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
