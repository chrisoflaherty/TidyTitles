/**
 * A longer history, and undo of any entry in it: safe after later renames
 * touched the same files, compatible with history files from older
 * versions.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, DEFAULT_HISTORY_LIMIT, createDefaultSettings, parseSettings } from "../src/config";
import { ConfigError, HistoryChangedError } from "../src/errors";
import { createRenameOperation } from "../src/models";
import { FileRenamer } from "../src/renamer";
import { listHistory, recordHistory, undoHistoryEntry, undoLastRename } from "../src/session";
import { touch } from "./fakes";

let dir: string;
let media: string;
let config: ConfigService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-history-"));
  media = path.join(dir, "media");
  await mkdir(media);
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
  await config.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const names = async () => (await readdir(media)).sort();

/** Rename files with a real FileRenamer and record the batch, like a front end does. */
async function renameBatch(pairs: Array<[string, string]>, mode: "move" | "copy" | "hardlink" = "move") {
  const ops = pairs.map(([from, to]) =>
    createRenameOperation({
      source: path.join(media, from),
      destination: path.join(media, to),
      mediaFile: { path: path.join(media, from), parsedInfo: { title: from, mediaType: "movie", rawFilename: from } },
    }),
  );
  await new FileRenamer({ transferMode: mode }).execute(ops);
  for (const op of ops) expect(op.status).toBe("completed");
  await recordHistory(config, ops);
  // Distinct timestamps (they have millisecond precision).
  await new Promise((r) => setTimeout(r, 5));
  return (await config.loadHistory())[0]!.timestamp;
}

