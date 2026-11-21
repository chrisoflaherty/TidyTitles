import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings, type Settings } from "../src/config";
import { ConfigError } from "../src/errors";
import { createRenameOperation, createParsedInfo, type RenameOperation } from "../src/models";
import { MusicBrainzClient } from "../src/providers/musicbrainz";
import { TMDBClient } from "../src/providers/tmdb";
import { TVDBClient } from "../src/providers/tvdb";
import { isNullProvider } from "../src/renameService";
import {
  collectMediaFiles,
  extensionsForMediaType,
  isMediaFile,
  isVideoFile,
  MEDIA_EXTENSIONS,
  scanDirectory,
  VIDEO_EXTENSIONS,
} from "../src/scan";
import {
  availableProviderChoices,
  buildCoverArtDownloader,
  buildFileRenamer,
  buildProviders,
  buildRenameService,
  buildTemplateEngine,
  checkApiKeys,
  completedHistoryOperations,
  createSession,
  forceTypeForChoice,
  getApiKeyStatus,
  MissingApiKeyError,
  recordHistory,
  RenameSession,
  resolveConflictStrategy,
  summarizeOperations,
  undoHistoryOperations,
  undoLastRename,
} from "../src/session";
import { FakeMovieProvider, FakeMusicParser, FakeTVProvider, breakingBad, matrix, pilot, touch } from "./fakes";
import { mockFetch } from "./providers/mock-fetch";

let dir: string;
let media: string;
let config: ConfigService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-session-"));
  media = path.join(dir, "media");
  await mkdir(media);
  config = new ConfigService({
    configDir: path.join(dir, "config"),
    cacheDir: path.join(dir, "cache"),
    env: {},
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function settingsWith(
  keys: { tmdb?: string; tvdb?: string } = {},
  extra: Partial<Settings> = {},
): Settings {
  const s = createDefaultSettings();
  s.api.tmdbApiKey = keys.tmdb ?? "";
  s.api.tvdbApiKey = keys.tvdb ?? "";
  return { ...s, ...extra };
}

async function saveKeys(keys: { tmdb?: string; tvdb?: string }, extra: Partial<Settings> = {}) {
  await config.save(settingsWith(keys, extra));
}

const MATRIX_FILE = "The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv";

describe("choices", () => {
  it("maps media type choices to forced types", () => {
    expect(forceTypeForChoice("auto")).toBeUndefined();
    expect(forceTypeForChoice()).toBeUndefined();
    expect(forceTypeForChoice("movie")).toBe("movie");
    expect(forceTypeForChoice("tv")).toBe("tv_episode");
    expect(forceTypeForChoice("music")).toBe("music");
  });

  it("offers provider choices for the configured keys", () => {
    expect(availableProviderChoices(settingsWith({ tmdb: "a", tvdb: "b" }))).toEqual([
      "auto",
      "tmdb",
      "tvdb",
      "musicbrainz",
    ]);
    expect(availableProviderChoices(settingsWith({ tmdb: "a" }))).toEqual(["auto", "tmdb", "musicbrainz"]);
    expect(availableProviderChoices(settingsWith({ tvdb: "b" }))).toEqual(["auto", "tvdb", "musicbrainz"]);
    expect(availableProviderChoices(settingsWith())).toEqual(["musicbrainz"]);
  });
});

describe("API keys", () => {
  it("reports which keys are set (blank counts as missing)", () => {
    expect(getApiKeyStatus(settingsWith({ tmdb: "a", tvdb: "  " }))).toEqual({ tmdb: true, tvdb: false });
  });

  it("requires at least one key for movie/TV lookups", () => {
    const error = checkApiKeys(settingsWith());
    expect(error).toBeInstanceOf(MissingApiKeyError);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ reason: "no_keys", providers: ["tmdb", "tvdb"] });
    expect(checkApiKeys(settingsWith(), { mediaType: "movie" })?.reason).toBe("no_keys");
    expect(checkApiKeys(settingsWith({ tvdb: "b" }))).toBeUndefined();
  });

  it("needs no keys for music-only runs", () => {
    expect(checkApiKeys(settingsWith(), { mediaType: "music" })).toBeUndefined();
    expect(checkApiKeys(settingsWith(), { provider: "musicbrainz" })).toBeUndefined();
  });

  it("requires the chosen provider's key", () => {
    expect(checkApiKeys(settingsWith({ tvdb: "b" }), { provider: "tmdb" })).toMatchObject({
      reason: "provider_key_missing",
      providers: ["tmdb"],
      message: "TMDB API key not configured",
    });
    expect(checkApiKeys(settingsWith({ tmdb: "a" }), { provider: "tvdb" })).toMatchObject({
      reason: "provider_key_missing",
      providers: ["tvdb"],
    });
    expect(checkApiKeys(settingsWith({ tmdb: "a" }), { provider: "tmdb" })).toBeUndefined();
  });

  it("createSession throws MissingApiKeyError by default", async () => {
    await config.save(settingsWith());
    await expect(createSession(config)).rejects.toBeInstanceOf(MissingApiKeyError);
    await expect(createSession(config, { provider: "tmdb" })).rejects.toMatchObject({
      reason: "provider_key_missing",
    });
  });

  it("with requireApiKeys off, runs with null providers and finds nothing", async () => {
    await config.save(settingsWith());
    const session = await createSession(config, { requireApiKeys: false, cache: false });
    expect(isNullProvider(session.providers.movieProvider)).toBe(true);
    expect(isNullProvider(session.providers.tvProvider)).toBe(true);
    expect(session.providers.sources).toEqual({ music: "musicbrainz" });

    const file = await touch(media, MATRIX_FILE);
    const ops = await session.plan([file]);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "no_match" });
  });

  it("music-only sessions need no keys", async () => {
    await config.save(settingsWith());
    const session = await createSession(config, { mediaType: "music", cache: false });
    expect(session.forceType).toBe("music");
    expect(session.providers.musicProvider).toBeInstanceOf(MusicBrainzClient);
  });

  it("a rejected key shows up as an authentication lookup error on each file", async () => {
    await saveKeys({ tmdb: "bad-key" });
    const fetch = mockFetch([
      { path: "/3/search/movie", reply: { status: 401, json: { status_message: "Invalid API key" } } },
    ]);
    const session = await createSession(config, { fetch: fetch.fetch, cache: false });
    const a = await touch(media, MATRIX_FILE);
    const b = await touch(media, "Inception.2010.mkv");
    const ops = await session.plan([a, b]);
    expect(ops.map((o) => [o.skipReason, o.lookupError?.kind])).toEqual([
      ["lookup_failed", "authentication"],
      ["lookup_failed", "authentication"],
    ]);
  });
});

