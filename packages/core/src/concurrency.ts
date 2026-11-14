/**
 * Small concurrency helpers for the rename workflow: a FIFO limiter, a
 * bounded `map`, abortable waits, and progress that is reported in input
 * order. Internal to core (not exported from the package index).
 */

import type { ProgressCallback } from "./renamer";

/** Reject with the signal's reason as soon as it aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The promise's own outcome no longer matters; keep it from going unhandled.
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Runs at most `limit` tasks at once; waiting tasks start in the order they asked. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Invalid limit: ${limit}`);
  }

  /**
   * Run `task` when a slot is free. With a signal, a task that has not
   * started when the signal aborts never starts (the call rejects with the
   * signal's reason); a task that has started runs to completion.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await this.waitForSlot(signal);
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      this.release();
    }
  }

  /** Wait in line for a slot; leaving the line on abort. */
  private waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal!.reason);
      };
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot passes directly to the next waiter, so `active` stays the same.
    if (next) next();
    else this.active -= 1;
  }
}

/**
 * Map `items` with at most `limit` calls in flight. The result keeps input
 * order. The first rejection rejects the whole call; items not yet started
 * are not started.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Progress for work that finishes out of order. Each item is reported when
 * it and every item before it are done, so `current` counts up 1, 2, ...,
 * `total` and the messages appear in input order whatever finishes first.
 *
 * While held (a selection prompt is open), nothing is reported; reports
 * that came due are sent when the hold is released.
 */
export class OrderedProgress {
  private readonly messages: Array<string | undefined>;
  private reported = 0;
  private holds = 0;

  constructor(
    readonly total: number,
    private readonly callback: ProgressCallback | undefined,
  ) {
    this.messages = new Array<string | undefined>(total);
  }

  /** Mark item `index` done, with the message to show for it. */
  complete(index: number, message: string): void {
    this.messages[index] = message;
    this.flush();
  }

  /** Stop reporting until `release` is called (holds nest). */
  hold(): void {
    this.holds += 1;
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.flush();
  }

  private flush(): void {
    while (
      this.holds === 0 &&
      this.reported < this.total &&
      this.messages[this.reported] !== undefined
    ) {
      const message = this.messages[this.reported]!;
      this.messages[this.reported] = undefined;
      this.reported += 1;
      this.callback?.(this.reported, this.total, message);
    }
  }
}
