/**
 * Copy and hard-link modes: rename, failure, and undo paths. The rule from
 * dataSafety.test.ts holds for every mode: no file is ever overwritten or
 * lost, and the original is never touched by a copy, a link, or their undo.
 */

import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings, type Settings } from "../src/config";
import { createRenameOperation, type RenameOperation } from "../src/models";
import { FileRenamer } from "../src/renamer";
import { createSession, undoLastRename } from "../src/session";
import {
  fingerprintOf,
  hardLink,
  safeCopy,
  undoTransferredFile,
  type TransferMode,
} from "../src/transfer";
import { FakeMovieProvider, FakeMusicParser, matrix, touch } from "./fakes";

let dir: string;
let media: string;
let config: ConfigService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-transfer-"));
  media = path.join(dir, "media");
  await mkdir(media);
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MATRIX_FILE = "The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv";
const MATRIX_SRT = "The.Matrix.1999.1080p.BluRay.x264-SPARKS.en.srt";
const RENAMED = "The Matrix (1999).mkv";
const RENAMED_SRT = "The Matrix (1999).en.srt";

async function session(mode: TransferMode, extra: (s: Settings) => void = () => {}) {
  const settings = createDefaultSettings();
  settings.api.tmdbApiKey = "key";
  settings.output.transferMode = mode;
  extra(settings);
  await config.save(settings);
  return createSession(config, {
    cache: false,
    musicParser: new FakeMusicParser(),
    providers: { movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) },
  });
}

/** Files in `dir`, ignoring nothing (temporary files would show up here). */
async function list(d: string): Promise<string[]> {
  return (await readdir(d)).sort();
}

function op(source: string, destination: string): RenameOperation {
  return createRenameOperation({
    source,
    destination,
    mediaFile: { path: source, parsedInfo: { title: "x", mediaType: "movie", rawFilename: path.basename(source) } },
  });
}

