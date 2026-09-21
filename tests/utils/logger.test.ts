import { test, expect } from "bun:test";
import { maskKey } from "../../src/utils/logger";

test("maskKey guards short keys", () => {
  expect(maskKey("short1key")).toBe("***" + "1key");  // 9 chars
  expect(maskKey("sk-averylongapikey-value")).toBe("sk-avery" + "..." + "alue");
});
