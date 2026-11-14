import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError, ProviderError, RateLimitError } from "../src/errors";
import type { Episode, Movie, Track } from "../src/models";
import { FileRenamer } from "../src/renamer";
import {
  NullMovieProvider,
  NullMusicProvider,
  NullTVProvider,
  RenameService,
  cleanTitleForSearch,
  describeLookupError,
  isNullProvider,
  verifyTrackMatch,
  type RenameServiceOptions,
  type SelectableOption,
} from "../src/renameService";
import { TemplateEngine } from "../src/template";
import {
  FakeMovieProvider,
  FakeMusicParser,
  FakeMusicProvider,
  FakeTVProvider,
  bohemian,
  bohemianLive,
  breakingBad,
  breakingBadRemake,
  completeTags,
  matrix,
  matrixReloaded,
  pilot,
  touch,
} from "./fakes";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-service-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MATRIX_FILE = "The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv";
const BB_FILE = "Breaking.Bad.S01E01.720p.HDTV.x264.mkv";

function service(options: RenameServiceOptions = {}): RenameService {
  return new RenameService({ musicParser: new FakeMusicParser(), ...options });
}

describe("movie flow", () => {
  it("auto-matches a single result and renders the movie template", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const movies = new FakeMovieProvider({ "The Matrix": [matrix] });
    const ops = await service({ movieProvider: movies }).processFiles([file]);

    expect(movies.calls).toEqual([["The Matrix", 1999]]);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.status).toBe("pending");
    expect(op.destination).toBe(path.join(dir, "The Matrix (1999).mkv"));
    expect(op.mediaFile.matchedMetadata).toMatchObject({
      kind: "movie",
      id: 603,
      verificationStatus: "auto_matched",
    });
    // The provider's object is not mutated.
    expect(matrix.verificationStatus).toBeUndefined();
  });

  it("passes quality, source, codec, and group to the template", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      templateEngine: new TemplateEngine({ movieTemplate: "{title} [{quality} {source} {group}]" }),
    }).processFiles([file]);
    expect(path.basename(ops[0]!.destination)).toBe("The Matrix [1080p Blu-ray SPARKS].mkv");
  });

  it("uses the first result when there is no selection callback", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix, matrixReloaded] }),
    }).processFiles([file]);
    expect(ops[0]!.mediaFile.matchedMetadata).toMatchObject({
      id: 603,
      verificationStatus: "auto_matched",
    });
  });

  it("puts files in the destination directory when one is given", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const out = path.join(dir, "out");
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
    }).processFiles([file], { destinationDir: out });
    expect(ops[0]!.destination).toBe(path.join(out, "The Matrix (1999).mkv"));
  });

  it("treats every non-music file as the forced type", async () => {
    const file = await touch(dir, BB_FILE);
    const movies = new FakeMovieProvider({ "Breaking Bad": [matrix] });
    const tv = new FakeTVProvider();
    await service({ movieProvider: movies, tvProvider: tv }).processFiles([file], {
      forceType: "movie",
    });
    expect(movies.calls).toEqual([["Breaking Bad", undefined]]);
    expect(tv.searchCalls).toEqual([]);
  });
});

describe("TV flow", () => {
  it("looks up the show and episode and renders the TV template", async () => {
    const file = await touch(dir, BB_FILE);
    const tv = new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { 1396: pilot() });
    const ops = await service({ tvProvider: tv }).processFiles([file]);

    expect(tv.episodeCalls).toEqual([[1396, 1, 1]]);
    expect(ops[0]!.destination).toBe(path.join(dir, "Breaking Bad - S01E01 - Pilot.mkv"));
    expect(ops[0]!.mediaFile.matchedMetadata).toMatchObject({
      kind: "episode",
      verificationStatus: "auto_matched",
    });
  });

  it("does not search when season or episode is missing", async () => {
    const file = await touch(dir, "Breaking.Bad.mkv");
    const tv = new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { 1396: pilot() });
    const ops = await service({ tvProvider: tv }).processFiles([file], { forceType: "tv_episode" });
    expect(tv.searchCalls).toEqual([]);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "no_match" });
  });

  it("leaves the file unmatched when the episode is not found", async () => {
    const file = await touch(dir, BB_FILE);
    const tv = new FakeTVProvider({ "Breaking Bad": [breakingBad] }, {});
    const ops = await service({ tvProvider: tv }).processFiles([file]);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "no_match" });
  });
});

