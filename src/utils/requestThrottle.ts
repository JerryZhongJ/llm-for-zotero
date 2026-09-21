/**
 * Generic client-side request throttle for rate-limited HTTP APIs.
 *
 * Requests through `run` are serialized: each task starts only after the
 * previous one settled plus `minIntervalMs`, so concurrent callers queue up
 * instead of bursting. Transport-agnostic — the caller supplies the task.
 */

interface RequestThrottle {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Replace the pacing interval; intended for tests that must not wait. */
  setInterval(ms: number): void;
  /** Drop pending pacing so queued tasks start immediately; test seam. */
  reset(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRequestThrottle(minIntervalMs: number): RequestThrottle {
  let minInterval = minIntervalMs;
  let chain: Promise<void> = Promise.resolve();
  let lastSettledAt = 0;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = chain.then(async () => {
        const wait = lastSettledAt + minInterval - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          return await task();
        } finally {
          lastSettledAt = Date.now();
        }
      });
      // Keep the chain alive even when a task rejects, so later callers
      // still get to run instead of inheriting the failure.
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    setInterval(ms: number): void {
      minInterval = ms;
    },
    reset(): void {
      lastSettledAt = 0;
    },
  };
}
