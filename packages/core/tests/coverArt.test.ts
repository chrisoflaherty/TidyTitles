import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoverArtDownloader } from "../src/coverArt";
import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createParsedInfo,
  createRenameOperation,
  createTrack,
  createTVShow,
  type MatchedMetadata,
  type RenameOperation,
} from "../src/models";
import type { FetchFn } from "../src/providers/base";

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-art-"));
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

function image(contentType = "image/jpeg", body = "IMG", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

/** A fetch mock that answers every request with `respond(url)`. */
function mockFetch(respond: (url: string) => Response | Promise<Response> = () => image()) {
  return vi.fn<FetchFn>(async (input) => respond(String(input)));
}

const movie = createMovie({
  id: 603,
  title: "The Matrix",
  originalTitle: "The Matrix",
  year: 1999,
  posterPath: "/matrix.jpg",
});
const show = createTVShow({
  id: 1396,
  title: "Breaking Bad",
  originalTitle: "Breaking Bad",
  year: 2008,
  posterPath: "/bb.jpg",
});
const episode = createEpisode({ show, season: 1, episode: 1, title: "Pilot" });
const artist = createArtist({ id: "artist-id", name: "Artist" });
const mbAlbum = createAlbum({ id: "release-id", title: "Album", artist });

describe("CoverArtDownloader", () => {
  it("downloads a movie poster at the configured size", async () => {
    const fetch = mockFetch();
    const art = new CoverArtDownloader({ fetch, size: "w342" });
    const result = await art.downloadForMovie(movie, tmpdir);
    expect(fetch).toHaveBeenCalledWith(
      "https://image.tmdb.org/t/p/w342/matrix.jpg",
      expect.objectContaining({ redirect: "follow" }),
    );
    expect(result).toBe(path.join(tmpdir, "poster.jpg"));
    expect(await readFile(result!, "utf8")).toBe("IMG");
  });

  it("defaults to w500 and poster.jpg", async () => {
    const fetch = mockFetch();
    await new CoverArtDownloader({ fetch }).downloadForMovie(movie, tmpdir);
    expect(fetch.mock.calls[0]![0]).toBe("https://image.tmdb.org/t/p/w500/matrix.jpg");
  });

  it("returns undefined without a poster path", async () => {
    const fetch = mockFetch();
    const art = new CoverArtDownloader({ fetch });
    const noPoster = { ...movie, posterPath: undefined };
    expect(await art.downloadForMovie(noPoster, tmpdir)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the show poster for episodes", async () => {
    const fetch = mockFetch();
    const result = await new CoverArtDownloader({ fetch, filename: "folder.jpg" })
      .downloadForEpisode(episode, tmpdir);
    expect(fetch.mock.calls[0]![0]).toBe("https://image.tmdb.org/t/p/w500/bb.jpg");
    expect(result).toBe(path.join(tmpdir, "folder.jpg"));
  });

  it("prefers the album's cover art URL", async () => {
    const fetch = mockFetch();
    const album = { ...mbAlbum, coverArtUrl: "https://example.test/cover.jpg" };
    const result = await new CoverArtDownloader({ fetch }).downloadForAlbum(album, tmpdir);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["https://example.test/cover.jpg"]);
    expect(result).toBe(path.join(tmpdir, "cover.jpg"));
  });

  it("falls back to the Cover Art Archive for MusicBrainz releases", async () => {
    const fetch = mockFetch((url) =>
      url.includes("example.test") ? image("image/jpeg", "", 404) : image(),
    );
    const album = { ...mbAlbum, coverArtUrl: "https://example.test/missing.jpg" };
    const result = await new CoverArtDownloader({ fetch, musicFilename: "folder.jpg" })
      .downloadForAlbum(album, tmpdir);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://example.test/missing.jpg",
      "https://coverartarchive.org/release/release-id/front",
    ]);
    expect(result).toBe(path.join(tmpdir, "folder.jpg"));
  });

  it("does not use the Cover Art Archive for local albums", async () => {
    const fetch = mockFetch();
    const local = createAlbum({ id: "local", title: "Album", artist, provider: "local" });
    expect(await new CoverArtDownloader({ fetch }).downloadForAlbum(local, tmpdir)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns undefined for tracks without an album", async () => {
    const fetch = mockFetch();
    const track = createTrack({ id: "t", title: "Song", artist });
    expect(await new CoverArtDownloader({ fetch }).downloadForTrack(track, tmpdir)).toBeUndefined();
  });

  it("adjusts the extension to the content type", async () => {
    const png = await new CoverArtDownloader({ fetch: mockFetch(() => image("image/png")) })
      .downloadForMovie(movie, path.join(tmpdir, "a"));
    expect(png).toBe(path.join(tmpdir, "a", "poster.png"));
    expect(existsSync(png!)).toBe(true);

    const webp = await new CoverArtDownloader({ fetch: mockFetch(() => image("image/webp")) })
      .downloadForMovie(movie, path.join(tmpdir, "b"));
    expect(webp).toBe(path.join(tmpdir, "b", "poster.webp"));

    const unknown = await new CoverArtDownloader({
      fetch: mockFetch(() => image("application/octet-stream")),
      filename: "poster.jpeg",
    }).downloadForMovie(movie, path.join(tmpdir, "c"));
    expect(unknown).toBe(path.join(tmpdir, "c", "poster.jpg"));
  });

  it("keeps existing art unless overwrite is on", async () => {
    const existing = path.join(tmpdir, "poster.jpg");
    await writeFile(existing, "OLD");

    const fetch = mockFetch(() => image("image/jpeg", "NEW"));
    expect(await new CoverArtDownloader({ fetch }).downloadForMovie(movie, tmpdir)).toBe(existing);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(existing, "utf8")).toBe("OLD");

    await new CoverArtDownloader({ fetch, overwrite: true }).downloadForMovie(movie, tmpdir);
    expect(await readFile(existing, "utf8")).toBe("NEW");
  });

  it("returns undefined on HTTP errors and network failures", async () => {
    const notFound = new CoverArtDownloader({ fetch: mockFetch(() => image("image/jpeg", "", 404)) });
    expect(await notFound.downloadForMovie(movie, tmpdir)).toBeUndefined();

    const failing = new CoverArtDownloader({
      fetch: vi.fn<FetchFn>(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(await failing.downloadForMovie(movie, tmpdir)).toBeUndefined();
    expect(existsSync(path.join(tmpdir, "poster.jpg"))).toBe(false);
  });

  it("dispatches on the metadata kind", async () => {
    const fetch = mockFetch();
    const art = new CoverArtDownloader({ fetch });
    const track = createTrack({ id: "t", title: "Song", artist, album: mbAlbum });
    const items: MatchedMetadata[] = [movie, episode, track];
    for (const [i, item] of items.entries()) {
      await art.downloadForMetadata(item, path.join(tmpdir, String(i)));
    }
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://image.tmdb.org/t/p/w500/matrix.jpg",
      "https://image.tmdb.org/t/p/w500/bb.jpg",
      "https://coverartarchive.org/release/release-id/front",
    ]);
  });
});

