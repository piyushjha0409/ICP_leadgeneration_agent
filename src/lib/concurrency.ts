/**
 * Minimal `p-limit`-style concurrency gate — no dependency, no queue library.
 * Returns a function that wraps a task and resolves it once a slot is free.
 */
export function pLimit(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active -= 1;
    queue.shift()?.();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        // `fn` may throw synchronously; Promise.resolve().then keeps that on
        // the rejection path instead of blowing past the gate.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(next);
      };

      if (active < concurrency) start();
      else queue.push(start);
    });
  };
}

/**
 * `Promise.all(items.map(fn))` with a concurrency ceiling. Results keep input
 * order. Rejections propagate — callers that must not fail the whole batch
 * should catch inside `fn`.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(Math.min(concurrency, Math.max(items.length, 1)));
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}