describe("music flow", () => {
  const SONG = "01 - Bohemian Rhapsody.mp3";

  async function runMusic(
    tags: Record<string, unknown>,
    musicProvider: FakeMusicProvider | undefined,
    extra: RenameServiceOptions = {},
  ) {
    const file = await touch(dir, SONG);
    const svc = service({
      musicParser: new FakeMusicParser({ [SONG]: tags }),
      ...(musicProvider ? { musicProvider } : {}),
      ...extra,
    });
    const ops = await svc.processFiles([file]);
    return { op: ops[0]!, track: ops[0]!.mediaFile.matchedMetadata as Track | undefined };
  }

  it("routes music files to the music flow even though the parser says TV", async () => {
    const file = await touch(dir, SONG);
    const svc = service({ musicParser: new FakeMusicParser({ [SONG]: completeTags }) });
    const [mf] = await svc.parseFiles([file]);
    expect(mf!.parsedInfo.mediaType).toBe("music");
    expect(mf!.parsedMusicInfo).toMatchObject({ title: "Bohemian Rhapsody" });
    expect(new RenameService().parser.parse(SONG).mediaType).toBe("tv_episode");
  });

  it("keeps music files in the music flow when another type is forced", async () => {
    const file = await touch(dir, SONG);
    const movies = new FakeMovieProvider({ "Bohemian Rhapsody": [matrix] });
    const music = new FakeMusicProvider({ "Bohemian Rhapsody": [bohemian] });
    const ops = await service({
      movieProvider: movies,
      musicProvider: music,
      musicParser: new FakeMusicParser({ [SONG]: completeTags }),
    }).processFiles([file], { forceType: "movie" });
    expect(movies.calls).toEqual([]);
    expect(ops[0]!.mediaFile.matchedMetadata?.kind).toBe("track");
  });

  it("complete tags that MusicBrainz confirms are verified", async () => {
    const music = new FakeMusicProvider({ "Bohemian Rhapsody": [bohemian] });
    const { op, track } = await runMusic(completeTags, music);
    expect(music.calls).toEqual([["Bohemian Rhapsody", "Queen", "A Night at the Opera"]]);
    expect(track).toMatchObject({ id: "local", verificationStatus: "verified" });
    expect(op.destination).toBe(
      path.join(dir, "Queen", "A Night at the Opera (1975)", "11 - Bohemian Rhapsody.mp3"),
    );
  });

  it("complete tags without a matching result are unverified", async () => {
    const other = { ...bohemian, title: "Somebody to Love" };
    const { track } = await runMusic(completeTags, new FakeMusicProvider({ "Bohemian Rhapsody": [other] }));
    expect(track).toMatchObject({ id: "local", verificationStatus: "unverified" });
  });

  it("complete tags are unverified when the search fails", async () => {
    const { op, track } = await runMusic(
      completeTags,
      new FakeMusicProvider({ "Bohemian Rhapsody": new ProviderError("down") }),
    );
    expect(track).toMatchObject({ verificationStatus: "unverified" });
    expect(op.lookupError).toBeUndefined();
  });

  it("complete tags are unverified without a music provider", async () => {
    const { track } = await runMusic(completeTags, undefined);
    expect(track).toMatchObject({ title: "Bohemian Rhapsody", verificationStatus: "unverified" });
  });

  it("strips featured artists for the search and the comparison", async () => {
    const music = new FakeMusicProvider({ "Under Pressure": [{ ...bohemian, title: "Under Pressure" }] });
    const { track } = await runMusic(
      { ...completeTags, title: "Under Pressure (feat. David Bowie)" },
      music,
    );
    expect(music.calls[0]![0]).toBe("Under Pressure");
    expect(track).toMatchObject({ verificationStatus: "verified" });
  });

  it("incomplete tags with one result use it, from_provider", async () => {
    const music = new FakeMusicProvider({ "Bohemian Rhapsody": [bohemian] });
    const { track } = await runMusic({ title: "Bohemian Rhapsody", artist: "Queen" }, music);
    expect(track).toMatchObject({ id: "rec-1", verificationStatus: "from_provider" });
    expect(bohemian.verificationStatus).toBeUndefined();
  });

  it("incomplete tags with no results fall back to the tags, unverified", async () => {
    const { track } = await runMusic({ title: "Rare Demo", artist: "Queen" }, new FakeMusicProvider());
    expect(track).toMatchObject({ id: "local", title: "Rare Demo", verificationStatus: "unverified" });
  });

  it("incomplete tags fall back to the tags when the search fails", async () => {
    const { track } = await runMusic(
      { title: "Bohemian Rhapsody" },
      new FakeMusicProvider({ "Bohemian Rhapsody": new Error("offline") }),
    );
    expect(track).toMatchObject({ id: "local", verificationStatus: "unverified" });
  });

  it("incomplete tags without a music provider stay unmatched", async () => {
    const { op } = await runMusic({ title: "Bohemian Rhapsody" }, undefined);
    expect(op).toMatchObject({ status: "skipped", skipReason: "no_match" });
  });

  it("incomplete tags with several results ask the selection callback", async () => {
    const selectionCallback = vi.fn(() => 1);
    const music = new FakeMusicProvider({ "Bohemian Rhapsody": [bohemian, bohemianLive] });
    const { track } = await runMusic({ title: "Bohemian Rhapsody" }, music, { selectionCallback });
    expect(selectionCallback).toHaveBeenCalledWith([bohemian, bohemianLive], SONG);
    expect(track).toMatchObject({ id: "rec-2", verificationStatus: "from_provider" });
  });

  it("fills in track and disc numbers from the tags", async () => {
    const music = new FakeMusicProvider({ "Bohemian Rhapsody": [bohemianLive] });
    const { op, track } = await runMusic(
      { title: "Bohemian Rhapsody", trackNumber: 7, discNumber: 2 },
      music,
      { templateEngine: new TemplateEngine({ musicTemplate: "{disc2}-{track2} {title}" }) },
    );
    expect(track).toMatchObject({ trackNumber: 7, discNumber: 2 });
    expect(path.basename(op.destination)).toBe("02-07 Bohemian Rhapsody (Live).mp3");
  });
});