describe.each(["copy", "hardlink"] as const)("%s mode", (mode) => {
  it("creates the new name and leaves the original untouched", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    const srt = await touch(media, MATRIX_SRT, "SUBS");
    const before = statSync(movie);
    const s = await session(mode);

    const ops = await s.plan([movie]);
    await s.execute(ops);

    expect(ops[0]).toMatchObject({ status: "completed" });
    expect(await list(media)).toEqual([MATRIX_SRT, MATRIX_FILE, RENAMED_SRT, RENAMED].sort());
    expect(await readFile(path.join(media, RENAMED), "utf8")).toBe("MOVIE");
    // Associated files use the same mode as their media file.
    expect(await readFile(path.join(media, RENAMED_SRT), "utf8")).toBe("SUBS");
    expect(ops[0]!.transfer?.mode).toBe(mode);
    expect(ops[0]!.associatedFiles[0]!.transfer?.mode).toBe(mode);

    const after = statSync(movie);
    expect(await readFile(srt, "utf8")).toBe("SUBS");
    expect(after.size).toBe(before.size);
    const created = statSync(path.join(media, RENAMED));
    if (mode === "hardlink") {
      expect(created.ino).toBe(after.ino);
      expect(after.nlink).toBe(2);
    } else {
      expect(created.ino).not.toBe(after.ino);
      // The copy keeps the original's modification time.
      expect(Math.abs(created.mtimeMs - before.mtimeMs)).toBeLessThan(2_000);
    }
  });

  it("records the mode and a fingerprint in history, and undo removes only what it made", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    await touch(media, MATRIX_SRT, "SUBS");
    const s = await session(mode);
    const ops = await s.plan([movie]);
    await s.execute(ops);
    await s.saveHistory(ops);

    const raw = JSON.parse(await readFile(config.historyFile, "utf8"));
    expect(raw[0].operations[0]).toMatchObject({ transfer: mode, fingerprint: { size: "5" } });
    expect(raw[0].operations[0].associated_files[0]).toMatchObject({ transfer: mode });

    const result = await undoLastRename(config);
    expect(result).toMatchObject({ undone: 1, kept: 0, failed: 0 });
    expect(await list(media)).toEqual([MATRIX_SRT, MATRIX_FILE].sort());
    expect(await readFile(movie, "utf8")).toBe("MOVIE");
    expect(statSync(movie).nlink).toBe(1);
    expect(await config.loadHistory()).toEqual([]);
  });

  it("undo leaves a copy or link that was replaced since, and reports it", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    const s = await session(mode);
    const ops = await s.plan([movie]);
    await s.execute(ops);
    await s.saveHistory(ops);

    // Someone replaced the new file with another one.
    const created = path.join(media, RENAMED);
    await unlink(created);
    await writeFile(created, "SOMETHING ELSE");

    const result = await undoLastRename(config);
    expect(result).toMatchObject({ undone: 0, kept: 1, failed: 0 });
    expect(result.items[0]!.kept).toEqual([{ path: created, reason: "changed" }]);
    expect(await readFile(created, "utf8")).toBe("SOMETHING ELSE");
    expect(await readFile(movie, "utf8")).toBe("MOVIE");
    // A changed file will never be ours again: the entry is done.
    expect(await config.loadHistory()).toEqual([]);
  });

  it("undo never removes a copy or link whose original is gone (it may be the only copy)", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    const s = await session(mode);
    const ops = await s.plan([movie]);
    await s.execute(ops);
    await s.saveHistory(ops);
    await unlink(movie);

    const result = await undoLastRename(config);
    expect(result).toMatchObject({ undone: 0, kept: 1 });
    expect(result.items[0]!.kept[0]!.reason).toBe("original_missing");
    expect(await readFile(path.join(media, RENAMED), "utf8")).toBe("MOVIE");
    // Kept in the history: undo works once the original is back (a drive reconnected).
    expect(await config.loadHistory()).toHaveLength(1);
  });

  it("never replaces an existing file when the conflict strategy is skip", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    await touch(media, RENAMED, "EXISTING");
    const s = await session(mode);
    const ops = await s.plan([movie]);
    await s.execute(ops);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "would_overwrite" });
    expect(await readFile(path.join(media, RENAMED), "utf8")).toBe("EXISTING");
    expect(await list(media)).toEqual([MATRIX_FILE, RENAMED].sort());
  });

  it("adds a number with the auto_version strategy", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    await touch(media, RENAMED, "EXISTING");
    const s = await session(mode, (settings) => {
      settings.conflictResolution = "auto_version";
    });
    const ops = await s.plan([movie]);
    await s.execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(path.join(media, RENAMED), "utf8")).toBe("EXISTING");
    expect(await readFile(path.join(media, "The Matrix (1999) (1).mkv"), "utf8")).toBe("MOVIE");
    expect(await readFile(movie, "utf8")).toBe("MOVIE");
  });

  it("replaces an existing file in one step with the overwrite strategy", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    await touch(media, RENAMED, "EXISTING");
    const s = await session(mode, (settings) => {
      settings.conflictResolution = "overwrite";
    });
    const ops = await s.plan([movie]);
    await s.execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(path.join(media, RENAMED), "utf8")).toBe("MOVIE");
    expect(await readFile(movie, "utf8")).toBe("MOVIE");
    // No temporary file left behind.
    expect(await list(media)).toEqual([MATRIX_FILE, RENAMED].sort());
  });

  it("skips a destination that is already the same file (a second run)", async () => {
    const movie = await touch(media, MATRIX_FILE, "MOVIE");
    const s = await session(mode, (settings) => {
      settings.conflictResolution = "overwrite";
    });
    const first = await s.plan([movie]);
    await s.execute(first);
    if (mode === "copy") return; // A copy is a different file: replaced, which the test above covers.
    const second = await s.plan([movie]);
    await s.execute(second);
    expect(second[0]).toMatchObject({ status: "skipped", skipReason: "same_path" });
    expect(await list(media)).toEqual([MATRIX_FILE, RENAMED].sort());
  });
});

describe("case-only changes", () => {
  it.each(["copy", "hardlink"] as const)("are skipped in %s mode on a case-insensitive volume", async (mode) => {
    const src = await touch(media, "movie.mkv", "M");
    const upper = path.join(media, "MOVIE.mkv");
    const caseInsensitive = existsSync(upper);
    const ops = [op(src, upper)];
    await new FileRenamer({ transferMode: mode }).execute(ops);
    if (caseInsensitive) {
      expect(ops[0]).toMatchObject({ status: "skipped", errorMessage: "Source and destination are the same" });
      expect(await list(media)).toEqual(["movie.mkv"]);
    } else {
      expect(ops[0]!.status).toBe("completed");
      expect(await list(media)).toEqual(["MOVIE.mkv", "movie.mkv"]);
    }
    expect(await readFile(src, "utf8")).toBe("M");
  });
});

