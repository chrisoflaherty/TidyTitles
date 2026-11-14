/** Concurrency in RenameService.parseFiles / fetchMetadata, and album verification. */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors";
import { createAlbum, createParsedMusicInfo, createTrack, type Album, type Movie, type ParsedMusicInfo, type Track } from "../src/models";
import type { MusicParser } from "../src/musicParser";
import type { MovieProvider } from "../src/providers/base";
import { RenameService, type RenameServiceOptions } from "../src/renameService";
import {
  FakeMusicParser,
  FakeMusicProvider,
  FakeTVProvider,
  bohemian,
  bohemianLive,
  breakingBad,
  breakingBadRemake,
  matrix,
  matrixReloaded,
  pilot,
  touch,
} from "./fakes";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-concurrency-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(options: RenameServiceOptions = {}): RenameService {
  return new RenameService({ musicParser: new FakeMusicParser(), ...options });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise with its resolve/reject exposed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Movie provider whose searches stay pending until the test answers them,
 * so tests decide the order responses arrive in.
 */
class ControlledMovieProvider implements MovieProvider {
  readonly pending = new Map<string, ReturnType<typeof deferred<Movie[]>>>();
  readonly calls: string[] = [];
  active = 0;
  maxActive = 0;

  searchMovie(title: string): Promise<Movie[]> {
    this.calls.push(title);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const d = deferred<Movie[]>();
    this.pending.set(title, d);
    return d.promise.finally(() => {
      this.active -= 1;
    });
  }
  async getMovie(): Promise<undefined> {
    return undefined;
  }
  answer(title: string, result: Movie[] | Error): void {
    const d = this.pending.get(title);
    if (!d) throw new Error(`no pending search for ${title}`);
    if (result instanceof Error) d.reject(result);
    else d.resolve(result);
  }
}

const movie = (id: number, title: string): Movie => ({ ...matrix, id, title, originalTitle: title });

async function movieFiles(count: number): Promise<string[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => touch(dir, `Film ${i + 1} (2001).mkv`)));
}