describe("selection", () => {
  async function ambiguousMovie(selectionCallback: RenameServiceOptions["selectionCallback"]) {
    const file = await touch(dir, MATRIX_FILE);
    return service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix, matrixReloaded] }),
      selectionCallback,
    }).processFiles([file]);
  }

  it("uses a synchronous callback's choice, as manual_selection", async () => {
    const cb = vi.fn((_options: SelectableOption[], _filename: string) => 1);
    const ops = await ambiguousMovie(cb);
    expect(cb).toHaveBeenCalledWith([matrix, matrixReloaded], MATRIX_FILE);
    expect(ops[0]!.mediaFile.matchedMetadata).toMatchObject({
      id: 604,
      verificationStatus: "manual_selection",
    });
    expect(path.basename(ops[0]!.destination)).toBe("The Matrix Reloaded (2003).mkv");
  });

  it("awaits an async callback", async () => {
    const ops = await ambiguousMovie(
      () => new Promise<number>((resolve) => setTimeout(() => resolve(0), 5)),
    );
    expect(ops[0]!.mediaFile.matchedMetadata).toMatchObject({
      id: 603,
      verificationStatus: "manual_selection",
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["out of range", 5],
    ["negative", -1],
    ["fractional", 0.5],
  ])("skips the file when the callback returns %s", async (_label, value) => {
    const ops = await ambiguousMovie(async () => value);
    expect(ops[0]).toMatchObject({
      status: "skipped",
      skipReason: "no_match",
      errorMessage: "No metadata match found",
    });
    expect(ops[0]!.destination).toBe(ops[0]!.source);
  });

  it("is not called for a single result", async () => {
    const cb = vi.fn(() => 0);
    const file = await touch(dir, MATRIX_FILE);
    await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      selectionCallback: cb,
    }).processFiles([file]);
    expect(cb).not.toHaveBeenCalled();
  });

  it("selects among TV shows, then fetches the chosen show's episode", async () => {
    const file = await touch(dir, BB_FILE);
    const tv = new FakeTVProvider(
      { "Breaking Bad": [breakingBad, breakingBadRemake] },
      { 1396: pilot(), 9999: pilot(breakingBadRemake) },
    );
    const ops = await service({ tvProvider: tv, selectionCallback: async () => 1 }).processFiles([
      file,
    ]);
    expect(tv.episodeCalls).toEqual([[9999, 1, 1]]);
    expect(ops[0]!.mediaFile.matchedMetadata).toMatchObject({
      verificationStatus: "manual_selection",
    });
    expect((ops[0]!.mediaFile.matchedMetadata as Episode).show.id).toBe(9999);
  });

  it("a skipped TV selection fetches no episode", async () => {
    const file = await touch(dir, BB_FILE);
    const tv = new FakeTVProvider({ "Breaking Bad": [breakingBad, breakingBadRemake] }, { 1396: pilot() });
    const ops = await service({ tvProvider: tv, selectionCallback: () => undefined }).processFiles([file]);
    expect(tv.episodeCalls).toEqual([]);
    expect(ops[0]!.skipReason).toBe("no_match");
  });

  it("an error from the callback aborts the batch", async () => {
    const cancel = new Error("canceled by user");
    await expect(
      ambiguousMovie(() => {
        throw cancel;
      }),
    ).rejects.toBe(cancel);
    await expect(ambiguousMovie(() => Promise.reject(cancel))).rejects.toBe(cancel);
  });

  it("can be replaced between runs", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const svc = service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix, matrixReloaded] }),
    });
    svc.selectionCallback = () => 1;
    const ops = await svc.processFiles([file]);
    expect((ops[0]!.mediaFile.matchedMetadata as Movie).id).toBe(604);
  });
});

