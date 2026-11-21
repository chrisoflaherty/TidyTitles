import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFileName } from "../src/customName";
import { ProviderError } from "../src/errors";
import {
  PlanCorrector,
  defaultMatchQuery,
  searchMatches,
  type MatchQuery,
} from "../src/matchCorrection";
import { createEpisode, createMovie, createTVShow, type Episode, type TVShow } from "../src/models";
import type { TVProvider } from "../src/providers/base";
import { FileRenamer } from "../src/renamer";
import { RenameService, type RenameServiceOptions, type SelectionContext } from "../src/renameService";
import { TemplateEngine } from "../src/template";
import {
  FakeMovieProvider,
  FakeMusicParser,
  FakeMusicProvider,
  bohemian,
  bohemianLive,
  breakingBad,
  completeTags,
  matrix,
  matrixReloaded,
  touch,
} from "./fakes";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-correct-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const wrongShow: TVShow = createTVShow({ id: 1, title: "Breaking Badly", originalTitle: "Breaking Badly", year: 2019 });

/** TV provider with episodes per show id and "season:episode". */
class EpisodeTVProvider implements TVProvider {
  episodeCalls: Array<[number, number, number]> = [];
  constructor(
    private shows: Record<string, TVShow[]>,
    private episodes: Record<number, Record<string, Episode | Error>>,
  ) {}
  async searchShow(title: string): Promise<TVShow[]> {
    return this.shows[title] ?? [];
  }
  async getShow(): Promise<undefined> {
    return undefined;
  }
  async getEpisode(showId: number, season: number, episode: number): Promise<Episode | undefined> {
    this.episodeCalls.push([showId, season, episode]);
    const found = this.episodes[showId]?.[`${season}:${episode}`];
    if (found instanceof Error) throw found;
    return found;
  }
}

function episodesOf(show: TVShow, count: number, season = 1): Record<string, Episode> {
  const out: Record<string, Episode> = {};
  for (let e = 1; e <= count; e++) {
    out[`${season}:${e}`] = createEpisode({ show, season, episode: e, title: `Episode ${e}` });
  }
  return out;
}

function service(options: RenameServiceOptions = {}): RenameService {
  return new RenameService({ musicParser: new FakeMusicParser(), ...options });
}

async function planned(svc: RenameService, files: string[]) {
  const ops = await svc.processFiles(files);
  return { ops, corrector: new PlanCorrector(svc, ops) };
}

const names = (ops: { destination: string }[]) => ops.map((op) => path.basename(op.destination));

describe("checkFileName", () => {
  it("accepts a plain name, trimming it and dropping a typed extension", () => {
    expect(checkFileName("  The Matrix (1999)  ", ".mkv")).toEqual({ ok: true, name: "The Matrix (1999)" });
    expect(checkFileName("The Matrix.MKV", ".mkv")).toEqual({ ok: true, name: "The Matrix" });
    expect(checkFileName("Mr. Robot", ".mkv")).toEqual({ ok: true, name: "Mr. Robot" });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a/b", "invalid_characters"],
    ["a\\b", "invalid_characters"],
    ["What?", "invalid_characters"],
    ['Say "hi"', "invalid_characters"],
    ["a:b", "invalid_characters"],
    ["tab\there", "invalid_characters"],
    [".", "dots_only"],
    ["..", "dots_only"],
    ["CON", "reserved"],
    ["nul", "reserved"],
    ["COM1", "reserved"],
  ])("refuses %j (%s)", (typed, problem) => {
    expect(checkFileName(typed, ".mkv")).toMatchObject({ ok: false, problem });
  });

  it("refuses a trailing dot only when the name has no extension", () => {
    expect(checkFileName("Name.", "")).toMatchObject({ ok: false, problem: "trailing" });
    expect(checkFileName("Name Jr.", ".mkv")).toEqual({ ok: true, name: "Name Jr." });
  });

  it("refuses names over 255 bytes with the extension", () => {
    expect(checkFileName("a".repeat(251), ".mkv")).toEqual({ ok: true, name: "a".repeat(251) });
    expect(checkFileName("a".repeat(252), ".mkv")).toMatchObject({ ok: false, problem: "too_long" });
    expect(checkFileName("é".repeat(126), ".mkv")).toMatchObject({ ok: false, problem: "too_long" });
  });

  it("accepts only names the template's own cleaning leaves unchanged", () => {
    const engine = new TemplateEngine();
    for (const name of ["Amélie (2001)", "AC-DC - T.N.T", "Señor [1080p]", "名前"]) {
      expect(checkFileName(name, "")).toEqual({ ok: true, name });
      expect(engine.cleanPath(name)).toBe(name);
    }
  });
});