describe("history limit", () => {
  it("defaults to 200 entries", () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(200);
    expect(createDefaultSettings().history.maxEntries).toBe(200);
  });

  it("is configurable, within bounds", () => {
    expect(parseSettings("[history]\nmax_entries = 25\n").history.maxEntries).toBe(25);
    expect(parseSettings(undefined, { FILE_RENAMER_HISTORY__MAX_ENTRIES: "40" }).history.maxEntries).toBe(40);
    expect(() => parseSettings("[history]\nmax_entries = 0\n")).toThrow(ConfigError);
    expect(() => parseSettings("[history]\nmax_entries = 2.5\n")).toThrow(ConfigError);
    expect(() => parseSettings("[history]\nmax_entries = 99999\n")).toThrow(ConfigError);
  });

  it("keeps far more than 10 entries by default", async () => {
    for (let i = 0; i < 30; i++) await config.saveHistory([{ source: `/s${i}`, destination: `/d${i}`, associatedFiles: [] }]);
    expect(await config.loadHistory()).toHaveLength(30);
  });

  it("drops nothing when the settings cannot be loaded (the limit is unknown)", async () => {
    await config.saveHistory([{ source: "/a", destination: "/b", associatedFiles: [] }]);
    await writeFile(config.configFile, "[history]\nmax_entries = 1\n");
    const fresh = new ConfigService({ configDir: config.configDir, cacheDir: config.cacheDir, env: {} });
    await fresh.saveHistory([{ source: "/c", destination: "/d", associatedFiles: [] }]);
    expect(await fresh.loadHistory()).toHaveLength(1);

    await writeFile(config.configFile, "not toml [");
    const broken = new ConfigService({ configDir: config.configDir, cacheDir: config.cacheDir, env: {} });
    await broken.saveHistory([{ source: "/e", destination: "/f", associatedFiles: [] }]);
    expect(await broken.loadHistory()).toHaveLength(2);
  });

  it("loads 200 entries of 50 files quickly", async () => {
    const op = (i: number) => ({
      source: `/Volumes/Media/Downloads/Some.Movie.Title.${i}.2019.1080p.BluRay.x264-GROUP.mkv`,
      destination: `/Volumes/Media/Movies/Some Movie Title ${i} (2019)/Some Movie Title ${i} (2019).mkv`,
      associated_files: [
        {
          source: `/Volumes/Media/Downloads/Some.Movie.Title.${i}.2019.1080p.BluRay.x264-GROUP.en.srt`,
          destination: `/Volumes/Media/Movies/Some Movie Title ${i} (2019)/Some Movie Title ${i} (2019).en.srt`,
          fingerprint: { dev: "16777230", ino: "72772884", size: "48213", mtime_ns: "1795277996234976162" },
        },
      ],
      fingerprint: { dev: "16777230", ino: "72772881", size: "8123456789", mtime_ns: "1795277996234492618" },
    });
    const history = Array.from({ length: 200 }, (_, e) => ({
      timestamp: `2026-11-${String((e % 28) + 1).padStart(2, "0")}T19:05:42.123000`,
      operations: Array.from({ length: 50 }, (_, i) => op(e * 50 + i)),
    }));
    await mkdir(config.configDir, { recursive: true });
    const text = JSON.stringify(history, null, 2);
    await writeFile(config.historyFile, text);
    const started = performance.now();
    const loaded = await config.loadHistory();
    const elapsed = performance.now() - started;
    expect(loaded).toHaveLength(200);
    // About 9 MB for this worst case; generous bound so slow CI machines pass.
    expect(text.length).toBeLessThan(12_000_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("history format", () => {
  it("loads entries from older versions (no fingerprints) unchanged", async () => {
    const legacy = [
      {
        timestamp: "2026-11-14T19:05:42.123000",
        operations: [{ source: "/a", destination: "/b", associated_files: [{ source: "/a.srt", destination: "/b.srt" }] }],
        note: "unknown key",
      },
    ];
    await mkdir(config.configDir, { recursive: true });
    await writeFile(config.historyFile, JSON.stringify(legacy));
    expect(await config.loadHistory()).toEqual([
      {
        timestamp: "2026-11-14T19:05:42.123000",
        operations: [{ source: "/a", destination: "/b", associatedFiles: [{ source: "/a.srt", destination: "/b.srt" }] }],
      },
    ]);
    // A new entry keeps the old one, unknown key included.
    await config.saveHistory([{ source: "/c", destination: "/d", associatedFiles: [] }]);
    const raw = JSON.parse(await readFile(config.historyFile, "utf8"));
    expect(raw).toHaveLength(2);
    expect(raw[1]).toEqual(legacy[0]);
  });

  it("ignores a malformed fingerprint instead of trusting it", async () => {
    await mkdir(config.configDir, { recursive: true });
    await writeFile(
      config.historyFile,
      JSON.stringify([
        { timestamp: "t", operations: [{ source: "/a", destination: "/b", transfer: "copy", fingerprint: { dev: 1, ino: "x" } }] },
      ]),
    );
    const [entry] = await config.loadHistory();
    expect(entry!.operations[0]).toEqual({ source: "/a", destination: "/b", associatedFiles: [], transfer: "copy" });
  });
});

describe("listHistory", () => {
  it("summarizes entries, most recent first", async () => {
    await touch(media, "a.mkv");
    await touch(media, "b.mkv");
    await renameBatch([["a.mkv", "Alpha.mkv"]]);
    await renameBatch([["b.mkv", "Beta.mkv"]], "copy");
    const list = await listHistory(config);
    expect(list.map((e) => [e.position, e.operations, e.transfer])).toEqual([
      [0, 1, "copy"],
      [1, 1, "move"],
    ]);
    expect(list[0]!.samples).toEqual([{ source: path.join(media, "b.mkv"), destination: path.join(media, "Beta.mkv") }]);
  });
});

describe("undoHistoryEntry", () => {
  it("undoes an older entry and leaves the later ones alone", async () => {
    await touch(media, "a.mkv", "A");
    await touch(media, "b.mkv", "B");
    const first = await renameBatch([["a.mkv", "Alpha.mkv"]]);
    await renameBatch([["b.mkv", "Beta.mkv"]]);

    const result = await undoHistoryEntry(config, first);
    expect(result).toMatchObject({ undone: 1, kept: 0, failed: 0 });
    expect(await names()).toEqual(["Beta.mkv", "a.mkv"]);
    const history = await config.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.operations[0]!.destination).toBe(path.join(media, "Beta.mkv"));
  });

  it("follows a file a later rename moved back to the same name (still the same file)", async () => {
    await touch(media, "a.mkv", "A");
    const first = await renameBatch([["a.mkv", "Alpha.mkv"]]);
    await renameBatch([["Alpha.mkv", "Temp.mkv"]]);
    await renameBatch([["Temp.mkv", "Alpha.mkv"]]);
    const result = await undoHistoryEntry(config, first);
    expect(result).toMatchObject({ undone: 1 });
    expect(await readFile(path.join(media, "a.mkv"), "utf8")).toBe("A");
  });

  it("skips a file that a later rename moved away, without guessing where it went", async () => {
    await touch(media, "a.mkv", "A");
    const first = await renameBatch([["a.mkv", "Alpha.mkv"]]);
    await renameBatch([["Alpha.mkv", "Film.mkv"]]);
    const result = await undoHistoryEntry(config, first);
    expect(result).toMatchObject({ undone: 0, missing: 1, failed: 0 });
    expect(await names()).toEqual(["Film.mkv"]);
  });

  it("leaves a different file that a later rename put at the same name", async () => {
    await touch(media, "a.mkv", "A");
    await touch(media, "other.mkv", "OTHER");
    const first = await renameBatch([["a.mkv", "Movie.mkv"]]);
    await renameBatch([["Movie.mkv", "Film.mkv"]]);
    await renameBatch([["other.mkv", "Movie.mkv"]]);

    const result = await undoHistoryEntry(config, first);
    expect(result).toMatchObject({ undone: 0, kept: 1, failed: 0 });
    expect(result.items[0]!.kept).toEqual([{ path: path.join(media, "Movie.mkv"), reason: "changed" }]);
    expect(await readFile(path.join(media, "Movie.mkv"), "utf8")).toBe("OTHER");
    expect(existsSync(path.join(media, "a.mkv"))).toBe(false);
  });

  it("never moves a file onto a name a later rename filled", async () => {
    await touch(media, "a.mkv", "A");
    const first = await renameBatch([["a.mkv", "Renamed.mkv"]]);
    await touch(media, "b.mkv", "B");
    await renameBatch([["b.mkv", "a.mkv"]]);
    const result = await undoHistoryEntry(config, first);
    expect(result).toMatchObject({ undone: 0, failed: 1 });
    expect(await readFile(path.join(media, "a.mkv"), "utf8")).toBe("B");
    expect(await readFile(path.join(media, "Renamed.mkv"), "utf8")).toBe("A");
    // Kept in the history so it can be retried.
    expect(await config.loadHistory()).toHaveLength(2);
  });

  it("leaves files of an entry from an older version alone when a later entry touched them", async () => {
    await touch(media, "Movie.mkv", "OTHER");
    await touch(media, "x.mkv", "X");
    await mkdir(config.configDir, { recursive: true });
    // Legacy entry: a.mkv -> Movie.mkv, no fingerprint. A later entry renamed
    // Movie.mkv away and put other.mkv there (only paths are known).
    await writeFile(
      config.historyFile,
      JSON.stringify([
        {
          timestamp: "2026-11-15T10:00:00",
          operations: [{ source: path.join(media, "other.mkv"), destination: path.join(media, "Movie.mkv"), associated_files: [] }],
        },
        {
          timestamp: "2026-11-14T10:00:00",
          operations: [
            { source: path.join(media, "a.mkv"), destination: path.join(media, "Movie.mkv"), associated_files: [] },
            { source: path.join(media, "y.mkv"), destination: path.join(media, "x.mkv"), associated_files: [] },
          ],
        },
      ]),
    );
    const result = await undoHistoryEntry(config, "2026-11-14T10:00:00");
    expect(result.items.map((i) => i.status)).toEqual(["undone", "kept"]);
    expect(result.items[1]!.kept[0]!.reason).toBe("renamed_later");
    expect(await names()).toEqual(["Movie.mkv", "y.mkv"]);
    expect(await readFile(path.join(media, "Movie.mkv"), "utf8")).toBe("OTHER");
  });

  it("undoes an older copy entry by removing only its copies", async () => {
    await touch(media, "a.mkv", "A");
    await touch(media, "b.mkv", "B");
    const first = await renameBatch([["a.mkv", "Copy of A.mkv"]], "copy");
    await renameBatch([["b.mkv", "Beta.mkv"]]);
    expect(await undoHistoryEntry(config, first)).toMatchObject({ undone: 1 });
    expect(await names()).toEqual(["Beta.mkv", "a.mkv"]);
  });

  it("throws HistoryChangedError for an entry that is no longer there", async () => {
    await touch(media, "a.mkv", "A");
    const first = await renameBatch([["a.mkv", "Alpha.mkv"]]);
    await undoLastRename(config);
    await expect(undoHistoryEntry(config, first)).rejects.toBeInstanceOf(HistoryChangedError);
    expect(await names()).toEqual(["a.mkv"]);
  });
});