describe("buildProviders", () => {
  it("auto with both keys: TMDB for movies, TVDB for TV, MusicBrainz for music", () => {
    const set = buildProviders(settingsWith({ tmdb: "a", tvdb: "b" }));
    expect(set.movieProvider).toBeInstanceOf(TMDBClient);
    expect(set.tvProvider).toBeInstanceOf(TVDBClient);
    expect(set.musicProvider).toBeInstanceOf(MusicBrainzClient);
    expect(set.sources).toEqual({ movie: "tmdb", tv: "tvdb", music: "musicbrainz" });
    expect(Object.keys(set.clients).sort()).toEqual(["musicbrainz", "tmdb", "tvdb"]);
  });

  it("auto honors [providers] tv = \"tmdb\"", () => {
    const set = buildProviders(settingsWith({ tmdb: "a", tvdb: "b" }, { tvProvider: "tmdb" }));
    expect(set.sources.tv).toBe("tmdb");
    expect(set.tvProvider).toBe(set.clients.tmdb);
  });

  it("auto falls back to whichever key is set", () => {
    const tmdbOnly = buildProviders(settingsWith({ tmdb: "a" }));
    expect(tmdbOnly.sources).toEqual({ movie: "tmdb", tv: "tmdb", music: "musicbrainz" });

    const tvdbOnly = buildProviders(settingsWith({ tvdb: "b" }, { tvProvider: "tmdb" }));
    expect(tvdbOnly.sources).toEqual({ tv: "tvdb", music: "musicbrainz" });
    expect(isNullProvider(tvdbOnly.movieProvider)).toBe(true);
  });

  it("explicit providers limit what is looked up", () => {
    const keys = settingsWith({ tmdb: "a", tvdb: "b" });
    expect(buildProviders(keys, { provider: "tmdb" }).sources).toEqual({ movie: "tmdb", tv: "tmdb" });
    expect(buildProviders(keys, { provider: "tvdb" }).sources).toEqual({ tv: "tvdb" });
    const mb = buildProviders(keys, { provider: "musicbrainz" });
    expect(mb.sources).toEqual({ music: "musicbrainz" });
    expect(mb.clients.tmdb).toBeUndefined();
    expect(isNullProvider(mb.movieProvider)).toBe(true);
    expect(isNullProvider(buildProviders(keys, { provider: "tmdb" }).musicProvider)).toBe(true);
  });

  it("passes the fetch implementation and cache to the clients", async () => {
    const fetch = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [{ id: 603, title: "The Matrix", release_date: "1999-03-31" }] } } },
    ]);
    const set = buildProviders(settingsWith({ tmdb: "key" }), { fetch: fetch.fetch });
    const movies = await set.movieProvider.searchMovie("The Matrix", 1999);
    expect(movies[0]).toMatchObject({ id: 603, year: 1999 });
    expect(fetch.requests[0]!.url.searchParams.get("query")).toBe("The Matrix");
  });
});

