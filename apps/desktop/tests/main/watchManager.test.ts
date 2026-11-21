/**
 * The desktop watch manager with the real controller and fake providers,
 * real files in a temp folder, no file-system events, and a fake clock for
 * the watcher (changes are found by rescanning).
 */

import { readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeWatchFileSystem, type WatchClock, type WatchFileSystem, type WatchMode } from "@tidytitles/core";
import { watchNotification } from "../../src/main/taskFeedback";
import { WatchManager } from "../../src/main/watchManager";
import { EVENTS, type WatchViewState } from "../../src/shared/ipc";
import { KEYS_TOML, createHarness, type Harness } from "./helpers";

const noEvents: WatchFileSystem = { ...nodeWatchFileSystem, watch: () => ({ close() {} }) };

class StepClock implements WatchClock {
  time = Date.now();
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private id = 1;
  now() {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number) {
    const t = { id: this.id++, at: this.time + ms, fn };
    this.timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown) {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  /** Advance in 500 ms steps, letting real file operations finish. */
  async run(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      this.time += 500;
      const due = this.timers.filter((t) => t.at <= this.time);
      this.timers = this.timers.filter((t) => t.at > this.time);
      for (const t of due) t.fn();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

let h: Harness;
let manager: WatchManager | undefined;
afterEach(async () => {
  manager?.dispose();
  manager = undefined;
  await h?.cleanup();
});

interface Setup {
  mode?: WatchMode;
  enabled?: boolean;
  existing?: string[];
}

async function setup(options: Setup = {}) {
  h = await createHarness(KEYS_TOML);
  for (const name of options.existing ?? []) await h.touch(name);
  const settings = await h.config.load();
  settings.watch = { enabled: options.enabled ?? true, folders: [h.media], recursive: true, mode: options.mode ?? "review", settleSeconds: 3 };
  await h.config.save(settings);
  await h.controller.init();
  const clock = new StepClock();
  const states: WatchViewState[] = [];
  const finished: { renamed: number; review: number }[] = [];
  manager = new WatchManager({
    controller: h.controller,
    emit: (s) => states.push(s),
    finished: (s) => finished.push(s),
    fs: noEvents,
    clock,
    timings: { rescanMs: 1_000, pollingRescanMs: 1_000, checkMs: 500 },
  });
  await manager.apply();
  return { manager, clock, states, finished };
}

const names = async () => (await readdir(h.media)).sort();

describe("WatchManager", () => {
  it("in review mode adds new files to the list and fetches, renaming nothing", async () => {
    const { manager, clock, finished } = await setup();
    expect(manager.getState()).toMatchObject({ enabled: true, paused: false, mode: "review", waiting: 0 });
    await writeFile(path.join(h.media, "Inception.2010.mkv"), "x");
    await clock.run(6_000);
    expect(manager.getState().waiting).toBe(1);

    expect(await manager.take(false)).toEqual({ kind: "busy" }); // a dialog is open: it waits
    expect(manager.getState().waiting).toBe(1);

    expect(await manager.take(true)).toEqual({ kind: "done", renamed: 0, review: 1 });
    const state = h.controller.getState();
    expect(state.files.map((f) => f.name)).toEqual(["Inception.2010.mkv"]);
    expect(state.plan).toBe("planned");
    expect(state.operations![0]!.status).toBe("pending");
    expect(await names()).toEqual(["Inception.2010.mkv"]);
    expect(finished).toEqual([{ renamed: 0, review: 1 }]);
    expect(manager.getActivity()[0]).toMatchObject({ kind: "review", reason: "review_mode" });

    // Renamed by the user from the list: not picked up again.
    const outcome = await h.controller.rename();
    expect(outcome.kind).toBe("done");
    await manager.noteRenamed(h.controller.getState().operations);
    expect(await names()).toEqual(["Inception (2010).mkv"]);
    await clock.run(10_000);
    expect(manager.getState().waiting).toBe(0);
    expect(manager.getState().arriving).toBe(0);
  });

  it("in automatic mode renames only unambiguous files and lists the rest for review", async () => {
    const { manager, clock, finished } = await setup({ mode: "automatic" });
    await writeFile(path.join(h.media, "Inception.2010.mkv"), "x");
    await writeFile(path.join(h.media, "The.Matrix.mkv"), "m");
    await clock.run(6_000);
    expect(manager.getState().waiting).toBe(2);

    // The Matrix has three results: the review fetch asks the user.
    const question = h.next(EVENTS.selectionRequest);
    const taking = manager.take(true);
    const request = await question;
    expect(request.filename).toBe("The.Matrix.mkv");
    h.controller.answerSelection(request.id, null);
    expect(await taking).toEqual({ kind: "done", renamed: 1, review: 1 });

    expect(await names()).toEqual(["Inception (2010).mkv", "The.Matrix.mkv"]);
    expect(h.controller.getState().files.map((f) => f.name)).toEqual(["The.Matrix.mkv"]);
    expect(h.controller.getState().lastRename).toMatchObject({ operations: 1 });
    expect(finished).toEqual([{ renamed: 1, review: 1 }]);
    const activity = manager.getActivity();
    expect(activity.find((e) => e.kind === "renamed")).toMatchObject({ path: path.join(h.media, "Inception.2010.mkv") });
    expect(activity.find((e) => e.kind === "review")).toMatchObject({ reason: "several_matches" });
    expect(manager.getState().totals).toMatchObject({ renamed: 1, review: 1 });

    // The renamed file is never picked up again; neither is it after undo.
    await clock.run(10_000);
    expect(manager.getState().waiting).toBe(0);
    await h.controller.undo();
    expect(await names()).toEqual(["Inception.2010.mkv", "The.Matrix.mkv"]);
    await clock.run(10_000);
    expect(manager.getState().waiting).toBe(0);
  });

  it("leaves files present at start alone until asked", async () => {
    const { manager, clock } = await setup({ existing: ["Inception.2010.mkv"] });
    await clock.run(10_000);
    expect(manager.getState()).toMatchObject({ existing: 1, waiting: 0 });
    expect(manager.processExisting()).toBe(1);
    await clock.run(6_000);
    expect(manager.getState().waiting).toBe(1);
  });

  it("does not take files while the app is busy", async () => {
    const { manager, clock } = await setup();
    await writeFile(path.join(h.media, "Inception.2010.mkv"), "x");
    await clock.run(6_000);
    await h.touch("other/Alien.1979.mkv");
    const adding = h.controller.addPaths([path.join(h.media, "other")]);
    expect(await manager.take(true)).toEqual({ kind: "busy" });
    await adding;
    expect(manager.getState().waiting).toBe(1);
  });

  it("pauses and resumes; files that arrived meanwhile are picked up on resume", async () => {
    const { manager, clock } = await setup();
    await manager.setPaused(true);
    expect(manager.getState().paused).toBe(true);
    await writeFile(path.join(h.media, "Inception.2010.mkv"), "x");
    await clock.run(10_000);
    expect(manager.getState().waiting).toBe(0);
    await manager.setPaused(false);
    await clock.run(6_000);
    expect(manager.getState().waiting).toBe(1);
  });

  it("stops watching when turned off in the settings", async () => {
    const { manager, clock } = await setup();
    const settings = await h.config.load();
    await h.controller.saveSettings({ ...(await h.controller.getSettingsPayload()).settings, watch: { ...settings.watch, enabled: false } });
    await manager.apply();
    expect(manager.getState().enabled).toBe(false);
    await writeFile(path.join(h.media, "Inception.2010.mkv"), "x");
    await clock.run(10_000);
    expect(manager.getState().waiting).toBe(0);
  });

  it("does not take a file that became a temporary name again", async () => {
    const { manager, clock } = await setup({ mode: "automatic" });
    await writeFile(path.join(h.media, "Inception.2010.mkv.part"), "x");
    await clock.run(10_000);
    expect(manager.getState()).toMatchObject({ waiting: 0, temporary: 1 });
    await rename(path.join(h.media, "Inception.2010.mkv.part"), path.join(h.media, "Inception.2010.mkv"));
    await clock.run(6_000);
    expect(manager.getState()).toMatchObject({ waiting: 1, temporary: 0 });
  });
});

describe("watchNotification", () => {
  it("reports renamed and review counts", () => {
    expect(watchNotification({ renamed: 0, review: 0 })).toBeNull();
    expect(watchNotification({ renamed: 0, review: 1 })).toEqual({ title: "New Files to Review", body: "1 new file from the watch folders is ready for review." });
    expect(watchNotification({ renamed: 3, review: 2 })).toEqual({ title: "New Files Renamed", body: "Renamed 3 new files from the watch folders; 2 wait for review." });
  });
});
