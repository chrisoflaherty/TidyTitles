import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MEDIA_EXTENSIONS } from "../src/scan";
import type { WatchEvent } from "../src/watchEvents";
import { FINDER_BUSY_BIRTHTIME_MS } from "../src/watchNames";
import { FolderWatcher, normalizeWatchFolders, type FolderWatcherOptions, type ReadyFile } from "../src/watcher";
import { FakeClock, MemoryFs } from "./watchFakes";

const ROOT = path.resolve("/watch/downloads");
const SETTLE = 10_000;
const at = (...parts: string[]) => path.join(ROOT, ...parts);

let clock: FakeClock;
let fs: MemoryFs;
let events: WatchEvent[];
let ready: ReadyFile[];

function create(options: Partial<FolderWatcherOptions> = {}): FolderWatcher {
  return new FolderWatcher({
    folders: [ROOT],
    recursive: true,
    extensions: MEDIA_EXTENSIONS,
    settleMs: SETTLE,
    fs,
    clock,
    onEvent: (e) => events.push(e),
    onReady: (files) => ready.push(...files),
    ...options,
  });
}

const readyPaths = () => ready.map((f) => f.path);
const ofType = <T extends WatchEvent["type"]>(type: T) =>
  events.filter((e): e is Extract<WatchEvent, { type: T }> => e.type === type);

beforeEach(() => {
  clock = new FakeClock();
  fs = new MemoryFs(clock);
  fs.mkdir(ROOT);
  events = [];
  ready = [];
});

describe("files present at start", () => {
  it("leaves them alone and reports how many there were", async () => {
    fs.write(at("Old.Movie.2001.mkv"), 100);
    fs.write(at("sub", "Other.2002.mp4"), 100);
    const watcher = create();
    await watcher.start();
    await clock.advance(60_000);
    expect(ready).toEqual([]);
    expect(ofType("started")[0]!.folders).toEqual([{ folder: ROOT, status: "ok", existing: 2, polling: false }]);
    watcher.stop();
  });

  it("processes them only when asked, after they settle", async () => {
    fs.write(at("Old.Movie.2001.mkv"), 100);
    const watcher = create();
    await watcher.start();
    expect(watcher.processExisting()).toBe(1);
    await clock.advance(SETTLE - 2_000);
    expect(ready).toEqual([]);
    await clock.advance(5_000);
    expect(readyPaths()).toEqual([at("Old.Movie.2001.mkv")]);
    watcher.stop();
  });
});

describe("new files", () => {
  it("hands a copied file on once it has not changed for the settle period", async () => {
    const watcher = create();
    await watcher.start();
    fs.write(at("Inception.2010.mkv"), 5_000);
    fs.fire(at("Inception.2010.mkv"));
    await clock.advance(1_000);
    expect(ofType("arriving").map((e) => e.path)).toEqual([at("Inception.2010.mkv")]);
    await clock.advance(SETTLE - 1_000);
    expect(ready).toEqual([]);
    await clock.advance(2_000);
    expect(readyPaths()).toEqual([at("Inception.2010.mkv")]);
    expect(ofType("ready")).toHaveLength(1);
    watcher.stop();
  });

  it("finds new files without any file-system event, by rescanning", async () => {
    const watcher = create({ rescanMs: 30_000 });
    await watcher.start();
    fs.write(at("Inception.2010.mkv"), 5_000);
    await clock.advance(29_000);
    expect(ofType("arriving")).toEqual([]);
    await clock.advance(2_000 + SETTLE + 1_000);
    expect(readyPaths()).toEqual([at("Inception.2010.mkv")]);
    watcher.stop();
  });

  it("waits while a file written slowly keeps growing, however long it takes", async () => {
    const watcher = create();
    await watcher.start();
    const file = fs.write(at("Big.Movie.2020.mkv"), 0);
    fs.fire(file);
    // 2 minutes of writing, a few bytes every 3 seconds (well under the settle period).
    for (let t = 0; t < 120_000; t += 3_000) {
      fs.append(file, 1_000_000);
      await clock.advance(3_000);
      expect(ready).toEqual([]);
    }
    await clock.advance(SETTLE + 1_000);
    expect(readyPaths()).toEqual([file]);
    watcher.stop();
  });

  it("ignores files that are not media", async () => {
    const watcher = create();
    await watcher.start();
    fs.write(at("notes.txt"), 10);
    fs.write(at("Movie.2010.nfo"), 10);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 3);
    expect(ready).toEqual([]);
    expect(events.filter((e) => e.type !== "started")).toEqual([]);
    watcher.stop();
  });

  it("only looks at the top folder without recursion", async () => {
    const watcher = create({ recursive: false });
    await watcher.start();
    fs.write(at("sub", "Deep.2010.mkv"), 10);
    fs.write(at("Top.2010.mkv"), 10);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 2);
    expect(readyPaths()).toEqual([at("Top.2010.mkv")]);
    watcher.stop();
  });

  it("reports a file that disappears before it settles", async () => {
    const watcher = create();
    await watcher.start();
    const file = fs.write(at("Short.Lived.2010.mkv"), 10);
    fs.fire(file);
    await clock.advance(2_000);
    fs.remove(file);
    await clock.advance(SETTLE * 2);
    expect(ready).toEqual([]);
    expect(ofType("gone").map((e) => e.path)).toEqual([file]);
    watcher.stop();
  });
});