describe("other builders", () => {
  it("builds the template engine from settings", () => {
    const s = settingsWith();
    s.templates.movie = "{title} [{year}]";
    expect(buildTemplateEngine(s).renderMovie(matrix, ".mkv")).toBe("The Matrix [1999].mkv");
  });

  it("falls back to skip for an invalid conflict strategy", () => {
    expect(resolveConflictStrategy(settingsWith({}, { conflictResolution: "auto_version" }))).toBe("auto_version");
    expect(resolveConflictStrategy(settingsWith({}, { conflictResolution: "bogus" }))).toBe("skip");
  });

  it("turns on overwriting only for the overwrite strategy", () => {
    expect(buildFileRenamer(settingsWith({}, { conflictResolution: "overwrite" })).overwrite).toBe(true);
    expect(buildFileRenamer(settingsWith()).overwrite).toBe(false);
    expect(buildFileRenamer(settingsWith(), { dryRun: true }).dryRun).toBe(true);
  });

  it("builds the cover art downloader from [cover_art]", () => {
    const s = settingsWith();
    s.coverArt = { enabled: true, filename: "folder.jpg", musicFilename: "front.jpg", overwrite: true, size: "w780" };
    const d = buildCoverArtDownloader(s);
    expect([d.filename, d.musicFilename, d.overwrite, d.size]).toEqual(["folder.jpg", "front.jpg", true, "w780"]);
  });

  it("builds a rename service with settings applied", () => {
    const s = settingsWith({}, { conflictResolution: "auto_version" });
    s.associatedFiles.images = false;
    const svc = buildRenameService(s);
    expect(svc.conflictStrategy).toBe("auto_version");
    expect(svc.associatedFilesSettings.images).toBe(false);
    expect(svc.templateEngine.movieTemplate).toBe(s.templates.movie);
  });
});