describe("unmatched files and errors", () => {
  it("keeps unmatched files as skipped operations", async () => {
    const file = await touch(dir, "random notes.mkv");
    const ops = await service().processFiles([file]);
    expect(ops).toEqual([
      expect.objectContaining({
        source: file,
        destination: file,
        status: "skipped",
        skipReason: "no_match",
        errorMessage: "No metadata match found",
        associatedFiles: [],
      }),
    ]);
  });

  it("a provider error on one file does not abort the batch", async () => {
    const bad = await touch(dir, "Inception.2010.mkv");
    const good = await touch(dir, MATRIX_FILE);
    const movies = new FakeMovieProvider({
      Inception: new ProviderError("TMDB API error: 500"),
      "The Matrix": [matrix],
    });
    const ops = await service({ movieProvider: movies }).processFiles([bad, good]);

    expect(ops[0]).toMatchObject({
      status: "skipped",
      skipReason: "lookup_failed",
      errorMessage: "TMDB API error: 500",
      lookupError: { kind: "provider", name: "ProviderError", message: "TMDB API error: 500" },
    });
    expect(ops[0]!.mediaFile.lookupError?.kind).toBe("provider");
    expect(ops[1]).toMatchObject({ status: "pending" });
    expect(path.basename(ops[1]!.destination)).toBe("The Matrix (1999).mkv");
  });

  it("classifies lookup errors", () => {
    expect(describeLookupError(new AuthenticationError("bad key")).kind).toBe("authentication");
    expect(describeLookupError(new RateLimitError("slow down")).kind).toBe("rate_limit");
    expect(describeLookupError(new ProviderError("oops")).kind).toBe("provider");
    expect(describeLookupError(new TypeError("fetch failed"))).toEqual({
      kind: "other",
      name: "TypeError",
      message: "fetch failed",
    });
    expect(describeLookupError("string")).toEqual({ kind: "other", name: "Error", message: "string" });
  });

  it("clears an old lookup error when fetched again", async () => {
    const file = await touch(dir, MATRIX_FILE);
    let fail = true;
    const movies = new FakeMovieProvider({
      "The Matrix": () => {
        if (fail) throw new ProviderError("down");
        return [matrix];
      },
    });
    const svc = service({ movieProvider: movies });
    const files = await svc.parseFiles([file]);
    await svc.fetchMetadata(files);
    expect(files[0]!.lookupError).toBeDefined();
    fail = false;
    await svc.fetchMetadata(files);
    expect(files[0]!.lookupError).toBeUndefined();
    expect(files[0]!.matchedMetadata?.kind).toBe("movie");
  });

  it("a template error skips only that file", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      templateEngine: new TemplateEngine({ movieTemplate: "{title} {year|pad:x}" }),
    }).processFiles([file]);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "template_error" });
  });

  it("unknown metadata kinds are skipped", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const svc = service();
    const [mf] = await svc.parseFiles([file]);
    mf!.matchedMetadata = { kind: "mystery" } as unknown as Movie;
    const ops = await svc.generatePreview([mf!]);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "unknown_metadata" });
  });

  it("the default providers find nothing", async () => {
    const svc = new RenameService();
    expect(isNullProvider(svc.movieProvider)).toBe(true);
    expect(isNullProvider(svc.tvProvider)).toBe(true);
    expect(svc.musicProvider).toBeUndefined();
    expect(await new NullMovieProvider().searchMovie()).toEqual([]);
    expect(await new NullTVProvider().searchShow()).toEqual([]);
    expect(await new NullTVProvider().getEpisode()).toBeUndefined();
    expect(await new NullMusicProvider().searchRecording()).toEqual([]);
    expect(isNullProvider(new FakeMovieProvider())).toBe(false);
  });

  it("stops before the next file when the signal is aborted", async () => {
    const a = await touch(dir, MATRIX_FILE);
    const b = await touch(dir, "Inception.2010.mkv");
    const controller = new AbortController();
    const movies = new FakeMovieProvider({
      "The Matrix": () => {
        controller.abort(new Error("stop"));
        return [matrix];
      },
    });
    await expect(
      service({ movieProvider: movies }).processFiles([a, b], { signal: controller.signal }),
    ).rejects.toThrow("stop");
    expect(movies.calls).toHaveLength(1);
  });
});

