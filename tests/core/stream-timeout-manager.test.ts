import { test, expect } from "bun:test";
import { StreamTimeoutManager, StreamTimeoutError } from "../../src/core/stream-timeout-manager";

test("first packet cancels first-packet timer", async () => {
  const m = new StreamTimeoutManager({ first_packet: 100, idle: 150, idle_check_interval: 50, idle_grace_period: 10, total_max: 1000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });  // signature ruling: arm(onTimeout) — the manager decides the stage
  m.noteData();                                       // first packet arrived
  await new Promise(r => setTimeout(r, 200));
  expect(err).toBeUndefined();
  m.disarm();
});
test("no first packet fires retryable first_packet error", async () => {
  const m = new StreamTimeoutManager({ first_packet: 80, idle: 150, idle_check_interval: 50, idle_grace_period: 10, total_max: 1000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });
  await new Promise(r => setTimeout(r, 150));
  expect(err?.stage).toBe("first_packet");
  expect(err?.retryable).toBe(true);
  m.disarm();
});
test("stalled stream fires idle error after grace", async () => {
  const m = new StreamTimeoutManager({ first_packet: 80, idle: 120, idle_check_interval: 40, idle_grace_period: 20, total_max: 5000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });
  m.noteData();                    // first packet
  await new Promise(r => setTimeout(r, 250));  // no further data
  expect(err?.stage).toBe("idle");
  expect(err?.retryable).toBe(false);
  m.disarm();
});
test("idle cannot fire before the first packet even when misconfigured (idle < first_packet)", async () => {
  // first-packet timer owns the pre-data window: an idle threshold smaller
  // than first_packet must not preempt it.
  const m = new StreamTimeoutManager({ first_packet: 300, idle: 10, idle_check_interval: 50, idle_grace_period: 10, total_max: 5000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });
  await new Promise(r => setTimeout(r, 400));   // idle ticks pass, no data yet
  expect(err?.stage).toBe("first_packet");
  m.disarm();
});
