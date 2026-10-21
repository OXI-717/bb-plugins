// Timing helpers derived from bb-plugin-auto-archive 0.1.0, Shane Logsdon (MIT).
/** Milliseconds until the next top-of-hour; exactly on the hour → a full hour. */
export function msUntilNextHour(now: Date = new Date()): number {
  return (
    (60 - now.getMinutes()) * 60_000 -
    now.getSeconds() * 1000 -
    now.getMilliseconds()
  );
}

/** Abort-aware sleep: resolves early (without clearing the caller's timer
 * state) when `signal` aborts, so services stop promptly on reload. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