describe("scanning", () => {
  async function tree() {
    await touch(media, "b.mkv");
    await touch(media, "a.MP4");
    await touch(media, "song.flac");
    await touch(media, "notes.txt");
    await touch(media, "a.srt");
    await touch(media, "._a.mkv");
    await touch(media, ".hidden.mkv");
    await touch(media, "Season 1/e01.mkv");
    await touch(media, "Season 1/Deeper/e02.avi");
    await touch(media, ".trash/old.mkv");
  }

  it("scans one level by default, matching extensions case-insensitively and skipping hidden files", async () => {
    await tree();
    expect(await scanDirectory(media)).toEqual(
      ["a.MP4", "b.mkv", "song.flac"].map((n) => path.join(media, n)),
    );
  });

  it("scans recursively, skipping hidden directories", async () => {
    await tree();
    expect(await scanDirectory(media, { recursive: true })).toEqual(
      ["Season 1/Deeper/e02.avi", "Season 1/e01.mkv", "a.MP4", "b.mkv", "song.flac"].map((n) =>
        path.join(media, n),
      ),
    );
  });

  it("filters by media type or explicit extensions", async () => {
    await tree();
    expect(await scanDirectory(media, { mediaType: "music" })).toEqual([path.join(media, "song.flac")]);
    expect(await scanDirectory(media, { mediaType: "tv_episode" })).toEqual(
      ["a.MP4", "b.mkv"].map((n) => path.join(media, n)),
    );
    expect(await scanDirectory(media, { extensions: new Set([".srt"]) })).toEqual([path.join(media, "a.srt")]);
  });

  it("follows symlinked files", async () => {
    const target = await touch(dir, "outside.mkv");
    await symlink(target, path.join(media, "link.mkv"));
    expect(await scanDirectory(media)).toEqual([path.join(media, "link.mkv")]);
  });

  it("exposes the extension sets", () => {
    expect(extensionsForMediaType("movie")).toBe(VIDEO_EXTENSIONS);
    expect(extensionsForMediaType(undefined)).toBe(MEDIA_EXTENSIONS);
    expect(isVideoFile("x.M2TS")).toBe(true);
    expect(isMediaFile("x.opus")).toBe(true);
    expect(isMediaFile("x.srt")).toBe(false);
  });

  it("collects files and directories, de-duplicated and sorted", async () => {
    await tree();
    const notes = path.join(media, "notes.txt");
    const files = await collectMediaFiles([
      path.join(media, "Season 1"),
      path.join(media, "b.mkv"),
      media,
      notes,
      path.join(media, "missing.mkv"),
    ]);
    expect(files).toEqual(
      [path.join(media, "Season 1/e01.mkv"), path.join(media, "a.MP4"), path.join(media, "b.mkv"), notes, path.join(media, "song.flac")].sort(),
    );
  });

  it("can filter explicitly named files too", async () => {
    await tree();
    const files = await collectMediaFiles([path.join(media, "notes.txt"), path.join(media, "b.mkv")], {
      filterExplicitFiles: true,
    });
    expect(files).toEqual([path.join(media, "b.mkv")]);
  });

  it("returns absolute paths for relative input", async () => {
    await tree();
    const rel = path.relative(process.cwd(), path.join(media, "b.mkv"));
    expect(await collectMediaFiles([rel])).toEqual([path.join(media, "b.mkv")]);
  });

  it("session.collectFiles uses the session's media type", async () => {
    await tree();
    await config.save(settingsWith());
    const session = await createSession(config, { mediaType: "music", cache: false });
    expect(await session.collectFiles([media], { recursive: true })).toEqual([path.join(media, "song.flac")]);
    expect(session.extensions.has(".flac")).toBe(true);
  });
});

describe("summaries and history records", () => {
  function op(status: RenameOperation["status"], assoc = 0): RenameOperation {
    return createRenameOperation({
      source: `/a/${status}.mkv`,
      destination: `/b/${status}.mkv`,
      mediaFile: { path: `/a/${status}.mkv`, parsedInfo: createParsedInfo({ title: "x" }) },
      status,
      associatedFiles: Array.from({ length: assoc }, (_, i) => ({
        source: `/a/${i}.srt`,
        destination: `/b/${i}.srt`,
        fileType: "subtitle" as const,
      })),
    });
  }

  it("summarizes operations", () => {
    expect(summarizeOperations([op("completed", 2), op("failed"), op("skipped"), op("pending", 1)])).toEqual({
      total: 4,
      completed: 1,
      failed: 1,
      skipped: 1,
      pending: 1,
      associatedFiles: 3,
      totalFiles: 7,
    });
  });

  it("records only completed operations", async () => {
    expect(completedHistoryOperations([op("completed", 1), op("failed")])).toEqual([
      {
        source: "/a/completed.mkv",
        destination: "/b/completed.mkv",
        associatedFiles: [{ source: "/a/0.srt", destination: "/b/0.srt" }],
      },
    ]);
    expect(await recordHistory(config, [op("failed")])).toBe(0);
    expect(existsSync(config.historyFile)).toBe(false);
    expect(await recordHistory(config, [op("completed")])).toBe(1);
    expect(await config.getLastOperations()).toHaveLength(1);
  });
});