describe("temporary download names", () => {
  it.each([
    "Movie.2010.mkv.part",
    "Movie.2010.mkv.crdownload",
    "Movie.2010.mkv.!qB",
    "Movie.2010.mkv.download",
    "Movie.2010.mkv.tmp",
    "Movie.2010.mkv.partial",
    ".Movie.2010.mkv.Xa81z2",
    "Movie.2010.mkv.aria2",
  ])("never hands on %s, and picks the file up under its final name", async (temp) => {
    const watcher = create();
    await watcher.start();
    const tempPath = fs.write(at(temp), 1_000);
    fs.fire(tempPath);
    await clock.advance(SETTLE * 5);
    expect(ready).toEqual([]);

    if (!temp.endsWith(".aria2") && !temp.startsWith(".")) {
      expect(ofType("temporary").map((e) => e.finalName)).toEqual(["Movie.2010.mkv"]);
    }
    fs.rename(tempPath, at("Movie.2010.mkv"));
    fs.fire(ROOT);
    await clock.advance(SETTLE + 2_000);
    expect(readyPaths()).toEqual([at("Movie.2010.mkv")]);
    watcher.stop();
  });

  it("waits while a companion (Firefox's .part, aria2's .aria2) sits next to the final name", async () => {
    const watcher = create();
    await watcher.start();
    const file = fs.write(at("Movie.2010.mkv"), 0); // Firefox's empty placeholder
    const part = fs.write(at("Movie.2010.mkv.part"), 1_000);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 4);
    expect(ready).toEqual([]);
    // Done: the .part replaces the placeholder.
    fs.remove(file);
    fs.rename(part, file);
    fs.fire(ROOT);
    await clock.advance(SETTLE + 2_000);
    expect(readyPaths()).toEqual([file]);
    watcher.stop();
  });

  it("does not scan inside a Safari .download bundle or hidden folders", async () => {
    const watcher = create();
    await watcher.start();
    fs.write(at("Movie.2010.mkv.download", "Movie.2010.mkv"), 1_000);
    fs.write(at(".hidden", "Movie.2011.mkv"), 1_000);
    fs.write(at("@eaDir", "Movie.2012.mkv"), 1_000);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 3);
    expect(ready).toEqual([]);
    watcher.stop();
  });

  it("waits while Finder is still copying a file (macOS busy creation date)", async () => {
    const watcher = create();
    await watcher.start();
    const file = fs.write(at("Copying.2010.mkv"), 1_000);
    fs.setBirthtime(file, FINDER_BUSY_BIRTHTIME_MS);
    fs.fire(file);
    await clock.advance(SETTLE * 4);
    expect(ready).toEqual([]);
    fs.setBirthtime(file, clock.now());
    await clock.advance(SETTLE + 2_000);
    expect(readyPaths()).toEqual([file]);
    watcher.stop();
  });
});

describe("no loops", () => {
  it("never hands on a file again after it was handled, under any name", async () => {
    const watcher = create();
    await watcher.start();
    const file = fs.write(at("Inception.2010.mkv"), 1_000);
    fs.fire(file);
    await clock.advance(SETTLE + 2_000);
    expect(ready).toHaveLength(1);

    // Renamed in place (same inode), as a move does, then remembered.
    fs.rename(file, at("Inception (2010).mkv"));
    await watcher.markHandled([at("Inception (2010).mkv")]);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 3);
    // Undone (moved back): still the same file.
    fs.rename(at("Inception (2010).mkv"), file);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 3);
    expect(ready).toHaveLength(1);
    expect(ofType("arriving")).toHaveLength(1);
    watcher.stop();
  });

  it("recognizes files known from the history", async () => {
    const watcher = create({ isKnown: () => true });
    await watcher.start();
    fs.write(at("Inception (2010).mkv"), 1_000);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 3);
    expect(ready).toEqual([]);
    expect(ofType("arriving")).toEqual([]);
    watcher.stop();
  });

  it("never scans output folders inside a watched folder", async () => {
    const watcher = create({ excludedFolders: [at("Movies")] });
    await watcher.start();
    fs.write(at("Movies", "Inception (2010)", "Inception (2010).mkv"), 1_000);
    fs.write(at("Incoming.2010.mkv"), 1_000);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 2);
    expect(readyPaths()).toEqual([at("Incoming.2010.mkv")]);
    watcher.stop();
  });
});

