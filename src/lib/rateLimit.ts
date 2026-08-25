/**
 * Sliding-window rate limiter, no dependency. Shared by `llm.ts` (OpenRouter's
 * ~20 RPM free ceiling) and the search providers (Firecrawl's 10 RPM free
 * ceiling), so each external API gets its own gate with the same semantics.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RateLimiter = {
  /** Resolves once the caller is allowed to make its request. */
  acquire: () => Promise<void>;
};

/**
 * Admits at most `maxRequests` calls per `windowMs`. Admission is serialised
 * through a promise chain so that N concurrent callers cannot all observe the
 * same free slot and fire together; waiters are released in arrival order.
 */
export function createRateLimiter(
  maxRequests: number,
  windowMs: number,
): RateLimiter {
  const stamps: number[] = [];
  let chain: Promise<void> = Promise.resolve();

  const admit = async (): Promise<void> => {
    for (;;) {
      const now = Date.now();
      while (stamps.length > 0 && now - (stamps[0] as number) >= windowMs) {
        stamps.shift();
      }
      if (stamps.length < maxRequests) {
        stamps.push(now);
        return;
      }
      // Wait out the oldest call in the window, then re-check: another waiter
      // may have taken the slot that just opened.
      const oldest = stamps[0] as number;
      await sleep(Math.max(1, windowMs - (now - oldest) + 5));
    }
  };

  return {
    acquire() {
      const admitted = chain.then(admit);
      // Keep the chain alive (and unrejected) for the next caller.
      chain = admitted.then(
        () => undefined,
        () => undefined,
      );
      return admitted;
    },
  };
}
