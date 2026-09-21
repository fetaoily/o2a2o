// Stream timeout monitor: three timer groups (first-packet one-shot, idle
// periodic staleness check, total-duration one-shot) watching one upstream
// reader (TECH-DESIGN section 8). One manager per upstream stream; real
// timers, tests configure short durations. On a timeout the single arm()
// callback is invoked exactly once with a StreamTimeoutError whose stage the
// manager determines itself; the stream owner encodes the error frame and
// closes the stream.
import type { TimeoutConfig } from "../config/loader";

export type StreamTimeoutStage = "first_packet" | "idle" | "total";

export class StreamTimeoutError extends Error {
  readonly stage: StreamTimeoutStage;
  // first_packet: nothing was generated yet, a fresh upstream may succeed.
  // idle / total: the client already received partial output; retrying would
  // duplicate it (spec D5).
  readonly retryable: boolean;

  constructor(stage: StreamTimeoutStage, message?: string) {
    super(message ?? `stream timeout: ${stage}`);
    this.name = "StreamTimeoutError";
    this.stage = stage;
    this.retryable = stage === "first_packet";
  }
}

type TimeoutCallback = (err: StreamTimeoutError) => void;

export class StreamTimeoutManager {
  private readonly cfg: TimeoutConfig["stream"];
  private onTimeout: TimeoutCallback | undefined;
  private armed = false;
  private fired = false;
  private firstPacketSeen = false;
  private lastData = 0;
  private firstPacketTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private totalTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(cfg: TimeoutConfig["stream"]) {
    this.cfg = cfg;
  }

  // Starts the three timer groups, replacing any previous arming.
  arm(onTimeout: TimeoutCallback): void {
    this.disarm();
    this.onTimeout = onTimeout;
    this.armed = true;
    this.fired = false;
    this.firstPacketSeen = false;
    this.lastData = Date.now();
    this.firstPacketTimer = setTimeout(() => this.fire("first_packet"), this.cfg.first_packet);
    this.scheduleIdleCheck();
    this.totalTimer = setTimeout(() => this.fire("total"), this.cfg.total_max);
  }

  // Called once per upstream data chunk: refreshes the staleness clock and,
  // on the first chunk, cancels the first-packet timer.
  noteData(): void {
    if (!this.armed || this.fired) return;
    this.lastData = Date.now();
    if (!this.firstPacketSeen) {
      this.firstPacketSeen = true;
      if (this.firstPacketTimer !== undefined) {
        clearTimeout(this.firstPacketTimer);
        this.firstPacketTimer = undefined;
      }
    }
  }

  // Cancels every timer. Called from the stream's finally-ish path (source
  // close / error / cancel) and internally after a fire. Idempotent.
  disarm(): void {
    this.armed = false;
    this.onTimeout = undefined;
    if (this.firstPacketTimer !== undefined) {
      clearTimeout(this.firstPacketTimer);
      this.firstPacketTimer = undefined;
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.totalTimer !== undefined) {
      clearTimeout(this.totalTimer);
      this.totalTimer = undefined;
    }
  }

  // Fires the callback once, then quiesces first so the callback observes a
  // disarmed manager and cannot re-enter live timers.
  private fire(stage: StreamTimeoutStage): void {
    if (!this.armed || this.fired) return;
    this.fired = true;
    const callback = this.onTimeout;
    this.disarm();
    callback?.(new StreamTimeoutError(stage));
  }

  private scheduleIdleCheck(): void {
    this.idleTimer = setTimeout(() => this.checkIdle(), this.cfg.idle_check_interval);
  }

  // Periodic staleness check. The checker only samples at ticks, so a
  // deadline crossing (idle + grace) is acted on once it is a full
  // idle_check_interval old — the sampler's blind spot. This quantization
  // also makes the abort time independent of individual timer jitter: a
  // late tick measures a larger staleness and may fire earlier, but never
  // before the stream has actually been silent for the full threshold.
  // Before the first packet the first-packet timer owns the window: the idle
  // stage is skipped entirely, so an idle budget smaller than first_packet
  // cannot preempt the retryable first-packet abort.
  private checkIdle(): void {
    if (!this.armed || this.fired) return;
    if (!this.firstPacketSeen) {
      this.scheduleIdleCheck();
      return;
    }
    if (Date.now() - this.lastData > this.cfg.idle + this.cfg.idle_grace_period + this.cfg.idle_check_interval) {
      this.fire("idle");
      return;
    }
    this.scheduleIdleCheck();
  }
}