describe("real life", () => {
  it("survives a watched folder that disappears and comes back", async () => {
    const watcher = create({ pollingRescanMs: 5_000 });
    fs.write(at("Before.2001.mkv"), 1_000);
    await watcher.start();
    const settling = fs.write(at("Settling.2002.mkv"), 1_000);
    fs.fire(ROOT);
    await clock.advance(1_000);

    fs.removeDir(ROOT); // unplugged
    fs.fire(ROOT);
    await clock.advance(2_000);
    expect(ofType("folder_missing").map((e) => e.folder)).toEqual([ROOT]);
    await clock.advance(60_000);
    expect(ofType("folder_missing")).toHaveLength(1); // reported once

    // Plugged back in with the old files and one that arrived meanwhile.
    fs.mkdir(ROOT);
    fs.write(at("Before.2001.mkv"), 1_000);
    fs.write(at("Settling.2002.mkv"), 1_000);
    fs.write(at("Meanwhile.2003.mkv"), 1_000);
    await clock.advance(6_000);
    expect(ofType("folder_restored")).toEqual([{ type: "folder_restored", folder: ROOT, existing: 2 }]);
    // Watched again: a new file after the return is handed on.
    const later = fs.write(at("After.2004.mkv"), 1_000);
    fs.fire(later);
    await clock.advance(SETTLE + 2_000);
    // The file that was still arriving is not lost: it is handed on once settled.
    expect(readyPaths().sort()).toEqual([later, settling].sort());
    expect(ofType("gone")).toEqual([]);
    watcher.stop();
  });

  it("falls back to rescanning when file-system events are not available", async () => {
    fs.watchThrows = "ENOSPC";
    const watcher = create({ pollingRescanMs: 5_000 });
    await watcher.start();
    expect(ofType("polling")).toHaveLength(1);
    fs.write(at("Inception.2010.mkv"), 1_000);
    await clock.advance(5_000 + SETTLE + 2_000);
    expect(readyPaths()).toEqual([at("Inception.2010.mkv")]);
    watcher.stop();
  });

  it("keeps going when a watch stops working", async () => {
    const watcher = create({ pollingRescanMs: 5_000 });
    await watcher.start();
    fs.failWatchers(Object.assign(new Error("watch failed"), { code: "EMFILE" }));
    fs.write(at("Inception.2010.mkv"), 1_000);
    await clock.advance(5_000 + SETTLE + 2_000);
    expect(readyPaths()).toEqual([at("Inception.2010.mkv")]);
    watcher.stop();
  });

  it("reports an unreadable subfolder once and keeps watching the rest", async () => {
    const watcher = create();
    fs.mkdir(at("locked"));
    fs.errors.set(at("locked"), "EACCES");
    await watcher.start();
    fs.write(at("Fine.2010.mkv"), 1_000);
    fs.fire(ROOT);
    await clock.advance(SETTLE * 2);
    await clock.advance(120_000);
    expect(readyPaths()).toEqual([at("Fine.2010.mkv")]);
    expect(ofType("folder_error").map((e) => [e.folder, e.code])).toEqual([[at("locked"), "EACCES"]]);
    watcher.stop();
  });

  it("reports a watched folder it cannot read, and recovers when it can", async () => {
    fs.errors.set(ROOT, "EACCES");
    const watcher = create({ pollingRescanMs: 5_000 });
    await watcher.start();
    expect(ofType("folder_error").map((e) => e.code)).toEqual(["EACCES"]);
    fs.errors.delete(ROOT);
    await clock.advance(6_000);
    expect(ofType("folder_restored")).toHaveLength(1);
    watcher.stop();
  });

  it("reports a file it cannot examine", async () => {
    const watcher = create();
    await watcher.start();
    const file = fs.write(at("Locked.2010.mkv"), 1_000);
    fs.errors.set(file, "EACCES");
    fs.fire(file);
    await clock.advance(SETTLE * 2);
    expect(ready).toEqual([]);
    expect(ofType("unreadable").map((e) => e.path)).toEqual([file]);
    watcher.stop();
  });

  it("hands on thousands of files at once without examining them over and over", async () => {
    const watcher = create();
    await watcher.start();
    for (let i = 0; i < 3_000; i++) fs.write(at(`Movie.Number.${i}.2010.mkv`), 0);
    fs.fire(ROOT);
    await clock.advance(SETTLE + 3_000);
    expect(ready).toHaveLength(3_000);
    expect(new Set(readyPaths()).size).toBe(3_000);
    // One stat to notice, one per check until settled (about settle / check interval), one at hand-over.
    expect(fs.statCalls / 3_000).toBeLessThan(20);
    watcher.stop();
  });

  it("stops cleanly: no timers left behind", async () => {
    const watcher = create();
    await watcher.start();
    fs.write(at("Inception.2010.mkv"), 1_000);
    fs.fire(ROOT);
    await clock.advance(1_000);
    watcher.stop();
    expect(clock.pending).toBe(0);
    expect(fs.watchers.every((w) => w.closed)).toBe(true);
  });
});

describe("normalizeWatchFolders", () => {
  it("drops duplicates and folders inside another watched folder", () => {
    const a = path.resolve("/a");
    const ab = path.resolve("/a/b");
    const c = path.resolve("/c");
    expect(normalizeWatchFolders([ab, a, c, a], true, "linux")).toEqual([a, c]);
    expect(normalizeWatchFolders([ab, a], false, "linux")).toEqual([ab, a]);
  });
});
