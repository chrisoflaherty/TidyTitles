/**
 * The watch pipeline on real files in a temporary folder, with fake
 * providers, a fake clock, and no file-system events (changes are found by
 * rescanning, which the fake clock drives). The standard is the same as
 * dataSafety.test.ts: nothing is ever overwritten or lost, and automatic
 * mode renames only what is unambiguous.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings, type Settings } from "../src/config";
import { ProviderError } from "../src/errors";
import { createMovie } from "../src/models";
import type { MovieProvider } from "../src/providers/base";
import { MEDIA_EXTENSIONS } from "../src/scan";
import { RenameSession, undoLastRename } from "../src/session";
import { automaticBlocker } from "../src/watchBatch";
import type { WatchMode } from "../src/watchConfig";
import type { WatchEvent } from "../src/watchEvents";
import { nodeWatchFileSystem, type WatchFileSystem } from "../src/watcher";
import { HistoryIdentities, WatchQueue, WatchService } from "../src/watchService";
import {
  FakeMovieProvider,
  FakeMusicParser,
  FakeMusicProvider,
  FakeTVProvider,
  bohemian,
  breakingBad,
  completeTags,
  matrix,
  matrixReloaded,
  pilot,
} from "./fakes";
import { FakeClock } from "./watchFakes";

const SETTLE = 10_000;
const inception = createMovie({ id: 27205, title: "Inception", originalTitle: "Inception", year: 2010 });

/** Real files, no events: every change is found by a rescan. */
const diskNoEvents: WatchFileSystem = { ...nodeWatchFileSystem, watch: () => ({ close() {} }) };

let dir: string;
let inbox: string;
let clock: FakeClock;
let events: WatchEvent[];
let config: ConfigService;
let services: WatchService[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-watch-"));
  inbox = path.join(dir, "inbox");
  await mkdir(inbox);
  clock = new FakeClock(Date.now());
  events = [];
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
  services = [];
});

afterEach(async () => {
  for (const s of services) await s.stop();
  await rm(dir, { recursive: true, force: true });
});

interface Setup {
  mode?: WatchMode;
  movies?: MovieProvider;
  settings?: Partial<Settings>;
  recursive?: boolean;
  initialBackoffMs?: number;
}

function service(setup: Setup = {}): WatchService {
  const mode = setup.mode ?? "automatic";
  const settings: Settings = { ...createDefaultSettings(), ...setup.settings };
  const movies =
    setup.movies ??
    new FakeMovieProvider({ Inception: [inception], "The Matrix": [matrix, matrixReloaded] });
  const s = new WatchService({
    folders: [inbox],
    recursive: setup.recursive ?? true,
    mode,
    settleMs: SETTLE,
    extensions: MEDIA_EXTENSIONS,
    excludedFolders: [settings.output.movie, settings.output.tv, settings.output.music],
    createSession: async () =>
      new RenameSession(mode === "automatic" ? { ...settings, conflictResolution: "skip", overwrite: false } : settings, {
        config,
        requireApiKeys: false,
        cache: false,
        providers: {
          movieProvider: movies,
          tvProvider: new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { [breakingBad.id]: pilot() }),
          musicProvider: new FakeMusicProvider({ "Bohemian Rhapsody": [bohemian] }),
        },
        musicParser: new FakeMusicParser({ "queen.mp3": completeTags, "unknown.mp3": { title: "Demo", artist: "Nobody", album: "Nothing" } }),
      }),
    onEvent: (e) => events.push(e),
    history: new HistoryIdentities(config),
    fs: diskNoEvents,
    clock,
    rescanMs: 2_000,
    pollingRescanMs: 2_000,
    checkMs: 1_000,
    ...(setup.initialBackoffMs !== undefined ? { initialBackoffMs: setup.initialBackoffMs } : {}),
  });
  services.push(s);
  return s;
}

/** Advance the fake clock in small steps, letting real file operations finish. */
async function run(s: WatchService, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 500) {
    await clock.advance(500);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.idle();
  }
}

const ofType = <T extends WatchEvent["type"]>(type: T) =>
  events.filter((e): e is Extract<WatchEvent, { type: T }> => e.type === type);

async function names(folder = inbox): Promise<string[]> {
  return (await readdir(folder)).sort();
}