describe("fetchMetadata concurrency", () => {
  it("runs lookups concurrently, bounded by fetchConcurrency", async () => {
    const files = await movieFiles(10);
    const movies = new ControlledMovieProvider();
    const svc = service({ movieProvider: movies, fetchConcurrency: 3 });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed);

    await tick();
    expect(movies.calls).toEqual(["Film 1", "Film 2", "Film 3"]);
    // Answer out of order; each answer lets the next file start, in file order.
    movies.answer("Film 3", [movie(3, "Film 3")]);
    await tick();
    expect(movies.calls).toEqual(["Film 1", "Film 2", "Film 3", "Film 4"]);
    // Keep answering the newest pending search first (the reverse of file order).
    const answered = new Set(["Film 3"]);
    while (answered.size < 10) {
      const newest = [...movies.pending.keys()].filter((t) => !answered.has(t)).at(-1)!;
      answered.add(newest);
      movies.answer(newest, [movie(Number(newest.slice(5)), newest)]);
      await tick();
      expect(movies.active).toBeLessThanOrEqual(3);
    }
    await fetch;
    expect(movies.maxActive).toBe(3);
    expect(parsed.map((f) => (f.matchedMetadata as Movie).id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("gives the same results and progress whatever order responses arrive in", async () => {
    const files = await movieFiles(6);
    const runOnce = async (order: number[]) => {
      const movies = new ControlledMovieProvider();
      const progress: unknown[] = [];
      const svc = service({ movieProvider: movies, selectionCallback: () => 1 });
      const parsed = await svc.parseFiles(files);
      const fetch = svc.fetchMetadata(parsed, {
        progressCallback: (current, total, message) => progress.push([current, total, message]),
      });
      await tick();
      for (const i of order) {
        // Odd files have two results and need a question.
        const n = i + 1;
        movies.answer(`Film ${n}`, n % 2 ? [movie(n, `Film ${n}`), movie(100 + n, "Other")] : [movie(n, `Film ${n}`)]);
        await tick();
      }
      await fetch;
      return {
        progress,
        results: parsed.map((f) => [(f.matchedMetadata as Movie).id, f.matchedMetadata?.verificationStatus]),
      };
    };

    const forward = await runOnce([0, 1, 2, 3, 4, 5]);
    const backward = await runOnce([5, 4, 3, 2, 1, 0]);
    const shuffled = await runOnce([3, 0, 5, 1, 4, 2]);
    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.results).toEqual([
      [101, "manual_selection"],
      [2, "auto_matched"],
      [103, "manual_selection"],
      [4, "auto_matched"],
      [105, "manual_selection"],
      [6, "auto_matched"],
    ]);
    expect(forward.progress).toEqual(
      Array.from({ length: 6 }, (_, i) => [i + 1, 6, `Fetching: Film ${i + 1}`]),
    );
  });

  it("reports progress monotonically, in file order, up to the total", async () => {
    const files = await movieFiles(4);
    const movies = new ControlledMovieProvider();
    const progress: number[] = [];
    const svc = service({ movieProvider: movies });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed, { progressCallback: (current) => progress.push(current) });
    await tick();
    movies.answer("Film 4", []);
    movies.answer("Film 2", []);
    await tick();
    expect(progress).toEqual([]); // Film 1 is not done yet
    movies.answer("Film 1", []);
    await tick();
    expect(progress).toEqual([1, 2]);
    movies.answer("Film 3", []);
    await fetch;
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  it("a provider error affects only its own file", async () => {
    const files = await movieFiles(3);
    const movies = new ControlledMovieProvider();
    const svc = service({ movieProvider: movies });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed);
    await tick();
    movies.answer("Film 3", [movie(3, "Film 3")]);
    movies.answer("Film 2", new ProviderError("down"));
    movies.answer("Film 1", [movie(1, "Film 1")]);
    await fetch;
    expect(parsed.map((f) => f.lookupError?.kind)).toEqual([undefined, "provider", undefined]);
    expect(parsed.map((f) => (f.matchedMetadata as Movie | undefined)?.id)).toEqual([1, undefined, 3]);
  });
});

describe("questions under concurrency", () => {
  it("asks one at a time, in file order, even when later searches finish first", async () => {
    const files = await movieFiles(3);
    const movies = new ControlledMovieProvider();
    const asked: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const answers = new Map<string, ReturnType<typeof deferred<number>>>();
    const cb = vi.fn((_options: unknown, filename: string) => {
      asked.push(filename);
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      const d = deferred<number>();
      answers.set(filename, d);
      return d.promise.finally(() => (open -= 1));
    });
    const svc = service({ movieProvider: movies, selectionCallback: cb });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed);
    await tick();

    movies.answer("Film 3", [movie(3, "Film 3"), movie(33, "Film 3 again")]);
    movies.answer("Film 2", [movie(2, "Film 2"), movie(22, "Film 2 again")]);
    await tick();
    expect(asked).toEqual([]); // Film 1 comes first
    movies.answer("Film 1", [movie(1, "Film 1"), movie(11, "Film 1 again")]);
    await tick();
    expect(asked).toEqual(["Film 1 (2001).mkv"]);
    answers.get("Film 1 (2001).mkv")!.resolve(0);
    await tick();
    expect(asked).toEqual(["Film 1 (2001).mkv", "Film 2 (2001).mkv"]);
    answers.get("Film 2 (2001).mkv")!.resolve(1);
    await tick();
    answers.get("Film 3 (2001).mkv")!.resolve(0);
    await fetch;

    expect(maxOpen).toBe(1);
    expect(asked).toEqual(["Film 1 (2001).mkv", "Film 2 (2001).mkv", "Film 3 (2001).mkv"]);
    expect(parsed.map((f) => (f.matchedMetadata as Movie).id)).toEqual([1, 22, 3]);
  });

  it("asks which show once for every episode, whichever search finishes first", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `Breaking.Bad.S01E0${i + 1}.mkv`);
    const files = await Promise.all(names.map((n) => touch(dir, n)));
    // The first file's search is the slowest.
    let call = 0;
    const tv = new FakeTVProvider(
      {
        "Breaking Bad": async () => {
          const delay = call++ === 0 ? 30 : 1;
          await new Promise((r) => setTimeout(r, delay));
          return [breakingBad, breakingBadRemake];
        },
      },
      { 1396: pilot(), 9999: pilot(breakingBadRemake) },
    );
    const cb = vi.fn((_options: unknown, _filename: string) => 1);
    const ops = await service({ tvProvider: tv, selectionCallback: cb }).processFiles(files);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![1]).toBe(names[0]);
    expect(tv.episodeCalls.map(([id]) => id)).toEqual(Array(8).fill(9999));
    expect(ops.every((op) => op.mediaFile.matchedMetadata?.verificationStatus === "manual_selection")).toBe(true);
  });

  it("asks which album once per folder, whichever search finishes first", async () => {
    const queen = bohemian.artist;
    const opera = bohemian.album!;
    const live = bohemianLive.album!;
    const love = { ...bohemian, id: "rec-3", title: "Love of My Life", album: opera };
    const loveLive = { ...bohemianLive, id: "rec-4", title: "Love of My Life (Live)", album: live };
    const slow = <T>(value: T, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      return value;
    };
    const music = new FakeMusicProvider({
      "Bohemian Rhapsody": slow([bohemianLive, bohemian], 30),
      "Love of My Life": slow([loveLive, love], 1),
    });
    const files = [await touch(dir, "album/a.mp3"), await touch(dir, "album/b.mp3")];
    const cb = vi.fn((_options: unknown, _filename: string) => 1);
    const ops = await service({
      musicProvider: music,
      musicParser: new FakeMusicParser({
        "a.mp3": { title: "Bohemian Rhapsody", artist: queen.name },
        "b.mp3": { title: "Love of My Life", artist: queen.name },
      }),
      selectionCallback: cb,
    }).processFiles(files);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![1]).toBe("a.mp3");
    expect(ops.map((op) => (op.mediaFile.matchedMetadata as Track).id)).toEqual(["rec-1", "rec-3"]);
  });

  it("never reports progress while a question is open", async () => {
    // File 1 has one show and passes its turn; its episode arrives while the
    // question for file 2 is open. File 3 finishes during the question too.
    const episodeGate = deferred<void>();
    const zebra = { ...breakingBad, id: 2, title: "Zebra Show" };
    const tv = new FakeTVProvider({
      "Breaking Bad": [breakingBad],
      "Zebra Show": [zebra, breakingBadRemake],
      "Yak Show": [{ ...breakingBad, id: 4, title: "Yak Show" }],
    });
    tv.getEpisode = async (showId: number) => {
      if (showId === breakingBad.id) await episodeGate.promise;
      return pilot();
    };
    const files = [
      await touch(dir, "Breaking.Bad.S01E01.mkv"),
      await touch(dir, "Zebra.Show.S01E01.mkv"),
      await touch(dir, "Yak.Show.S01E01.mkv"),
    ];
    const events: string[] = [];
    let open = false;
    const answer = deferred<number>();
    const svc = service({
      tvProvider: tv,
      selectionCallback: () => {
        open = true;
        events.push("ask");
        return answer.promise.finally(() => (open = false));
      },
    });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed, {
      progressCallback: (current) => {
        events.push(`progress ${current}${open ? " (while asking)" : ""}`);
      },
    });
    await vi.waitFor(() => expect(events).toEqual(["ask"]));
    episodeGate.resolve();
    await tick();
    await tick();
    expect(events).toEqual(["ask"]);
    answer.resolve(0);
    await fetch;
    expect(events).toEqual(["ask", "progress 1", "progress 2", "progress 3"]);
  });

  it("an error from the callback propagates, asks nothing more, and leaves files untouched", async () => {
    const files = await movieFiles(3);
    const movies = new ControlledMovieProvider();
    const cb = vi.fn(() => {
      throw new Error("canceled by user");
    });
    const svc = service({ movieProvider: movies, selectionCallback: cb });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed);
    const outcome = expect(fetch).rejects.toThrow("canceled by user");
    await tick();
    movies.answer("Film 2", [movie(2, "a"), movie(22, "b")]);
    movies.answer("Film 1", [movie(1, "a"), movie(11, "b")]);
    await outcome;
    movies.answer("Film 3", [movie(3, "a"), movie(33, "b")]);
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(parsed.every((f) => f.matchedMetadata === undefined && f.lookupError === undefined)).toBe(true);
  });
});

