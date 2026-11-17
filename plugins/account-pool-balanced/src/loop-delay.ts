import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

export interface LoopDelaySources {
  now(): number;
  histogram: { max: number; percentile(n: number): number; reset(): void; enable(): void; disable(): void };
  utilization(): { idle: number; active: number };
  memory(): { heapUsed: number; rss: number };
  observeGc(callback: (duration: number) => void): () => void;
  schedule(callback: () => void): () => void;
}
const defaults = (): LoopDelaySources => ({
  now: () => performance.now(),
  histogram: monitorEventLoopDelay({ resolution: 20 }),
  utilization: () => performance.eventLoopUtilization(),
  memory: () => process.memoryUsage(),
  observeGc(callback) {
    const observer = new PerformanceObserver(list => {
      try { for (const entry of list.getEntries()) callback(entry.duration); } catch { /* Diagnostic only. */ }
    });
    observer.observe({ entryTypes: ['gc'] });
    return () => observer.disconnect();
  },
  schedule(callback) {
    const timer = setInterval(callback, 10_000);
    timer.unref();
    return () => clearInterval(timer);
  },
});

/** Diagnostics must never interrupt pool initialization, requests or disposal. */
export function startLoopDelay(
  warn: (message: string) => void,
  inFlight: () => number,
  sources?: LoopDelaySources,
): () => void {
  let stopped = false;
  const cleanup: Array<() => void> = [];
  const stop = () => {
    stopped = true;
    for (const close of cleanup.splice(0).reverse()) {
      try { close(); } catch { /* Diagnostic only. */ }
    }
  };
  try {
    const s = sources ?? defaults();
    let start = s.now();
    let previous = s.utilization();
    let maxGcPauseMs = 0;
    cleanup.push(() => s.histogram.disable());
    s.histogram.enable();
    cleanup.push(s.observeGc(duration => {
      if (!stopped && Number.isFinite(duration)) maxGcPauseMs = Math.max(maxGcPauseMs, duration);
    }));
    cleanup.push(s.schedule(() => {
      if (stopped) return;
      try {
        const end = s.now();
        const current = s.utilization();
        const active = current.active - previous.active;
        const idle = current.idle - previous.idle;
        const maxDelayMs = s.histogram.max / 1e6;
        const p99DelayMs = s.histogram.percentile(99) / 1e6;
        const gc = maxGcPauseMs;
        const windowMs = end - start;
        start = end;
        previous = current;
        maxGcPauseMs = 0;
        s.histogram.reset();
        if (maxDelayMs < 1000) return;
        const memory = s.memory();
        const fields = {
          maxDelayMs, p99DelayMs, windowMs,
          utilization: Math.max(0, Math.min(1, active + idle > 0 ? active / (active + idle) : 0)),
          maxGcPauseMs: gc, heapUsedMb: memory.heapUsed / 1024 ** 2,
          rssMb: memory.rss / 1024 ** 2, inFlight: inFlight(),
        };
        if (Object.values(fields).every(Number.isFinite)) {
          warn('Account Pooler event loop delay ' + JSON.stringify(fields));
        }
      } catch { stop(); }
    }));
    return stop;
  } catch { stop(); return stop; }
}