describe("queries and search", () => {
  it("starts from what the lookup searched for", async () => {
    const svc = service({ musicParser: new FakeMusicParser({ "song.mp3": completeTags }) });
    const [movie, tv, music] = await svc.parseFiles([
      path.join(dir, "The.Matrix.1999.mkv"),
      path.join(dir, "Breaking.Bad.S02E05.mkv"),
      path.join(dir, "song.mp3"),
    ]);
    expect(defaultMatchQuery(movie!)).toEqual({ mediaType: "movie", title: "The Matrix", year: 1999 });
    expect(defaultMatchQuery(tv!)).toEqual({ mediaType: "tv_episode", title: "Breaking Bad", season: 2, episode: 5 });
    expect(defaultMatchQuery(music!)).toEqual({
      mediaType: "music",
      title: "Bohemian Rhapsody",
      artist: "Queen",
      album: "A Night at the Opera",
    });
    // The session's forced type applies, as in the lookup.
    expect(defaultMatchQuery(movie!, "tv_episode").mediaType).toBe("tv_episode");
  });

  it("searches the provider for the kind of query, and says when there is none", async () => {
    const movies = new FakeMovieProvider({ "Matrix Reloaded": [matrixReloaded] });
    const music = new FakeMusicProvider({ Bohemian: [bohemian, bohemianLive] });
    const svc = service({ movieProvider: movies, musicProvider: music });

    const found = await searchMatches(svc, { mediaType: "movie", title: "  Matrix Reloaded ", year: 2003 });
    expect(found).toEqual({
      query: { mediaType: "movie", title: "Matrix Reloaded", year: 2003 },
      options: [matrixReloaded],
      providerAvailable: true,
    });
    expect(movies.calls).toEqual([["Matrix Reloaded", 2003]]);

    const tracks = await searchMatches(svc, { mediaType: "music", title: "Bohemian", artist: "Queen", album: " " });
    expect(tracks.options).toEqual([bohemian, bohemianLive]);
    expect(music.calls).toEqual([["Bohemian", "Queen", undefined]]);

    // No TV provider configured: nothing is searched.
    await expect(searchMatches(svc, { mediaType: "tv_episode", title: "Lost" })).resolves.toMatchObject({
      options: [],
      providerAvailable: false,
    });
    // An empty title sends no request.
    await searchMatches(svc, { mediaType: "movie", title: "  " });
    expect(movies.calls).toHaveLength(1);
  });
});

