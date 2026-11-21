/**
 * In-memory results for the lifetime of one provider client.
 *
 * A client lives for one run (a CLI command, or one fetch in the desktop
 * app). Episode lookups ask for the same season listing, episode group, or
 * translation once per file; the response cache already answers repeats, but
 * it can be off, and reading and parsing a cache file per file is wasted
 * work. This keeps each result for the run, so one is requested once.
 *
 * Concurrent callers share the pending promise. A failure is forgotten, so
 * the next caller tries again.
 */
export class RunMemo {
  private readonly results = new Map<string, Promise<unknown>>();

  /** The result for `key`, starting `start` the first time. */
  run<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.results.get(key);
    if (existing) return existing as Promise<T>;
    const promise = start();
    this.results.set(key, promise);
    promise.catch(() => {
      if (this.results.get(key) === promise) this.results.delete(key);
    });
    return promise;
  }

  /** Number of results held (for tests). */
  get size(): number {
    return this.results.size;
  }
}