describe("CoverArtDownloader.downloadForOperations", () => {
  function op(
    destination: string,
    metadata: MatchedMetadata | undefined,
    status: RenameOperation["status"] = "completed",
  ): RenameOperation {
    return createRenameOperation({
      source: path.join(tmpdir, "src.mkv"),
      destination,
      status,
      mediaFile: {
        path: path.join(tmpdir, "src.mkv"),
        parsedInfo: createParsedInfo({ title: "x" }),
        matchedMetadata: metadata,
      },
    });
  }

  it("downloads into each destination directory, once per directory", async () => {
    const fetch = mockFetch();
    const season = path.join(tmpdir, "Breaking Bad", "Season 1");
    const ops = [
      op(path.join(season, "E01.mkv"), episode),
      op(path.join(season, "E02.mkv"), { ...episode, episode: 2 }),
      op(path.join(tmpdir, "Movies", "The Matrix (1999).mkv"), movie),
      op(path.join(tmpdir, "Skipped.mkv"), movie, "skipped"),
      op(path.join(tmpdir, "NoMeta", "x.mkv"), undefined),
    ];
    const progress: string[] = [];

    const downloaded = await new CoverArtDownloader({ fetch }).downloadForOperations(
      ops,
      (c, t, m) => progress.push(`${c}/${t} ${m}`),
    );

    // The second episode finds the poster already there (overwrite is off).
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(downloaded).toEqual([
      path.join(season, "poster.jpg"),
      path.join(season, "poster.jpg"),
      path.join(tmpdir, "Movies", "poster.jpg"),
    ]);
    expect(progress).toEqual([
      "1/4 Downloading art: E01.mkv",
      "2/4 Downloading art: E02.mkv",
      "3/4 Downloading art: The Matrix (1999).mkv",
      "4/4 Downloading art: x.mkv",
    ]);
    expect(existsSync(path.join(tmpdir, "Skipped.mkv"))).toBe(false);
  });
});