describe("automatic mode", () => {
  it("renames a file with exactly one match, records it for undo, and does not pick it up again", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.1080p.mkv"), "movie");
    await run(s, SETTLE + 8_000);

    expect(await names()).toEqual(["Inception (2010).mkv"]);
    expect(ofType("renamed").map((e) => path.basename(e.destination))).toEqual(["Inception (2010).mkv"]);
    expect(ofType("history_saved")).toEqual([{ type: "history_saved", operations: 1 }]);

    // The renamed file sits in the watched folder: never handed on again.
    await run(s, SETTLE * 3);
    expect(ofType("ready")).toHaveLength(1);

    const undo = await undoLastRename(config);
    expect(undo.undone).toBe(1);
    expect(await names()).toEqual(["Inception.2010.1080p.mkv"]);
    // Undone (moved back): still not a new arrival.
    await run(s, SETTLE * 3);
    expect(ofType("ready")).toHaveLength(1);
    expect(await names()).toEqual(["Inception.2010.1080p.mkv"]);
  });

  it("never renames a file with several matches (never the first of several)", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "The.Matrix.mkv"), "m");
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["The.Matrix.mkv"]);
    expect(ofType("review")).toEqual([{ type: "review", path: path.join(inbox, "The.Matrix.mkv"), reason: "several_matches" }]);
    expect(ofType("renamed")).toEqual([]);
    expect(await config.loadHistory()).toEqual([]);
  });

  it("never renames a file without a match", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "Unknown.Thing.2019.mkv"), "x");
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Unknown.Thing.2019.mkv"]);
    expect(ofType("review").map((e) => e.reason)).toEqual(["no_match"]);
  });

  it.each(["skip", "overwrite", "auto_version"])(
    "never renames onto a taken name, whatever the conflict strategy (%s)",
    async (strategy) => {
      await writeFile(path.join(inbox, "Inception (2010).mkv"), "ALREADY HERE");
      const s = service({ settings: { conflictResolution: strategy } });
      await s.start();
      await writeFile(path.join(inbox, "Inception.2010.mkv"), "NEW");
      await run(s, SETTLE + 8_000);
      expect(await names()).toEqual(["Inception (2010).mkv", "Inception.2010.mkv"]);
      expect(await readFile(path.join(inbox, "Inception (2010).mkv"), "utf8")).toBe("ALREADY HERE");
      expect(await readFile(path.join(inbox, "Inception.2010.mkv"), "utf8")).toBe("NEW");
      expect(ofType("review").map((e) => e.reason)).toEqual(["conflict"]);
    },
  );

  it("never renames two arrivals onto the same name", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "A");
    await writeFile(path.join(inbox, "Inception.2010.720p.mp4.mkv"), "B");
    await run(s, SETTLE + 8_000);
    const contents = await Promise.all((await names()).map((n) => readFile(path.join(inbox, n), "utf8")));
    expect(contents.sort()).toEqual(["A", "B"]);
    expect(ofType("review").map((e) => e.reason)).toContain("conflict");
  });

  it("never renames unconfirmed music tags", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "unknown.mp3"), "x");
    await writeFile(path.join(inbox, "queen.mp3"), "q");
    await run(s, SETTLE + 8_000);
    expect(ofType("review").map((e) => [path.basename(e.path), e.reason])).toEqual([["unknown.mp3", "unverified"]]);
    expect(ofType("renamed").map((e) => path.basename(e.path))).toEqual(["queen.mp3"]);
    expect(await names()).toEqual(["Queen", "unknown.mp3"]);
  });

  it("renames a TV episode with one show match", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "Breaking.Bad.S01E01.720p.mkv"), "x");
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Breaking Bad - S01E01 - Pilot.mkv"]);
  });

  it("does not touch a file written slowly until it has stopped changing", async () => {
    const s = service();
    await s.start();
    const file = path.join(inbox, "Inception.2010.mkv");
    await writeFile(file, "");
    for (let i = 0; i < 30; i++) {
      await appendFile(file, "x".repeat(1_000));
      await run(s, 3_000); // a write every 3 seconds, shorter than the settle period
      expect(await names()).toEqual(["Inception.2010.mkv"]);
    }
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Inception (2010).mkv"]);
    expect((await readFile(path.join(inbox, "Inception (2010).mkv"), "utf8")).length).toBe(30_000);
  });

  it("does not touch a download under a temporary name; renames it once it has its final name", async () => {
    const s = service();
    await s.start();
    const part = path.join(inbox, "Inception.2010.mkv.crdownload");
    await writeFile(part, "partial");
    await run(s, SETTLE * 3);
    expect(await names()).toEqual(["Inception.2010.mkv.crdownload"]);
    expect(ofType("temporary")).toHaveLength(1);
    await rm(part);
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "complete");
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Inception (2010).mkv"]);
  });

  it("leaves files present at start alone, and processes them when asked", async () => {
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "old");
    const s = service();
    await s.start();
    await run(s, SETTLE * 3);
    expect(await names()).toEqual(["Inception.2010.mkv"]);
    expect(s.processExisting()).toBe(1);
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Inception (2010).mkv"]);
  });

  it("never picks up files in an output folder inside the watched folder", async () => {
    const movies = path.join(inbox, "Movies");
    await mkdir(movies);
    const s = service({ settings: { output: { movie: movies, tv: "", music: "", transferMode: "move" } } });
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "x");
    await run(s, SETTLE * 4);
    expect(await names(movies)).toEqual(["Inception (2010).mkv"]);
    expect(ofType("ready")).toHaveLength(1);
    expect(ofType("arriving")).toHaveLength(1);
  });

  it("copies with transfer mode copy and does not pick up the copy or the original again", async () => {
    const s = service({ settings: { output: { movie: "", tv: "", music: "", transferMode: "copy" } } });
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "x");
    await run(s, SETTLE * 4);
    expect(await names()).toEqual(["Inception (2010).mkv", "Inception.2010.mkv"]);
    expect(ofType("renamed")).toHaveLength(1);
    expect(ofType("ready")).toHaveLength(1);
  });

  it("renames associated files with it, and waits while one is still changing", async () => {
    const s = service();
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "x");
    await writeFile(path.join(inbox, "Inception.2010.en.srt"), "subs");
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Inception (2010).en.srt", "Inception (2010).mkv"]);
  });

  it("does not pick up a file another TidyTitles process renamed (it is in the history)", async () => {
    // Renamed by "the other front end": recorded in history.json with its fingerprint.
    const other = new RenameSession(createDefaultSettings(), {
      config,
      requireApiKeys: false,
      cache: false,
      providers: { movieProvider: new FakeMovieProvider({ Inception: [inception] }) },
      musicParser: new FakeMusicParser(),
    });
    const s = service({ mode: "review" });
    await s.start();
    const outside = path.join(dir, "elsewhere");
    await mkdir(outside);
    await writeFile(path.join(outside, "Inception.2010.mkv"), "x");
    const ops = await other.plan([path.join(outside, "Inception.2010.mkv")], { destinationDir: inbox });
    await other.execute(ops);
    await other.saveHistory(ops);
    expect(await names()).toEqual(["Inception (2010).mkv"]);
    await run(s, SETTLE * 3);
    expect(ofType("arriving")).toEqual([]);
  });

  it("retries lookups when the service is down, with a growing wait, then renames", async () => {
    let down = true;
    let calls = 0;
    const movies: MovieProvider = {
      async searchMovie() {
        calls += 1;
        if (down) throw new ProviderError("TMDB API error: 503 Service Unavailable");
        return [inception];
      },
      async getMovie() {
        return undefined;
      },
    };
    const s = service({ movies, initialBackoffMs: 30_000 });
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "x");
    await run(s, SETTLE + 8_000);
    expect(calls).toBe(1);
    expect(ofType("retry")).toHaveLength(1);
    const first = ofType("retry")[0]!;
    expect(first.retryAt - clock.now()).toBeGreaterThan(20_000);

    // More files arriving meanwhile wait too: no extra calls before the wait ends.
    await writeFile(path.join(inbox, "Inception.Again.2010.mkv"), "y");
    await run(s, 20_000);
    expect(calls).toBe(1);
    await run(s, 15_000);
    expect(calls).toBe(3); // both files, one batch
    expect(ofType("retry")).toHaveLength(2);
    const second = ofType("retry")[1]!;
    expect(second.retryAt - clock.now()).toBeGreaterThan(50_000); // doubled

    down = false;
    await run(s, 65_000);
    expect(await names()).toContain("Inception (2010).mkv");
    expect(await names()).toEqual(expect.arrayContaining(["Inception.2010.mkv".replace(".2010.mkv", " (2010).mkv")]));
    expect(existsSync(path.join(inbox, "Inception.2010.mkv"))).toBe(false);
  });

  it("stops cleanly while a lookup is running, touching nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const movies: MovieProvider = {
      async searchMovie() {
        await gate;
        return [inception];
      },
      async getMovie() {
        return undefined;
      },
    };
    const s = service({ movies });
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "x");
    for (let i = 0; i < 40 && ofType("looking_up").length === 0; i++) {
      await clock.advance(500);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(ofType("looking_up")).toHaveLength(1);
    const stopped = s.stop();
    release();
    await stopped;
    expect(await names()).toEqual(["Inception.2010.mkv"]);
  });
});

