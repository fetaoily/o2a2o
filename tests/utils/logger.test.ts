import { test, expect } from "bun:test";
import { maskKey } from "../../src/utils/logger";

test("maskKey guards short keys", () => {
  expect(maskKey("short1key")).toBe("***" + "1key");  // 9 chars
  expect(maskKey("sk-averylongapikey-value")).toBe("sk-avery" + "..." + "alue");
});
test("maskKey fully hides degenerate keys (<= 8 chars)", () => {
  expect(maskKey("abc")).toBe("***");          // no slice leak on tiny keys
  expect(maskKey("12345678")).toBe("***");    // exactly 8: slice(-4) would leak half the key
  expect(maskKey("")).toBe("***");
});
