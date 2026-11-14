/** Provider interfaces for metadata APIs. */

import type { Album, Episode, Movie, Track, TVShow } from "../models";

/**
 * The fetch implementation providers use for HTTP. Every provider accepts one
 * through its constructor options (defaulting to `globalThis.fetch`) so tests
 * can supply a mock.
 */
export type FetchFn = typeof globalThis.fetch;

/** Movie metadata provider. */
export interface MovieProvider {
  /** Search for movies by title and optional year. */
  searchMovie(title: string, year?: number): Promise<Movie[]>;
  /** Get movie details by ID. */
  getMovie(movieId: number): Promise<Movie | undefined>;
}

/** TV show metadata provider. */
export interface TVProvider {
  /** Search for TV shows by title and optional year. */
  searchShow(title: string, year?: number): Promise<TVShow[]>;
  /** Get TV show details by ID. */
  getShow(showId: number): Promise<TVShow | undefined>;
  /** Get episode details. */
  getEpisode(
    showId: number,
    season: number,
    episode: number,
  ): Promise<Episode | undefined>;
}

/** Music metadata provider. */
export interface MusicProvider {
  /** Search for recordings (tracks) by title and optional artist/album. */
  searchRecording(
    title: string,
    artist?: string,
    album?: string,
  ): Promise<Track[]>;
  /** Search for releases (albums) by title and optional artist. */
  searchRelease(album: string, artist?: string): Promise<Album[]>;
  /** Get recording details by MusicBrainz ID. */
  getRecording(recordingId: string): Promise<Track | undefined>;
  /** Get release details by MusicBrainz ID. */
  getRelease(releaseId: string): Promise<Album | undefined>;
}
