/** TMDB API client for movie (and TV) metadata. */

import { AuthenticationError, ProviderError, RateLimitError } from "../errors";
import {
  createEpisode,
  createMovie,
  createTVShow,
  type Episode,
  type Movie,
  type TVShow,
} from "../models";
import type { FetchFn, MovieProvider, TVProvider } from "./base";
import {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  isoDateYear,
  optionalArray,
  optionalNumber,
  optionalString,
  parseIsoDate,
  readJson,
  requireNumber,
  requireObject,
  requireString,
  sendRequest,
  yearPrefix,
  type JsonObject,
  type QueryParams,
  type ResponseCache,
} from "./util";

const LABEL = "TMDB";

export interface TMDBClientOptions {
  /**
   * TMDB API key (v3) or API read access token (v4 bearer token). Keys longer
   * than 50 characters are sent as `Authorization: Bearer`; shorter keys are
   * sent as the `api_key` query parameter.
   */
  apiKey: string;
  /** Optional response cache. */
  cache?: ResponseCache;
  /** Language for API responses (default "en-US"). */
  language?: string;
  /** Fetch implementation (default `globalThis.fetch`). */
  fetch?: FetchFn;
  /** Per-request timeout in milliseconds (default 30,000). */
  timeoutMs?: number;
}

/** Client for The Movie Database (TMDB) API. */
export class TMDBClient implements MovieProvider, TVProvider {
  static readonly BASE_URL = "https://api.themoviedb.org/3";
  static readonly PROVIDER_NAME = "tmdb";

  private readonly apiKey: string;
  private readonly cache?: ResponseCache;
  private readonly language: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  /** True when the key is a v4 bearer token (those are 200+ characters). */
  readonly usesBearerToken: boolean;

  constructor(options: TMDBClientOptions) {
    this.apiKey = options.apiKey;
    this.cache = options.cache;
    this.language = options.language ?? "en-US";
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.usesBearerToken = options.apiKey.length > 50;
  }

  /** Make an API request with caching and error handling. */
  private async request(endpoint: string, params: QueryParams = {}): Promise<JsonObject> {
    const query: QueryParams = { ...params, language: this.language };
    if (!this.usesBearerToken) query.api_key = this.apiKey;

    const cached = this.cache?.get(TMDBClient.PROVIDER_NAME, endpoint, query);
    if (cached !== undefined && cached !== null) {
      return requireObject(cached, LABEL, "cached response");
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.usesBearerToken) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await sendRequest(
      this.fetchFn,
      buildUrl(TMDBClient.BASE_URL, endpoint, query),
      { method: "GET", headers },
      LABEL,
      this.timeoutMs,
    );

    if (response.status === 401) throw new AuthenticationError("Invalid TMDB API key");
    if (response.status === 429) throw new RateLimitError("TMDB rate limit exceeded");
    if (response.status >= 400) throw new ProviderError(`TMDB API error: ${response.status}`);

    const data = requireObject(await readJson(response, LABEL), LABEL, "response");
    this.cache?.set(TMDBClient.PROVIDER_NAME, endpoint, query, data);
    return data;
  }

  /** Search for movies by title, optionally narrowed by release year. */
  async searchMovie(title: string, year?: number): Promise<Movie[]> {
    const params: QueryParams = { query: title };
    if (year) params.year = year;

    const data = await this.request("/search/movie", params);
    return optionalArray(data.results, LABEL, "results").map((raw) =>
      parseMovie(requireObject(raw, LABEL, "search result"), false),
    );
  }

  /** Get movie details by ID, or `undefined` if the request fails. */
  async getMovie(movieId: number): Promise<Movie | undefined> {
    let data: JsonObject;
    try {
      data = await this.request(`/movie/${movieId}`);
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }
    return parseMovie(data, true);
  }

  /** Search for TV shows by title, optionally narrowed by first-air year. */
  async searchShow(title: string, year?: number): Promise<TVShow[]> {
    const params: QueryParams = { query: title };
    if (year) params.first_air_date_year = year;

    const data = await this.request("/search/tv", params);
    return optionalArray(data.results, LABEL, "results").map((raw) => {
      const item = requireObject(raw, LABEL, "search result");
      const name = requireString(item, "name", LABEL);
      return createTVShow({
        id: requireNumber(item, "id", LABEL),
        title: name,
        originalTitle: optionalString(item.original_name) ?? name,
        year: firstAirYear(item.first_air_date),
        genres: [],
        posterPath: optionalString(item.poster_path),
        provider: TMDBClient.PROVIDER_NAME,
      });
    });
  }

  /** Get TV show details by ID, or `undefined` if the request fails. */
  async getShow(showId: number): Promise<TVShow | undefined> {
    let data: JsonObject;
    try {
      data = await this.request(`/tv/${showId}`);
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }

    const name = requireString(data, "name", LABEL);
    const networks = optionalArray(data.networks, LABEL, "networks");
    const network =
      networks.length > 0
        ? requireString(requireObject(networks[0], LABEL, "network"), "name", LABEL)
        : undefined;

    return createTVShow({
      id: requireNumber(data, "id", LABEL),
      title: name,
      originalTitle: optionalString(data.original_name) ?? name,
      year: firstAirYear(data.first_air_date),
      network,
      status: optionalString(data.status),
      genres: parseGenres(data.genres),
      posterPath: optionalString(data.poster_path),
      provider: TMDBClient.PROVIDER_NAME,
    });
  }

  /**
   * Get episode details. Fetches the show first; returns `undefined` if
   * either the show or the episode request fails.
   */
  async getEpisode(
    showId: number,
    season: number,
    episode: number,
  ): Promise<Episode | undefined> {
    const show = await this.getShow(showId);
    if (!show) return undefined;

    let data: JsonObject;
    try {
      data = await this.request(`/tv/${showId}/season/${season}/episode/${episode}`);
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }

    return createEpisode({
      show,
      season: optionalNumber(data.season_number) ?? season,
      episode: optionalNumber(data.episode_number) ?? episode,
      title: optionalString(data.name) ?? "",
      airDate: parseIsoDate(data.air_date),
      overview: optionalString(data.overview),
    });
  }
}

/** Parse a TMDB movie object. Search results carry no genre names. */
function parseMovie(item: JsonObject, withGenres: boolean): Movie {
  const title = requireString(item, "title", LABEL);
  const releaseDate = parseIsoDate(item.release_date);
  return createMovie({
    id: requireNumber(item, "id", LABEL),
    title,
    originalTitle: optionalString(item.original_title) ?? title,
    year: releaseDate ? isoDateYear(releaseDate) : 0,
    releaseDate,
    overview: optionalString(item.overview),
    genres: withGenres ? parseGenres(item.genres) : [],
    posterPath: optionalString(item.poster_path),
    provider: TMDBClient.PROVIDER_NAME,
  });
}

function parseGenres(value: unknown): string[] {
  return optionalArray(value, LABEL, "genres").map((g) =>
    requireString(requireObject(g, LABEL, "genre"), "name", LABEL),
  );
}

/** Year from the first four characters of `first_air_date`, or 0. */
function firstAirYear(value: unknown): number {
  if (!value) return 0;
  return yearPrefix(value) ?? 0;
}