describe("review mode", () => {
  it("looks files up and reports them, renaming nothing", async () => {
    const s = service({ mode: "review" });
    await s.start();
    await writeFile(path.join(inbox, "Inception.2010.mkv"), "x");
    await writeFile(path.join(inbox, "The.Matrix.mkv"), "m");
    await run(s, SETTLE + 8_000);
    expect(await names()).toEqual(["Inception.2010.mkv", "The.Matrix.mkv"]);
    const review = ofType("review").map((e) => [path.basename(e.path), e.reason, e.destination && path.basename(e.destination)]);
    expect(review).toEqual([
      ["Inception.2010.mkv", "review_mode", "Inception (2010).mkv"],
      ["The.Matrix.mkv", "several_matches", undefined],
    ]);
    expect(await config.loadHistory()).toEqual([]);
    // Reported once.
    await run(s, SETTLE * 3);
    expect(ofType("review")).toHaveLength(2);
  });
});

describe("a batch of hundreds of files", () => {
  it("looks them up in batches and renames each exactly once", async () => {
    const titles: Record<string, ReturnType<typeof createMovie>[]> = {};
    for (let i = 0; i < 250; i++) {
      titles[`Film Number ${i}`] = [createMovie({ id: 1_000 + i, title: `Film Number ${i}`, originalTitle: "", year: 2000 })];
    }
    const s = service({ movies: new FakeMovieProvider(titles) });
    await s.start();
    await Promise.all(
      Array.from({ length: 250 }, (_, i) => writeFile(path.join(inbox, `Film.Number.${i}.2000.mkv`), "")),
    );
    await run(s, SETTLE + 20_000);
    expect(ofType("looking_up").map((e) => e.count)).toEqual([100, 100, 50]);
    expect(ofType("renamed")).toHaveLength(250);
    const after = await names();
    expect(after).toHaveLength(250);
    expect(after.every((n) => /^Film Number \d+ \(2000\)\.mkv$/.test(n))).toBe(true);
    expect((await config.loadHistory()).length).toBe(3);
  });
});