describe("progress", () => {
  it("reports parse and fetch progress with phases", async () => {
    const a = await touch(dir, MATRIX_FILE);
    const b = await touch(dir, BB_FILE);
    const events: unknown[] = [];
    await service().processFiles([a, b], {
      progressCallback: (current, total, message, phase) =>
        events.push([phase, current, total, message]),
    });
    expect(events).toEqual([
      ["parse", 1, 2, `Parsing: ${MATRIX_FILE}`],
      ["parse", 2, 2, `Parsing: ${BB_FILE}`],
      ["fetch", 1, 2, "Fetching: The Matrix"],
      ["fetch", 2, 2, "Fetching: Breaking Bad"],
    ]);
  });

  it("reports rename progress", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const svc = service({ movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) });
    const ops = await svc.processFiles([file]);
    const progress = vi.fn();
    await svc.executeRename(ops, progress);
    expect(progress).toHaveBeenCalledWith(1, 1, `Renaming: ${MATRIX_FILE}`);
  });
});

describe("associated files", () => {
  async function plan(settings?: RenameServiceOptions["associatedFilesSettings"]) {
    const file = await touch(dir, MATRIX_FILE);
    const stem = MATRIX_FILE.replace(/\.mkv$/, "");
    await touch(dir, `${stem}.en.srt`);
    await touch(dir, `${stem}.nfo`);
    await touch(dir, `${stem}.jpg`);
    await touch(dir, "unrelated.srt");
    const svc = service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      ...(settings ? { associatedFilesSettings: settings } : {}),
    });
    return { svc, ops: await svc.processFiles([file]) };
  }

  it("includes subtitles, NFO, and images and renames them with the main file", async () => {
    const { svc, ops } = await plan();
    const names = ops[0]!.associatedFiles
      .map((a) => [path.basename(a.destination), a.fileType])
      .sort();
    expect(names).toEqual([
      ["The Matrix (1999).en.srt", "subtitle"],
      ["The Matrix (1999).jpg", "image"],
      ["The Matrix (1999).nfo", "nfo"],
    ]);

    await svc.executeRename(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(existsSync(path.join(dir, "The Matrix (1999).mkv"))).toBe(true);
    expect(existsSync(path.join(dir, "The Matrix (1999).en.srt"))).toBe(true);
    expect(existsSync(path.join(dir, "unrelated.srt"))).toBe(true);
  });

  it("respects the associated-file settings", async () => {
    const { ops } = await plan({ enabled: true, subtitles: true, nfo: false, images: false });
    expect(ops[0]!.associatedFiles.map((a) => a.fileType)).toEqual(["subtitle"]);
  });

  it("can be disabled", async () => {
    const { ops } = await plan({ enabled: false, subtitles: true, nfo: true, images: true });
    expect(ops[0]!.associatedFiles).toEqual([]);
  });

  it("follows the main file into the destination directory", async () => {
    const file = await touch(dir, MATRIX_FILE);
    await touch(dir, MATRIX_FILE.replace(/\.mkv$/, ".srt"));
    const out = path.join(dir, "out");
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
    }).processFiles([file], { destinationDir: out });
    expect(ops[0]!.associatedFiles[0]!.destination).toBe(path.join(out, "The Matrix (1999).srt"));
  });
});