describe("choosing a match", () => {
  it("gives a file without a match any search result, marked as a manual selection", async () => {
    const file = await touch(dir, "Unknown.Film.2021.mkv");
    const svc = service({ movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) });
    const { ops, corrector } = await planned(svc, [file]);
    expect(ops[0]!.skipReason).toBe("no_match");

    const query: MatchQuery = { mediaType: "movie", title: "The Matrix" };
    const { options } = await corrector.search(query);
    const result = await corrector.chooseMatch(0, query, options[0]!);
    expect(result).toMatchObject({ kind: "applied", changed: [0], unmatched: [] });
    const op = corrector.operations[0]!;
    expect(op.status).toBe("pending");
    expect(path.basename(op.destination)).toBe("The Matrix (1999).mkv");
    expect(op.mediaFile.matchedMetadata).toMatchObject({ id: 603, verificationStatus: "manual_selection" });
    expect(op.mediaFile.correction).toMatchObject({ match: "chosen", query, sequence: 1 });
    // The next search starts from the user's query.
    expect(corrector.query(0)).toEqual(query);
  });

  it("clears a lookup error when the user picks a match", async () => {
    const file = await touch(dir, "The.Matrix.1999.mkv");
    const movies = new FakeMovieProvider({ "The Matrix": new ProviderError("TMDB API error: 503") });
    const svc = service({ movieProvider: movies });
    const { ops, corrector } = await planned(svc, [file]);
    expect(ops[0]!.skipReason).toBe("lookup_failed");

    await corrector.chooseMatch(0, { mediaType: "movie", title: "x" }, matrix);
    const op = corrector.operations[0]!;
    expect(op.status).toBe("pending");
    expect(op.lookupError).toBeUndefined();
    expect(op.mediaFile.lookupError).toBeUndefined();
  });

  it("marks the corrected file, not the untouched one, when both would get the same name", async () => {
    const a = await touch(dir, "Matrix.Copy.mkv");
    const b = await touch(dir, "The.Matrix.1999.mkv");
    const movies = new FakeMovieProvider({ "Matrix Copy": [matrixReloaded], "The Matrix": [matrix] });
    const { corrector } = await planned(service({ movieProvider: movies }), [a, b]);

    await corrector.chooseMatch(0, { mediaType: "movie", title: "The Matrix" }, matrix);
    const [first, second] = corrector.operations;
    expect(first!.skipReason).toBe("duplicate_destination");
    expect(second!.status).toBe("pending");
    expect(path.basename(second!.destination)).toBe("The Matrix (1999).mkv");
  });

  it("versions the corrected file with auto_version", async () => {
    const a = await touch(dir, "Matrix.Copy.mkv");
    const b = await touch(dir, "The.Matrix.1999.mkv");
    const movies = new FakeMovieProvider({ "Matrix Copy": [matrixReloaded], "The Matrix": [matrix] });
    const { corrector } = await planned(service({ movieProvider: movies, conflictStrategy: "auto_version" }), [a, b]);

    await corrector.chooseMatch(0, { mediaType: "movie", title: "The Matrix" }, matrix);
    expect(names(corrector.operations)).toEqual(["The Matrix (1999) (1).mkv", "The Matrix (1999).mkv"]);
  });

  it("frees a name for another file when a match changes", async () => {
    const a = await touch(dir, "The.Matrix.1999.mkv");
    const b = await touch(dir, "The.Matrix.1999.720p.mkv");
    const movies = new FakeMovieProvider({ "The Matrix": [matrix] });
    const { ops, corrector } = await planned(service({ movieProvider: movies }), [a, b]);
    expect(ops[1]!.skipReason).toBe("duplicate_destination");

    await corrector.chooseMatch(0, { mediaType: "movie", title: "Reloaded" }, matrixReloaded);
    const [first, second] = corrector.operations;
    expect(path.basename(first!.destination)).toBe("The Matrix Reloaded (2003).mkv");
    expect(second!.status).toBe("pending");
    expect(path.basename(second!.destination)).toBe("The Matrix (1999).mkv");
  });

  it("moves associated files with the new match", async () => {
    const file = await touch(dir, "Some.Film.2001.mkv");
    await touch(dir, "Some.Film.2001.en.srt");
    const { corrector } = await planned(service(), [file]);
    await corrector.chooseMatch(0, { mediaType: "movie", title: "Matrix" }, matrix);
    const op = corrector.operations[0]!;
    expect(op.associatedFiles.map((a) => path.basename(a.destination))).toEqual(["The Matrix (1999).en.srt"]);
  });

  it("can treat a movie file as a TV episode with corrected numbers", async () => {
    const file = await touch(dir, "Breaking.Bad.Pilot.mkv");
    const tv = new EpisodeTVProvider({ "Breaking Bad": [breakingBad] }, { [breakingBad.id]: episodesOf(breakingBad, 3) });
    const { corrector } = await planned(service({ tvProvider: tv }), [file]);
    expect(corrector.query(0).mediaType).toBe("movie");

    const query: MatchQuery = { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 2 };
    const { options } = await corrector.search(query);
    await corrector.chooseMatch(0, query, options[0]!);
    expect(names(corrector.operations)).toEqual(["Breaking Bad - S01E02 - Episode 2.mkv"]);
    expect(tv.episodeCalls).toEqual([[breakingBad.id, 1, 2]]);
  });

  it("reports a missing episode or missing numbers without changing anything", async () => {
    const file = await touch(dir, "Breaking.Bad.S01E09.mkv");
    const tv = new EpisodeTVProvider({}, { [breakingBad.id]: episodesOf(breakingBad, 3) });
    const { ops, corrector } = await planned(service({ tvProvider: tv }), [file]);
    const before = structuredClone(ops);

    await expect(
      corrector.chooseMatch(0, { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 9 }, breakingBad),
    ).resolves.toEqual({ kind: "episode_not_found", season: 1, episode: 9 });
    // Without numbers in the query, the file's own numbers are looked up.
    await expect(corrector.chooseMatch(0, { mediaType: "tv_episode", title: "Breaking Bad" }, breakingBad)).resolves.toEqual({
      kind: "episode_not_found",
      season: 1,
      episode: 9,
    });
    expect(corrector.operations).toEqual(before);
  });

  it("asks for numbers when neither the query nor the file name has any", async () => {
    const file = await touch(dir, "Breaking.Bad.mkv");
    const tv = new EpisodeTVProvider({}, { [breakingBad.id]: episodesOf(breakingBad, 3) });
    const { ops, corrector } = await planned(service({ tvProvider: tv }), [file]);
    const before = structuredClone(ops);

    await expect(corrector.chooseMatch(0, { mediaType: "tv_episode", title: "Breaking Bad" }, breakingBad)).resolves.toEqual({
      kind: "needs_episode",
    });
    expect(corrector.operations).toEqual(before);
  });

  it("changes nothing when the episode lookup throws", async () => {
    const file = await touch(dir, "Breaking.Bad.S01E01.mkv");
    const tv = new EpisodeTVProvider({}, { [breakingBad.id]: { "1:1": new ProviderError("TVDB API error: 503") } });
    const { ops, corrector } = await planned(service({ tvProvider: tv }), [file]);
    const before = structuredClone(ops);
    await expect(
      corrector.chooseMatch(0, { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 1 }, breakingBad),
    ).rejects.toThrow("503");
    expect(corrector.operations).toEqual(before);
  });

  it("gives the chosen show to the other episodes with the same parsed title", async () => {
    const files: string[] = [];
    for (let e = 1; e <= 4; e++) files.push(await touch(dir, `Breaking.Bad.S01E0${e}.720p.mkv`));
    files.push(await touch(dir, "Breaking.Bad.2030.S01E01.mkv")); // another year: not the same show
    files.push(await touch(dir, "Other.Show.S01E01.mkv"));
    const tv = new EpisodeTVProvider(
      { "Breaking Bad": [wrongShow] },
      // Episode 4 does not exist in the right show.
      { [wrongShow.id]: episodesOf(wrongShow, 4), [breakingBad.id]: episodesOf(breakingBad, 3) },
    );
    const { ops, corrector } = await planned(service({ tvProvider: tv }), files);
    expect(names(ops).slice(0, 4).every((n) => n.startsWith("Breaking Badly"))).toBe(true);
    expect(corrector.similarFiles(0)).toEqual([1, 2, 3]);

    const query: MatchQuery = { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 1 };
    const result = await corrector.chooseMatch(0, query, breakingBad, { applyToSimilar: true });
    expect(result).toMatchObject({ kind: "applied", changed: [0, 1, 2], unmatched: [3] });
    expect(names(corrector.operations).slice(0, 4)).toEqual([
      "Breaking Bad - S01E01 - Episode 1.mkv",
      "Breaking Bad - S01E02 - Episode 2.mkv",
      "Breaking Bad - S01E03 - Episode 3.mkv",
      "Breaking Badly - S01E04 - Episode 4.mkv",
    ]);
    for (const op of corrector.operations.slice(0, 3)) {
      expect(op.mediaFile.matchedMetadata?.verificationStatus).toBe("manual_selection");
      expect(op.mediaFile.correction?.match).toBe("chosen");
    }
    expect(corrector.operations[3]!.mediaFile.correction).toBeUndefined();
    expect(corrector.operations[4]!.mediaFile.correction).toBeUndefined();
    // Each episode was looked up with its own numbers.
    expect(tv.episodeCalls.filter(([id]) => id === breakingBad.id).map(([, s, e]) => `${s}x${e}`).sort()).toEqual([
      "1x1",
      "1x2",
      "1x3",
      "1x4",
    ]);
    // A second correction of an episode re-checks conflicts with the rest.
    await corrector.chooseMatch(3, { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 3 }, breakingBad);
    expect(corrector.operations[3]!.skipReason).toBe("duplicate_destination");
    expect(corrector.operations[2]!.status).toBe("pending");
  });

  it("does not offer music files or files without episode numbers as similar", async () => {
    const files = [
      await touch(dir, "Breaking.Bad.S01E01.mkv"),
      await touch(dir, "Breaking.Bad.mkv"),
      await touch(dir, "Breaking Bad.mp3"),
    ];
    const { corrector } = await planned(service(), files);
    expect(corrector.similarFiles(0)).toEqual([]);
  });
});