describe("full flow", () => {
  async function session(options: Parameters<typeof createSession>[1] = {}) {
    await saveKeys({ tmdb: "key", tvdb: "key" });
    return createSession(config, {
      cache: false,
      musicParser: new FakeMusicParser(),
      providers: {
        movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
        tvProvider: new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { 1396: pilot() }),
      },
      ...options,
    });
  }

  it("plan -> execute -> cover art -> history -> undo -> history cleared", async () => {
    const movie = await touch(media, MATRIX_FILE);
    const srt = await touch(media, MATRIX_FILE.replace(/\.mkv$/, ".en.srt"));
    const episode = await touch(media, "Shows/Breaking.Bad.S01E01.720p.mkv");
    const unknown = await touch(media, "random notes.mkv");

    const fetch = mockFetch([{ path: /^\/t\/p\//, reply: { body: "JPEGDATA" } }]);
    const s = await session({ fetch: fetch.fetch });

    const files = await s.collectFiles([media], { recursive: true });
    expect(files).toEqual([episode, movie, unknown]);

    const ops = await s.plan(files);
    expect(ops.map((o) => path.basename(o.destination))).toEqual([
      "Breaking Bad - S01E01 - Pilot.mkv",
      "The Matrix (1999).mkv",
      "random notes.mkv",
    ]);

    await s.execute(ops);
    expect(summarizeOperations(ops)).toMatchObject({ completed: 2, skipped: 1, associatedFiles: 1 });
    expect(existsSync(path.join(media, "The Matrix (1999).en.srt"))).toBe(true);

    const art = await s.downloadCoverArt(ops);
    expect(art).toEqual([path.join(media, "poster.jpg")]);
    expect(await readFile(path.join(media, "poster.jpg"), "utf8")).toBe("JPEGDATA");

    expect(await s.saveHistory(ops)).toBe(2);
    const raw = JSON.parse(await readFile(config.historyFile, "utf8"));
    expect(raw[0].operations[1]).toEqual({
      source: movie,
      destination: path.join(media, "The Matrix (1999).mkv"),
      associated_files: [
        {
          source: srt,
          destination: path.join(media, "The Matrix (1999).en.srt"),
          fingerprint: expect.objectContaining({ size: expect.stringMatching(/^\d+$/) }),
        },
      ],
      fingerprint: {
        dev: expect.stringMatching(/^\d+$/),
        ino: expect.stringMatching(/^\d+$/),
        size: expect.stringMatching(/^\d+$/),
        mtime_ns: expect.stringMatching(/^\d+$/),
      },
    });

    const progress: string[] = [];
    const result = await s.undoLast({ progressCallback: (c, t, m) => progress.push(`${c}/${t} ${m}`) });
    expect(result).toMatchObject({ historyFound: true, undone: 2, missing: 0, failed: 0 });
    expect(progress).toEqual(["1/2 Undoing: The Matrix (1999).mkv", "2/2 Undoing: Breaking Bad - S01E01 - Pilot.mkv"]);
    for (const f of [movie, srt, episode]) expect(existsSync(f)).toBe(true);
    expect(existsSync(path.join(media, "The Matrix (1999).mkv"))).toBe(false);
    expect(await config.loadHistory()).toEqual([]);

    expect(await undoLastRename(config)).toEqual({
      historyFound: false,
      items: [],
      kept: 0,
      undone: 0,
      missing: 0,
      failed: 0,
    });
  });

  it("dry run renames nothing and records no history or cover art", async () => {
    const movie = await touch(media, MATRIX_FILE);
    const s = await session({ dryRun: true });
    const ops = await s.plan([movie]);
    await s.execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(existsSync(movie)).toBe(true);
    expect(await s.downloadCoverArt(ops)).toEqual([]);
    expect(await s.saveHistory(ops)).toBe(0);
    expect(existsSync(config.historyFile)).toBe(false);
  });

  it("uses the overwrite strategy from settings end to end", async () => {
    const movie = await touch(media, MATRIX_FILE, "new");
    await touch(media, "The Matrix (1999).mkv", "old");
    await config.save(settingsWith({ tmdb: "key" }, { conflictResolution: "overwrite" }));
    const s = await createSession(config, {
      cache: false,
      providers: { movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) },
    });
    const ops = await s.execute(await s.plan([movie]));
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(path.join(media, "The Matrix (1999).mkv"), "utf8")).toBe("new");
  });

  it("asks the session's selection callback, which can be replaced", async () => {
    const movie = await touch(media, MATRIX_FILE);
    const s = await session({
      providers: {
        movieProvider: new FakeMovieProvider({ "The Matrix": [matrix, { ...matrix, id: 1, title: "Other", year: 2000 }] }),
      },
    });
    s.selectionCallback = async () => 1;
    const ops = await s.plan([movie]);
    expect(path.basename(ops[0]!.destination)).toBe("Other (2000).mkv");
    expect(s.selectionCallback).toBeDefined();
  });

  it("puts the API cache in the config's cache directory by default", async () => {
    await saveKeys({ tmdb: "key" });
    const fetch = mockFetch([{ path: "/3/search/movie", reply: { json: { results: [] } } }]);
    const s = await createSession(config, { fetch: fetch.fetch });
    await s.providers.movieProvider.searchMovie("Anything");
    await s.providers.movieProvider.searchMovie("Anything");
    expect(fetch.requests).toHaveLength(1);
    expect(existsSync(config.cacheDir)).toBe(true);
  });

  it("history needs a config", async () => {
    const s = new RenameSession(settingsWith({ tmdb: "key" }), { cache: false });
    await expect(s.saveHistory([])).rejects.toBeInstanceOf(ConfigError);
    await expect(s.undoLast()).rejects.toBeInstanceOf(ConfigError);
    expect(s.coverArtEnabled).toBe(false);
  });
});

