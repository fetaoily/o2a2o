// Dynamic non-stream timeout (TECH-DESIGN §8.1) plus the process-level latency
// tracker feeding its adaptive floor. Precedence: by_model override >
// max_tokens estimation (non-stream only) > default; the recorded-latency
// average (x3) raises the result but never past by_request.max.
import type { TimeoutConfig } from "../config/loader";

const WINDOW_SIZE = 50;

export class LatencyTracker {
  private samples = new Map<string, number[]>();

  record(model: string, latencyMs: number): void {
    let window = this.samples.get(model);
    if (!window) {
      window = [];
      this.samples.set(model, window);
    }
    window.push(latencyMs);
    if (window.length > WINDOW_SIZE) window.shift();
  }

  avg(model: string): number {
    const window = this.samples.get(model);
    if (!window || window.length === 0) return 0;
    return window.reduce((sum, ms) => sum + ms, 0) / window.length;
  }
}

export const latencyTracker = new LatencyTracker();

export function calculateTimeout(opts: {
  model: string;
  maxTokens: number;
  isStream: boolean;
  tc: TimeoutConfig;
  tracker?: LatencyTracker;
}): number {
  const ns = opts.tc.non_stream;
  const byModel = ns.by_model[opts.model];
  let timeout: number;
  if (byModel !== undefined) {
    timeout = byModel;                                   // by_model overrides the estimation
  } else if (!opts.isStream && opts.maxTokens) {
    timeout = Math.min(
      Math.max(opts.maxTokens * ns.by_request.ms_per_token, ns.by_request.min),
      ns.by_request.max,
    );
  } else {
    timeout = ns.default;
  }
  const avgMs = (opts.tracker ?? latencyTracker).avg(opts.model);
  return Math.min(Math.max(timeout, avgMs * 3), ns.by_request.max);
}