describe("clearing a match", () => {
  it("leaves the file alone with skip reason match_cleared", async () => {
    const file = await touch(dir, "The.Matrix.1999.mkv");
    await touch(dir, "The.Matrix.1999.srt");
    const { corrector } = await planned(service({ movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) }), [file]);
    const [op] = await corrector.clearMatch(0);
    expect(op).toMatchObject({ status: "skipped", skipReason: "match_cleared", destination: file, associatedFiles: [] });
    expect(op!.mediaFile.matchedMetadata).toBeUndefined();
    expect(op!.mediaFile.correction).toMatchObject({ match: "cleared" });
  });
});

describe("editing a new name", () => {
  async function matrixPlan(options: RenameServiceOptions = {}) {
    const file = await touch(dir, "The.Matrix.1999.mkv");
    await touch(dir, "The.Matrix.1999.en.srt");
    const svc = service({ movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }), ...options });
    return { file, ...(await planned(svc, [file])) };
  }

  it("offers the template's name without the extension", async () => {
    const { corrector } = await matrixPlan();
    await expect(corrector.editableName(0)).resolves.toEqual({
      name: "The Matrix (1999)",
      templateName: "The Matrix (1999)",
      extension: ".mkv",
      folder: "",
      custom: false,
    });
  });

  it("uses the typed name, keeps the extension, and moves associated files along", async () => {
    const { corrector } = await matrixPlan();
    const result = await corrector.setName(0, "Matrix, The (1999) {Director's Cut}");
    expect(result.kind).toBe("applied");
    const op = corrector.operations[0]!;
    expect(path.basename(op.destination)).toBe("Matrix, The (1999) {Director's Cut}.mkv");
    expect(op.associatedFiles.map((a) => path.basename(a.destination))).toEqual([
      "Matrix, The (1999) {Director's Cut}.en.srt",
    ]);
    expect(op.mediaFile.correction).toMatchObject({ customName: "Matrix, The (1999) {Director's Cut}" });
    await expect(corrector.editableName(0)).resolves.toMatchObject({ name: "Matrix, The (1999) {Director's Cut}", custom: true });

    // Back to the template's name.
    await corrector.setName(0, null);
    expect(path.basename(corrector.operations[0]!.destination)).toBe("The Matrix (1999).mkv");
    expect(corrector.operations[0]!.mediaFile.correction).toBeUndefined();
  });

  it("refuses invalid names and names another file already has, changing nothing", async () => {
    const { corrector } = await matrixPlan();
    await touch(dir, "Taken.mkv");
    const before = structuredClone(corrector.operations);
    await expect(corrector.setName(0, "a/b")).resolves.toMatchObject({ kind: "invalid", problem: "invalid_characters" });
    await expect(corrector.setName(0, "..")).resolves.toMatchObject({ kind: "invalid", problem: "dots_only" });
    await expect(corrector.setName(0, "Taken")).resolves.toMatchObject({ kind: "invalid", problem: "exists" });
    expect(corrector.operations).toEqual(before);
    // Its own current name is fine (nothing to rename).
    await expect(corrector.setName(0, "The.Matrix.1999")).resolves.toMatchObject({ kind: "applied" });
  });

  it("refuses an existing name even with the overwrite strategy", async () => {
    const { corrector } = await matrixPlan({ conflictStrategy: "overwrite", fileRenamer: new FileRenamer({ overwrite: true }) });
    await touch(dir, "Keep Me.mkv", "precious");
    await expect(corrector.setName(0, "Keep Me")).resolves.toMatchObject({ kind: "invalid", problem: "exists" });
    expect(await readFile(path.join(dir, "Keep Me.mkv"), "utf8")).toBe("precious");
  });

  it("has nothing to edit without a match", async () => {
    const file = await touch(dir, "Unknown.Film.mkv");
    const { corrector } = await planned(service(), [file]);
    await expect(corrector.editableName(0)).resolves.toBeUndefined();
    await expect(corrector.setName(0, "Anything")).resolves.toEqual({ kind: "not_editable" });
  });

  it("re-checks conflicts: a typed name another file in the list gets is a duplicate", async () => {
    const a = await touch(dir, "The.Matrix.1999.mkv");
    const b = await touch(dir, "Reloaded.2003.mkv");
    const movies = new FakeMovieProvider({ "The Matrix": [matrix], Reloaded: [matrixReloaded] });
    const { corrector } = await planned(service({ movieProvider: movies }), [a, b]);
    await corrector.setName(1, "The Matrix (1999)");
    expect(corrector.operations[0]!.status).toBe("pending");
    expect(corrector.operations[1]!.skipReason).toBe("duplicate_destination");
  });

  it("keeps the folders a music template creates", async () => {
    const file = await touch(dir, "song.mp3");
    const svc = service({ musicParser: new FakeMusicParser({ "song.mp3": completeTags }) });
    const { corrector } = await planned(svc, [file]);
    await expect(corrector.editableName(0)).resolves.toMatchObject({
      name: "11 - Bohemian Rhapsody",
      folder: path.join("Queen", "A Night at the Opera (1975)"),
      extension: ".mp3",
    });
    await corrector.setName(0, "Bo Rhap");
    expect(path.relative(dir, corrector.operations[0]!.destination)).toBe(
      path.join("Queen", "A Night at the Opera (1975)", "Bo Rhap.mp3"),
    );
  });

  it("drops the typed name when the match changes, and a new lookup drops every correction", async () => {
    const { file, corrector } = await matrixPlan();
    await corrector.setName(0, "Custom");
    await corrector.chooseMatch(0, { mediaType: "movie", title: "Reloaded" }, matrixReloaded);
    expect(path.basename(corrector.operations[0]!.destination)).toBe("The Matrix Reloaded (2003).mkv");

    const fresh = await corrector.service.processFiles([file]);
    expect(fresh[0]!.mediaFile.correction).toBeUndefined();
    expect(path.basename(fresh[0]!.destination)).toBe("The Matrix (1999).mkv");
  });
});

