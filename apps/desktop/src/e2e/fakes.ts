/**
 * Fake metadata for the end-to-end test build and the controller tests.
 *
 * TEST CODE ONLY. Imported by `src/e2e/main.ts` (built into `out-e2e/`
 * with `--mode e2e`) and by unit tests; nothing under `src/main` imports it,
 * so the shipped app (`out/`) does not contain it. `scripts/check-build.mjs`
 * fails the production build if this marker ever appears there.
 */

import path from "node:path";
import {
  ProviderError,
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createParsedMusicInfo,
  createTVShow,
  createTrack,
  type Album,
  type Episode,
  type FetchFn,
  type Movie,
  type MovieProvider,
  type MusicParser,
  type MusicProvider,
  type ParsedMusicInfo,
  type Track,
  type TVProvider,
  type TVShow,
} from "@tidytitles/core";
import type { SessionOverrides } from "../main/controller";

export const E2E_FAKE_MARKER = "TIDYTITLES_E2E_FAKE_PROVIDERS";

const key = (s: string) => s.trim().toLowerCase();

export const MOVIES: Record<string, Movie[]> = {
  "the matrix": [
    createMovie({ id: 603, title: "The Matrix", originalTitle: "The Matrix", year: 1999, releaseDate: "1999-03-31", posterPath: "/matrix.jpg", overview: "A computer hacker learns about the true nature of reality." }),
    createMovie({ id: 55931, title: "The Matrix Revisited", originalTitle: "The Matrix Revisited", year: 2001, releaseDate: "2001-11-19" }),
    createMovie({ id: 624860, title: "The Matrix Resurrections", originalTitle: "The Matrix Resurrections", year: 2021, releaseDate: "2021-12-16" }),
  ],
  inception: [
    createMovie({ id: 27205, title: "Inception", originalTitle: "Inception", year: 2010, releaseDate: "2010-07-15", posterPath: "/inception.jpg" }),
  ],
};

const breakingBad: TVShow = createTVShow({ id: 81189, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008, network: "AMC", posterPath: "/bb.jpg" });
export const SHOWS: Record<string, TVShow[] | Error> = {
  "breaking bad": [breakingBad],
  "broken show": new ProviderError("TVDB API error: 503 Service Unavailable"),
};
export const EPISODES: Record<number, Episode> = {
  81189: createEpisode({ show: breakingBad, season: 1, episode: 1, title: "Pilot", airDate: "2008-01-20" }),
};

/** Episodes by show, season, and number; other numbers fall back to `EPISODES`. */
export const EPISODES_BY_NUMBER: Record<string, Episode> = {
  "81189:1:1": EPISODES[81189]!,
  "81189:1:2": createEpisode({ show: breakingBad, season: 1, episode: 2, title: "Cat's in the Bag...", airDate: "2008-01-27" }),
};

const queen = createArtist({ id: "0383dadf-2a4e-4d10-a46a-e9e041da8eb3", name: "Queen" });
const opera: Album = createAlbum({ id: "r-opera", title: "A Night at the Opera", artist: queen, year: 1975 });
const daftPunk = createArtist({ id: "056e4f3e-d505-4dad-8ec1-d04f521cbb56", name: "Daft Punk" });
const discovery: Album = createAlbum({ id: "r-discovery", title: "Discovery", artist: daftPunk, year: 2001 });

export const RECORDINGS: Record<string, Track[]> = {
  "bohemian rhapsody": [createTrack({ id: "rec-bohemian", title: "Bohemian Rhapsody", artist: queen, album: opera, trackNumber: 11 })],
  "one more time": [createTrack({ id: "rec-omt", title: "One More Time", artist: daftPunk, album: discovery, trackNumber: 1 })],
};

/** Tags for the e2e music files (empty files on disk have none). */
export const MUSIC_TAGS: Record<string, Partial<ParsedMusicInfo>> = {
  "queen - bohemian rhapsody.mp3": { title: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera", year: 1975, trackNumber: 11 },
  "03 - basement tapes - demo.mp3": { title: "Demo", artist: "Basement Tapes", album: "Garage Sessions", year: 2019, trackNumber: 3 },
  "daft punk - one more time.flac": { title: "One More Time", artist: "Daft Punk" },
};

export class FakeMovieProvider implements MovieProvider {
  async searchMovie(title: string): Promise<Movie[]> {
    return MOVIES[key(title)] ?? [];
  }
  async getMovie(): Promise<undefined> {
    return undefined;
  }
}

export class FakeTVProvider implements TVProvider {
  async searchShow(title: string): Promise<TVShow[]> {
    const result = SHOWS[key(title)];
    if (result instanceof Error) throw result;
    return result ?? [];
  }
  async getShow(): Promise<undefined> {
    return undefined;
  }
  async getEpisode(showId: number, season?: number, episode?: number): Promise<Episode | undefined> {
    return EPISODES_BY_NUMBER[`${showId}:${season}:${episode}`] ?? EPISODES[showId];
  }
}

export class FakeMusicProvider implements MusicProvider {
  async searchRecording(title: string): Promise<Track[]> {
    return RECORDINGS[key(title)] ?? [];
  }
  async searchRelease(): Promise<Album[]> {
    return [];
  }
  async getRecording(): Promise<undefined> {
    return undefined;
  }
  async getRelease(): Promise<undefined> {
    return undefined;
  }
}

export class FakeMusicParser implements MusicParser {
  canRead(): boolean {
    return true;
  }
  async parse(filePath: string): Promise<ParsedMusicInfo> {
    const name = path.basename(filePath);
    return createParsedMusicInfo({ rawFilename: name, source: "tags", ...MUSIC_TAGS[key(name)] });
  }
}

/** A 1x1 JPEG, served for cover-art image URLs. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/** No network in the e2e build: image URLs get a tiny JPEG, everything else fails. */
export const fakeFetch: FetchFn = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (host === "image.tmdb.org" || host === "coverartarchive.org") {
    return new Response(TINY_JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  throw new Error(`${E2E_FAKE_MARKER}: network access is disabled (${host})`);
};

export function createFakeSessionOverrides(): SessionOverrides {
  return {
    providers: {
      movieProvider: new FakeMovieProvider(),
      tvProvider: new FakeTVProvider(),
      musicProvider: new FakeMusicProvider(),
    },
    musicParser: new FakeMusicParser(),
    fetch: fakeFetch,
  };
}