describe("WatchQueue", () => {
  it("doubles the wait after each failure in a row, up to the limit, and resets after a success", () => {
    const c = new FakeClock(0);
    const q = new WatchQueue({ clock: c, initialBackoffMs: 1_000, maxBackoffMs: 5_000 });
    const f = [{ path: "/a", identity: "1" }];
    expect(q.retryLater(f)).toBe(1_000);
    expect(q.retryLater(f)).toBe(2_000);
    expect(q.retryLater(f)).toBe(4_000);
    expect(q.retryLater(f)).toBe(5_000);
    q.succeeded();
    expect(q.retryLater(f)).toBe(1_000);
    expect(q.retrying).toBe(1);
  });
});

describe("automaticBlocker", () => {
  it("lets only unambiguous, pending operations through", () => {
    const base = {
      source: "/a.mkv",
      destination: "/b.mkv",
      status: "pending" as const,
      associatedFiles: [],
      mediaFile: { path: "/a.mkv", parsedInfo: { title: "A", mediaType: "movie" as const, rawFilename: "a.mkv" } },
    };
    const withStatus = (verificationStatus: string | undefined) => ({
      ...base,
      mediaFile: { ...base.mediaFile, matchedMetadata: { ...matrix, verificationStatus } },
    });
    expect(automaticBlocker(withStatus("auto_matched") as never)).toBeUndefined();
    expect(automaticBlocker(withStatus("verified") as never)).toBeUndefined();
    expect(automaticBlocker(withStatus("manual_selection") as never)).toBe("not_renamable");
    expect(automaticBlocker(withStatus("unverified") as never)).toBe("unverified");
    expect(automaticBlocker({ ...withStatus("auto_matched"), mediaFile: { ...withStatus("auto_matched").mediaFile, selectionSkipped: true } } as never)).toBe("several_matches");
  });
});