describe("conflict strategies", () => {
  async function planWithExisting(
    conflictStrategy: RenameServiceOptions["conflictStrategy"],
    fileRenamer?: FileRenamer,
  ) {
    const file = await touch(dir, MATRIX_FILE, "new");
    await touch(dir, "The Matrix (1999).mkv", "old");
    const svc = service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      conflictStrategy,
      ...(fileRenamer ? { fileRenamer } : {}),
    });
    return { svc, file, ops: await svc.processFiles([file]) };
  }

  it("skip: keeps the destination and the renamer skips it", async () => {
    const { svc, file, ops } = await planWithExisting("skip");
    expect(path.basename(ops[0]!.destination)).toBe("The Matrix (1999).mkv");
    await svc.executeRename(ops);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "would_overwrite" });
    expect(existsSync(file)).toBe(true);
  });

  it("overwrite: replaces the existing file when the renamer may overwrite", async () => {
    const { svc, ops } = await planWithExisting("overwrite", new FileRenamer({ overwrite: true }));
    await svc.executeRename(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(path.join(dir, "The Matrix (1999).mkv"), "utf8")).toBe("new");
  });

  it("auto_version: picks the next free name", async () => {
    const { svc, ops } = await planWithExisting("auto_version");
    expect(path.basename(ops[0]!.destination)).toBe("The Matrix (1999) (1).mkv");
    await svc.executeRename(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(path.join(dir, "The Matrix (1999).mkv"), "utf8")).toBe("old");
  });

  it("auto_version: versions associated files to match", async () => {
    const file = await touch(dir, MATRIX_FILE);
    await touch(dir, MATRIX_FILE.replace(/\.mkv$/, ".srt"));
    await touch(dir, "The Matrix (1999).mkv");
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      conflictStrategy: "auto_version",
    }).processFiles([file]);
    expect(path.basename(ops[0]!.associatedFiles[0]!.destination)).toBe("The Matrix (1999) (1).srt");
  });

  it("auto_version: versions duplicates within one batch", async () => {
    const a = await touch(dir, MATRIX_FILE);
    const b = await touch(dir, "The.Matrix.1999.720p.mkv");
    const ops = await service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      conflictStrategy: "auto_version",
    }).processFiles([a, b]);
    expect(ops.map((o) => path.basename(o.destination))).toEqual([
      "The Matrix (1999).mkv",
      "The Matrix (1999) (1).mkv",
    ]);
  });

  it.each(["skip", "overwrite"] as const)(
    "%s: a duplicate destination within one batch is skipped",
    async (conflictStrategy) => {
      const a = await touch(dir, MATRIX_FILE);
      const b = await touch(dir, "The.Matrix.1999.720p.mkv");
      const svc = service({
        movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
        conflictStrategy,
        fileRenamer: new FileRenamer({ overwrite: conflictStrategy === "overwrite" }),
      });
      const ops = await svc.processFiles([a, b]);
      expect(ops[0]!.status).toBe("pending");
      expect(ops[1]).toMatchObject({
        status: "skipped",
        skipReason: "duplicate_destination",
        destination: b,
      });
      await svc.executeRename(ops);
      expect(existsSync(b)).toBe(true);
    },
  );

  it("auto_version: a file that already has its name is not versioned", async () => {
    const file = await touch(dir, "The Matrix (1999).mkv");
    const svc = service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      conflictStrategy: "auto_version",
    });
    const ops = await svc.processFiles([file]);
    expect(ops[0]!.destination).toBe(file);
    await svc.executeRename(ops);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "same_path" });
  });
});