describe("data safety after corrections", () => {
  it("never overwrites a file in the batch when a chosen match takes its name (overwrite strategy)", async () => {
    const a = await touch(dir, "Old.Name.2000.mkv", "A");
    const b = await touch(dir, "The Matrix (1999).mkv", "B");
    const movies = new FakeMovieProvider({ "Old Name": [createMovie({ id: 1, title: "Old", originalTitle: "Old", year: 2000 })], "The Matrix": [matrixReloaded] });
    const svc = service({ movieProvider: movies, conflictStrategy: "overwrite", fileRenamer: new FileRenamer({ overwrite: true }) });
    const { corrector } = await planned(svc, [a, b]);
    await corrector.chooseMatch(0, { mediaType: "movie", title: "The Matrix" }, matrix);
    await svc.executeRename(corrector.operations);

    const contents = await Promise.all((await readdir(dir)).map((n) => readFile(path.join(dir, n), "utf8")));
    expect(contents.sort()).toEqual(["A", "B"]);
  });

  it("renames to the typed name on disk, with associated files", async () => {
    const file = await touch(dir, "The.Matrix.1999.mkv", "movie");
    await touch(dir, "The.Matrix.1999.en.srt", "subs");
    const svc = service({ movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) });
    const { corrector } = await planned(svc, [file]);
    await corrector.setName(0, "My Matrix");
    await svc.executeRename(corrector.operations);
    expect(await readFile(path.join(dir, "My Matrix.mkv"), "utf8")).toBe("movie");
    expect(await readFile(path.join(dir, "My Matrix.en.srt"), "utf8")).toBe("subs");
    expect(existsSync(file)).toBe(false);
  });
});

describe("selection callback context", () => {
  it("receives the full path of the file it is asked about", async () => {
    const a = await touch(dir, "one/The.Matrix.1999.mkv");
    const b = await touch(dir, "two/The.Matrix.1999.mkv");
    const contexts: SelectionContext[] = [];
    const svc = service({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix, matrixReloaded] }),
      selectionCallback: (_options, _name, context) => {
        contexts.push(context);
        return 0;
      },
    });
    await svc.processFiles([a, b]);
    // The second file reuses the first answer, so only the first is asked.
    expect(contexts).toEqual([{ path: a }]);
  });
});
