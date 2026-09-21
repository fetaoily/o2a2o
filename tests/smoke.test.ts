import { test, expect } from "bun:test";
import { main } from "../src/index";

test("main is callable", () => {
  expect(() => main()).not.toThrow();
});