describe("execute, dry run, and undo", () => {
  it("dry run validates without renaming", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const svc = service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      fileRenamer: new FileRenamer({ dryRun: true }),
    });
    const ops = await svc.processFiles([file]);
    await svc.executeRename(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(ops[0]!.destination)).toBe(false);
  });

  it("execute then undo restores the original names", async () => {
    const file = await touch(dir, MATRIX_FILE);
    const srt = await touch(dir, MATRIX_FILE.replace(/\.mkv$/, ".srt"));
    const svc = service({ movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) });
    const ops = await svc.processFiles([file]);
    await svc.executeRename(ops);
    expect(existsSync(file)).toBe(false);
    await svc.undoRename(ops);
    expect(ops[0]!.status).toBe("pending");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(srt)).toBe(true);
  });

  it("creates directories for music templates", async () => {
    const song = "Bohemian Rhapsody.flac";
    const file = await touch(dir, song);
    const svc = service({
      musicParser: new FakeMusicParser({ [song]: completeTags }),
    });
    const ops = await svc.processFiles([file]);
    await svc.executeRename(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(
      existsSync(path.join(dir, "Queen", "A Night at the Opera (1975)", "11 - Bohemian Rhapsody.flac")),
    ).toBe(true);
  });
});

describe("music matching helpers", () => {
  it("cleans featured-artist suffixes", () => {
    expect(cleanTitleForSearch("Song (feat. X)")).toBe("Song");
    expect(cleanTitleForSearch("Song (Ft. X) ")).toBe("Song");
    expect(cleanTitleForSearch("Song (with Y)")).toBe("Song");
    expect(cleanTitleForSearch("Song (featuring Z)")).toBe("Song");
    expect(cleanTitleForSearch("Song (Remix)")).toBe("Song (Remix)");
  });

  it("matches ignoring case, punctuation, a leading The, and containment", () => {
    const tags = { title: "Don't Stop Me Now", artist: "Queen", rawFilename: "", source: "tags" };
    expect(verifyTrackMatch(tags, [{ ...bohemian, title: "DONT STOP ME NOW!" }])).toBe(true);
    expect(verifyTrackMatch(tags, [{ ...bohemian, title: "Don't Stop Me Now (Remastered)" }])).toBe(true);
    expect(verifyTrackMatch({ ...tags, title: "Don't Stop Me Now (2011 Remaster)" }, [
      { ...bohemian, title: "Don't Stop Me Now" },
    ])).toBe(true);
    expect(verifyTrackMatch({ ...tags, artist: "The Queen" }, [{ ...bohemian, title: "Don't Stop Me Now" }])).toBe(true);
    expect(verifyTrackMatch({ ...tags, artist: "Queen + Bowie" }, [{ ...bohemian, title: "Don't Stop Me Now" }])).toBe(false);
    expect(verifyTrackMatch(tags, [{ ...bohemian, title: "Somebody to Love" }])).toBe(false);
    expect(verifyTrackMatch(tags, [])).toBe(false);
  });

  it("keeps non-ASCII letters when normalizing", () => {
    const tags = { title: "Déjà Vu", artist: "Beyoncé", rawFilename: "", source: "tags" };
    const track = { ...bohemian, title: "Deja Vu", artist: { ...bohemian.artist, name: "Beyoncé" } };
    expect(verifyTrackMatch(tags, [track])).toBe(false);
    expect(verifyTrackMatch(tags, [{ ...track, title: "Déjà vu" }])).toBe(true);
  });
});
