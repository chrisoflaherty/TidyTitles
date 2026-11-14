/** Fake providers, parsers, and fixtures for the rename service and session tests. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createParsedMusicInfo,
  createTrack,
  createTVShow,
  type Album,
  type Episode,
  type Movie,
  type ParsedMusicInfo,
  type Track,
  type TVShow,
} from "../src/models";
import type { MusicParser } from "../src/musicParser";
import type { MovieProvider, MusicProvider, TVProvider } from "../src/providers/base";

// Fixtures (after tests/conftest.py)
export const matrix: Movie = createMovie({
  id: 603,
  title: "The Matrix",
  originalTitle: "The Matrix",
  year: 1999,
  releaseDate: "1999-03-31",
  genres: ["Action", "Science Fiction"],
  posterPath: "/matrix.jpg",
});
export const matrixReloaded: Movie = createMovie({
  id: 604,
  title: "The Matrix Reloaded",
  originalTitle: "The Matrix Reloaded",
  year: 2003,
});
export const breakingBad: TVShow = createTVShow({
  id: 1396,
  title: "Breaking Bad",
  originalTitle: "Breaking Bad",
  year: 2008,
});
export const breakingBadRemake: TVShow = createTVShow({
  id: 9999,
  title: "Breaking Bad (Remake)",
  originalTitle: "Breaking Bad",
  year: 2030,
});
export function pilot(show: TVShow = breakingBad): Episode {
  return createEpisode({ show, season: 1, episode: 1, title: "Pilot" });
}

const queen = createArtist({ id: "q-1", name: "Queen" });
const opera: Album = createAlbum({ id: "r-1", title: "A Night at the Opera", artist: queen, year: 1975 });
export const bohemian: Track = createTrack({
  id: "rec-1",
  title: "Bohemian Rhapsody",
  artist: queen,
  album: opera,
  trackNumber: 11,
});
export const bohemianLive: Track = createTrack({
  id: "rec-2",
  title: "Bohemian Rhapsody (Live)",
  artist: queen,
  album: createAlbum({ id: "r-2", title: "Live Killers", artist: queen, year: 1979 }),
});

type Result<T> = T | Error | ((...args: never[]) => T | Promise<T>);

async function resolve<T>(value: Result<T>, args: unknown[]): Promise<T> {
  if (value instanceof Error) throw value;
  if (typeof value === "function") return (value as (...a: unknown[]) => T)(...args);
  return value;
}

/** Movie provider returning canned results per title (Error values are thrown). */
export class FakeMovieProvider implements MovieProvider {
  calls: Array<[string, number | undefined]> = [];
  constructor(private results: Record<string, Result<Movie[]>> = {}) {}
  async searchMovie(title: string, year?: number): Promise<Movie[]> {
    this.calls.push([title, year]);
    return resolve(this.results[title] ?? [], [title, year]);
  }
  async getMovie(): Promise<Movie | undefined> {
    return undefined;
  }
}

/** TV provider returning canned shows per title and episodes per show id. */
export class FakeTVProvider implements TVProvider {
  searchCalls: string[] = [];
  episodeCalls: Array<[number, number, number]> = [];
  constructor(
    private shows: Record<string, Result<TVShow[]>> = {},
    private episodes: Record<number, Episode> = {},
  ) {}
  async searchShow(title: string): Promise<TVShow[]> {
    this.searchCalls.push(title);
    return resolve(this.shows[title] ?? [], [title]);
  }
  async getShow(): Promise<TVShow | undefined> {
    return undefined;
  }
  async getEpisode(showId: number, season: number, episode: number): Promise<Episode | undefined> {
    this.episodeCalls.push([showId, season, episode]);
    return this.episodes[showId];
  }
}

/** Music provider returning canned recordings per title. */
export class FakeMusicProvider implements MusicProvider {
  calls: Array<[string, string | undefined, string | undefined]> = [];
  constructor(private recordings: Record<string, Result<Track[]>> = {}) {}
  async searchRecording(title: string, artist?: string, album?: string): Promise<Track[]> {
    this.calls.push([title, artist, album]);
    return resolve(this.recordings[title] ?? [], [title]);
  }
  async searchRelease(): Promise<Album[]> {
    return [];
  }
  async getRecording(): Promise<Track | undefined> {
    return undefined;
  }
  async getRelease(): Promise<Album | undefined> {
    return undefined;
  }
}

/** Music parser returning canned tags per filename. */
export class FakeMusicParser implements MusicParser {
  constructor(private tags: Record<string, Partial<ParsedMusicInfo>> = {}) {}
  canRead(): boolean {
    return true;
  }
  async parse(filePath: string): Promise<ParsedMusicInfo> {
    const name = path.basename(filePath);
    return createParsedMusicInfo({ rawFilename: name, source: "tags", ...this.tags[name] });
  }
}

/** Complete tags for Bohemian Rhapsody. */
export const completeTags: Partial<ParsedMusicInfo> = {
  title: "Bohemian Rhapsody",
  artist: "Queen",
  album: "A Night at the Opera",
  year: 1975,
  trackNumber: 11,
};

/** Create a file (and its directory) under `dir`. */
export async function touch(dir: string, name: string, content = name): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}
