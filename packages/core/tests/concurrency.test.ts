import { describe, expect, it } from "vitest";
import { abortable, Limiter, mapConcurrent, OrderedProgress } from "../src/concurrency";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Limiter", () => {
  it("runs at most `limit` tasks, starting waiters in order", async () => {
    const limiter = new Limiter(2);
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const runs = [0, 1, 2, 3].map((i) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(i);
            finish[i] = () => resolve(i);
          }),
      ),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    finish[1]!();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    finish[0]!();
    finish[2]!();
    await tick();
    finish[3]!();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
  });

  it("a waiter that is aborted leaves the line without taking a slot", async () => {
    const limiter = new Limiter(1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const second = limiter.run(async () => "never", controller.signal);
    controller.abort(new Error("stop"));
    await expect(second).rejects.toThrow("stop");
    release();
    await first;
    // The slot is free again.
    expect(await limiter.run(async () => "ok")).toBe("ok");
  });

  it("does not start a task once the signal has aborted", async () => {
    const limiter = new Limiter(1);
    let ran = false;
    await expect(
      limiter.run(async () => {
        ran = true;
      }, AbortSignal.abort(new Error("gone"))),
    ).rejects.toThrow("gone");
    expect(ran).toBe(false);
  });

  it("rejects an invalid limit", () => {
    expect(() => new Limiter(0)).toThrow(RangeError);
  });
});

describe("abortable", () => {
  it("passes results through and rejects on abort", async () => {
    expect(await abortable(Promise.resolve(1), new AbortController().signal)).toBe(1);
    const controller = new AbortController();
    const pending = abortable(new Promise(() => undefined), controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("mapConcurrent", () => {
  it("keeps input order", async () => {
    const out = await mapConcurrent([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("handles an empty list", async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
  });
});

describe("OrderedProgress", () => {
  it("reports in index order and holds while asked to", () => {
    const events: Array<[number, number, string]> = [];
    const progress = new OrderedProgress(3, (c, t, m) => events.push([c, t, m]));
    progress.complete(1, "b");
    expect(events).toEqual([]);
    progress.hold();
    progress.complete(0, "a");
    expect(events).toEqual([]);
    progress.release();
    expect(events).toEqual([
      [1, 3, "a"],
      [2, 3, "b"],
    ]);
    progress.complete(2, "c");
    expect(events.at(-1)).toEqual([3, 3, "c"]);
  });
});