describe("safe copy", () => {
  it("leaves nothing under the final name when the copy fails", async () => {
    const dest = path.join(media, "out.mkv");
    // The source is a folder: copying it fails after the temporary name was chosen.
    await expect(safeCopy(media, dest, false)).rejects.toThrow(/Failed to copy/);
    expect(existsSync(dest)).toBe(false);
    expect((await readdir(media)).filter((n) => n.includes("tidytitles-tmp"))).toEqual([]);
  });

  it("refuses an existing destination without overwrite and removes its temporary file", async () => {
    const src = await touch(media, "a.mkv", "A");
    const dest = await touch(media, "b.mkv", "B");
    await expect(safeCopy(src, dest, false)).rejects.toThrow(/already exists/);
    expect(await readFile(dest, "utf8")).toBe("B");
    expect(await list(media)).toEqual(["a.mkv", "b.mkv"]);
  });

  it("does not report a copy as made when the destination folder is not writable", async () => {
    // Covered for every platform by the output folder checks; here the
    // renamer itself must fail the operation and leave the original.
    const src = await touch(media, "a.mkv", "A");
    const ops = [op(src, path.join(media, "missing-parent", "\0bad", "b.mkv"))];
    await new FileRenamer({ transferMode: "copy" }).execute(ops);
    expect(ops[0]!.status).toBe("failed");
    expect(await readFile(src, "utf8")).toBe("A");
  });
});

describe("hard links", () => {
  it("refuses an existing destination without overwrite", async () => {
    const src = await touch(media, "a.mkv", "A");
    const dest = await touch(media, "b.mkv", "B");
    await expect(hardLink(src, dest, false)).rejects.toThrow(/already exists/);
    expect(await readFile(dest, "utf8")).toBe("B");
  });
});

describe("undoTransferredFile", () => {
  const moveBack = (renamer = new FileRenamer()) => (from: string, to: string) => renamer.rename(from, to);

  it("does not remove a copy that was edited since it was made", async () => {
    const src = await touch(media, "a.mkv", "A");
    const dest = path.join(media, "b.mkv");
    await safeCopy(src, dest, false);
    const fingerprint = fingerprintOf(dest)!;
    await appendFile(dest, "EDIT");
    const outcome = await undoTransferredFile(
      { source: src, destination: dest, transfer: "copy", fingerprint },
      { moveBack: moveBack() },
    );
    expect(outcome).toEqual({ kind: "kept", reason: "changed" });
    expect(await readFile(dest, "utf8")).toBe("AEDIT");
  });

  it("does not remove a copy whose modification time changed (same size)", async () => {
    const src = await touch(media, "a.mkv", "A");
    const dest = path.join(media, "b.mkv");
    await safeCopy(src, dest, false);
    const fingerprint = fingerprintOf(dest)!;
    await writeFile(dest, "Z");
    await utimes(dest, new Date(2001, 0, 1), new Date(2001, 0, 1));
    const outcome = await undoTransferredFile(
      { source: src, destination: dest, transfer: "copy", fingerprint },
      { moveBack: moveBack() },
    );
    expect(outcome.kind).toBe("kept");
    expect(existsSync(dest)).toBe(true);
  });

  it("never removes a copy or link without a fingerprint", async () => {
    const src = await touch(media, "a.mkv", "A");
    const dest = await touch(media, "b.mkv", "A");
    const outcome = await undoTransferredFile(
      { source: src, destination: dest, transfer: "copy" },
      { moveBack: moveBack() },
    );
    expect(outcome).toEqual({ kind: "kept", reason: "changed" });
    expect(existsSync(dest)).toBe(true);
  });

  it("does not move back a file that is not the one that was moved", async () => {
    const original = await touch(media, "a.mkv", "A");
    const renamed = path.join(media, "b.mkv");
    await new FileRenamer().rename(original, renamed);
    const fingerprint = fingerprintOf(renamed)!;
    // Replace it while it still exists, so the new file cannot get its inode
    // number (Linux hands a freed number straight to the next new file).
    const other = path.join(media, "other.tmp");
    await writeFile(other, "OTHER");
    await fsRename(other, renamed);
    const outcome = await undoTransferredFile({ source: original, destination: renamed, fingerprint }, { moveBack: moveBack() });
    expect(outcome).toEqual({ kind: "kept", reason: "changed" });
    expect(await readFile(renamed, "utf8")).toBe("OTHER");
    expect(existsSync(original)).toBe(false);
  });

  it("moves back a file that was edited in place (tags written), since it is still the same file", async () => {
    const original = await touch(media, "a.mp3", "A");
    const renamed = path.join(media, "b.mp3");
    await new FileRenamer().rename(original, renamed);
    const fingerprint = fingerprintOf(renamed)!;
    await appendFile(renamed, "TAGS");
    const outcome = await undoTransferredFile({ source: original, destination: renamed, fingerprint }, { moveBack: moveBack() });
    expect(outcome).toEqual({ kind: "restored" });
    expect(await readFile(original, "utf8")).toBe("ATAGS");
  });

  it("reports a missing file without touching anything", async () => {
    const outcome = await undoTransferredFile(
      { source: path.join(media, "a"), destination: path.join(media, "b") },
      { moveBack: moveBack() },
    );
    expect(outcome).toEqual({ kind: "missing" });
  });
});