describe("abort under concurrency", () => {
  it("rejects promptly while requests are in flight and starts no new work", async () => {
    const files = await movieFiles(10);
    const movies = new ControlledMovieProvider();
    const controller = new AbortController();
    const svc = service({ movieProvider: movies, fetchConcurrency: 2 });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed, { signal: controller.signal });
    await tick();
    expect(movies.calls).toHaveLength(2);

    controller.abort(new Error("stop"));
    // Rejects although both searches are still pending.
    await expect(fetch).rejects.toThrow("stop");
    movies.answer("Film 1", [movie(1, "Film 1")]);
    movies.answer("Film 2", [movie(2, "Film 2")]);
    await tick();
    expect(movies.calls).toHaveLength(2);
    expect(parsed.every((f) => f.matchedMetadata === undefined)).toBe(true);
  });

  it("rejects while a question is open", async () => {
    const files = await movieFiles(2);
    const movies = new ControlledMovieProvider();
    const controller = new AbortController();
    const cb = vi.fn(() => new Promise<number>(() => undefined));
    const svc = service({ movieProvider: movies, selectionCallback: cb });
    const parsed = await svc.parseFiles(files);
    const fetch = svc.fetchMetadata(parsed, { signal: controller.signal });
    await tick();
    movies.answer("Film 1", [movie(1, "a"), movie(11, "b")]);
    movies.answer("Film 2", [movie(2, "a"), movie(22, "b")]);
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    controller.abort(new Error("stop"));
    await expect(fetch).rejects.toThrow("stop");
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("rejects at once with an already aborted signal", async () => {
    const files = await movieFiles(1);
    const movies = new ControlledMovieProvider();
    const svc = service({ movieProvider: movies });
    const parsed = await svc.parseFiles(files);
    await expect(svc.fetchMetadata(parsed, { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
    expect(movies.calls).toEqual([]);
  });
});

describe("parseFiles concurrency", () => {
  class SlowParser implements MusicParser {
    active = 0;
    maxActive = 0;
    canRead(): boolean {
      return true;
    }
    async parse(filePath: string): Promise<ParsedMusicInfo> {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      const n = Number(/(\d+)/.exec(path.basename(filePath))![1]);
      // Later files finish first.
      await new Promise((r) => setTimeout(r, (20 - n) * 2));
      this.active -= 1;
      return createParsedMusicInfo({ rawFilename: path.basename(filePath), source: "tags", title: `T${n}` });
    }
  }

  it("reads tags concurrently (up to 8), keeping input order and monotonic progress", async () => {
    const files = Array.from({ length: 20 }, (_, i) => path.join(dir, `${i + 1}.mp3`));
    const parser = new SlowParser();
    const progress: Array<[number, string]> = [];
    const parsed = await service({ musicParser: parser }).parseFiles(files, (current, _total, message) =>
      progress.push([current, message]),
    );
    expect(parser.maxActive).toBe(8);
    expect(parsed.map((f) => f.parsedMusicInfo?.title)).toEqual(files.map((_, i) => `T${i + 1}`));
    expect(progress).toEqual(files.map((f, i) => [i + 1, `Parsing: ${path.basename(f)}`]));
  });

  it("stops reading after a tag reader error", async () => {
    let calls = 0;
    const parser: MusicParser = {
      canRead: () => true,
      parse: async () => {
        calls += 1;
        throw new Error("unreadable");
      },
    };
    const files = Array.from({ length: 30 }, (_, i) => path.join(dir, `${i}.mp3`));
    await expect(service({ musicParser: parser, parseConcurrency: 2 }).parseFiles(files)).rejects.toThrow("unreadable");
    expect(calls).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Album verification
// ---------------------------------------------------------------------------

const artist = bohemian.artist;
const opera: Album = createAlbum({ id: "r-1", title: "A Night at the Opera", artist, year: 1975 });
const TITLES = ["Death on Two Legs", "Lazing on a Sunday Afternoon", "Love of My Life", "Bohemian Rhapsody"];
const albumTracks = TITLES.map((title, i) =>
  createTrack({ id: `rec-${i}`, title, artist, album: opera, trackNumber: i + 1 }),
);

/** Music provider with releases and track lists, counting each call. */
class AlbumMusicProvider extends FakeMusicProvider {
  releaseSearches: Array<[string, string | undefined]> = [];
  trackLookups: string[] = [];
  constructor(
    recordings: ConstructorParameters<typeof FakeMusicProvider>[0],
    private releases: Album[] | Error = [opera],
    private tracks: Record<string, Track[]> = { "r-1": albumTracks },
  ) {
    super(recordings);
  }
  override async searchRelease(album?: string, artistName?: string): Promise<Album[]> {
    this.releaseSearches.push([album ?? "", artistName]);
    if (this.releases instanceof Error) throw this.releases;
    return this.releases;
  }
  async getReleaseTracks(releaseId: string): Promise<Track[]> {
    this.trackLookups.push(releaseId);
    const tracks = this.tracks[releaseId];
    if (!tracks) throw new ProviderError("MusicBrainz API error: 404");
    return tracks;
  }
}

function albumTags(titles: string[], album = opera.title): Record<string, Partial<ParsedMusicInfo>> {
  return Object.fromEntries(
    titles.map((title, i) => [`${String(i + 1).padStart(2, "0")}.mp3`, { title, artist: "Queen", album, year: 1975, trackNumber: i + 1 }]),
  );
}

async function runAlbum(titles: string[], music: FakeMusicProvider, album?: string) {
  const tags = albumTags(titles, album);
  const files = await Promise.all(Object.keys(tags).map((name) => touch(dir, `album/${name}`)));
  const ops = await service({ musicProvider: music, musicParser: new FakeMusicParser(tags) }).processFiles(files);
  return ops.map((op) => op.mediaFile.matchedMetadata as Track);
}

describe("album verification for complete tags", () => {
  it("verifies an album with one release search and one track lookup", async () => {
    const music = new AlbumMusicProvider({});
    const tracks = await runAlbum(TITLES, music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(Array(4).fill("verified"));
    expect(music.releaseSearches).toEqual([[opera.title, "Queen"]]);
    expect(music.trackLookups).toEqual(["r-1"]);
    expect(music.calls).toEqual([]); // no per-track searches
    // The tags stay the source of the metadata.
    expect(tracks.map((t) => [t.id, t.title, t.trackNumber])).toEqual(TITLES.map((title, i) => ["local", title, i + 1]));
  });

  it("strips featured artists and normalizes like the per-track check", async () => {
    const music = new AlbumMusicProvider({});
    const tracks = await runAlbum(["the death on two legs!", "Love of My Life (feat. Someone)"], music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(["verified", "verified"]);
    expect(music.calls).toEqual([]);
  });

  it("falls back to the per-track search for a track not on the album", async () => {
    const bonus = { ...bohemian, id: "rec-b", title: "Bonus Track" };
    const music = new AlbumMusicProvider({ "Bonus Track": [bonus] });
    const tracks = await runAlbum(["Death on Two Legs", "Bonus Track", "Not Anywhere"], music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(["verified", "verified", "unverified"]);
    expect(music.calls.map(([title]) => title)).toEqual(["Bonus Track", "Not Anywhere"]);
    expect(music.trackLookups).toHaveLength(1);
  });

  it("is never looser than the per-track check: a containment match falls back", async () => {
    // "Love" is contained in "Love of My Life"; the per-track search finds nothing.
    const music = new AlbumMusicProvider({});
    const tracks = await runAlbum(["Death on Two Legs", "Love"], music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(["verified", "unverified"]);
    expect(music.calls.map(([title]) => title)).toEqual(["Love"]);
  });

  it("falls back when the album track has another artist", async () => {
    const guest = albumTracks.map((t, i) => (i === 0 ? { ...t, artist: { ...artist, id: "x", name: "Someone Else" } } : t));
    const music = new AlbumMusicProvider({}, [opera], { "r-1": guest });
    const tracks = await runAlbum(["Death on Two Legs", "Love of My Life"], music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(["unverified", "verified"]);
    expect(music.calls.map(([title]) => title)).toEqual(["Death on Two Legs"]);
  });

  it("falls back to per-track searches when no release matches the tags", async () => {
    const other = createAlbum({ id: "r-9", title: "A Night at the Opera (Live)", artist, year: 1975 });
    const music = new AlbumMusicProvider({ "Death on Two Legs": [albumTracks[0]!] }, [other]);
    const tracks = await runAlbum(["Death on Two Legs", "Love of My Life"], music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(["verified", "unverified"]);
    expect(music.trackLookups).toEqual([]);
    expect(music.calls.map(([title]) => title)).toEqual(["Death on Two Legs", "Love of My Life"]);
  });

  it("keeps the tags, unverified, when the album lookup fails", async () => {
    for (const music of [
      new AlbumMusicProvider({}, new ProviderError("down")),
      new AlbumMusicProvider({}, [opera], {}), // the track lookup fails
    ]) {
      const tracks = await runAlbum(["Death on Two Legs", "Love of My Life"], music);
      expect(tracks.map((t) => [t.title, t.verificationStatus])).toEqual([
        ["Death on Two Legs", "unverified"],
        ["Love of My Life", "unverified"],
      ]);
      expect(music.calls).toEqual([]);
    }
  });

  it("uses the per-track search for a single file of an album", async () => {
    const music = new AlbumMusicProvider({ "Death on Two Legs": [albumTracks[0]!] });
    const tracks = await runAlbum(["Death on Two Legs"], music);
    expect(tracks[0]!.verificationStatus).toBe("verified");
    expect(music.releaseSearches).toEqual([]);
    expect(music.calls).toHaveLength(1);
  });

  it("uses per-track searches with a provider that cannot list release tracks", async () => {
    const music = new FakeMusicProvider({ "Death on Two Legs": [albumTracks[0]!], "Love of My Life": [albumTracks[2]!] });
    const tracks = await runAlbum(["Death on Two Legs", "Love of My Life"], music);
    expect(tracks.map((t) => t.verificationStatus)).toEqual(["verified", "verified"]);
    expect(music.calls).toHaveLength(2);
  });

  it("groups by artist and album tags, across folders", async () => {
    const music = new AlbumMusicProvider({});
    const tags = {
      ...albumTags(["Death on Two Legs"]),
      "02.mp3": { title: "Love of My Life", artist: "QUEEN", album: "a night at the opera", year: 1975, trackNumber: 3 },
    };
    const files = [await touch(dir, "one/01.mp3"), await touch(dir, "two/02.mp3")];
    const ops = await service({ musicProvider: music, musicParser: new FakeMusicParser(tags) }).processFiles(files);
    expect(ops.map((op) => op.mediaFile.matchedMetadata?.verificationStatus)).toEqual(["verified", "verified"]);
    expect(music.releaseSearches).toHaveLength(1);
  });
});