describe("undo from history", () => {
  it("reports files that are no longer at their renamed paths as missing", async () => {
    await config.saveHistory([{ source: path.join(media, "a.mkv"), destination: path.join(media, "A.mkv"), associatedFiles: [] }]);
    const result = await undoLastRename(config);
    expect(result).toMatchObject({ undone: 0, missing: 1, failed: 0 });
    expect(result.items[0]!.status).toBe("missing");
    expect(await config.loadHistory()).toEqual([]);
  });

  it("keeps what could not be undone in history so undo can be retried", async () => {
    const okSource = path.join(media, "ok.mkv");
    const okDest = await touch(media, "Ok (2000).mkv");
    const blockedSource = await touch(media, "blocked.mkv", "someone else");
    const blockedDest = await touch(media, "Blocked (2001).mkv");
    const subSource = path.join(media, "blocked.srt");
    const subDest = await touch(media, "Blocked (2001).srt");

    const ops = [
      { source: okSource, destination: okDest, associatedFiles: [] },
      { source: blockedSource, destination: blockedDest, associatedFiles: [{ source: subSource, destination: subDest }] },
    ];
    await config.saveHistory(ops);

    const result = await undoLastRename(config);
    expect(result).toMatchObject({ undone: 1, failed: 1 });
    const failed = result.items.find((i) => i.status === "failed")!;
    expect(failed.errors[0]).toMatch(/^Blocked \(2001\)\.mkv: Destination already exists/);
    expect(existsSync(okSource)).toBe(true);
    expect(existsSync(subSource)).toBe(true);

    // Only the blocked main file is left in history (its subtitle went back).
    expect(await config.getLastOperations()).toEqual([
      { source: blockedSource, destination: blockedDest, associatedFiles: [] },
    ]);

    // Clear the obstacle and retry.
    await rm(blockedSource);
    expect(await undoLastRename(config)).toMatchObject({ undone: 1, failed: 0 });
    expect(await readFile(blockedSource, "utf8")).toBe("Blocked (2001).mkv");
    expect(await config.loadHistory()).toEqual([]);
  });

  it("leaves history alone when nothing could be moved", async () => {
    const source = await touch(media, "x.mkv");
    const dest = await touch(media, "X (1).mkv");
    await config.saveHistory([{ source, destination: dest, associatedFiles: [] }]);
    const before = await readFile(config.historyFile, "utf8");
    expect(await undoLastRename(config)).toMatchObject({ failed: 1, undone: 0 });
    expect(await readFile(config.historyFile, "utf8")).toBe(before);
  });

  it("undoes operations last-first, so chained renames unwind", async () => {
    // x was renamed to y, then y to z: undo must move z -> y before y -> x.
    const x = path.join(media, "x.mkv");
    const y = path.join(media, "y.mkv");
    const z = await touch(media, "z.mkv", "originally x");
    const result = await undoHistoryOperations([
      { source: x, destination: y, associatedFiles: [] },
      { source: y, destination: z, associatedFiles: [] },
    ]);
    expect(result).toMatchObject({ undone: 2, failed: 0 });
    expect(await readFile(x, "utf8")).toBe("originally x");
    expect(existsSync(y)).toBe(false);
    expect(existsSync(z)).toBe(false);
  });
});
