/** TMDB API client for movie (and TV) metadata. */

import { DEFAULT_EPISODE_ORDER, type EpisodeOrder } from "../episodeOrder";
import {
  AuthenticationError,
  EpisodeOrderUnavailableError,
  ProviderError,
  RateLimitError,
} from "../errors";
import { DEFAULT_METADATA_LANGUAGE, isEnglish } from "../languages";
import {
  createEpisode,
  createMovie,
  createTVShow,
  type Episode,
  type Movie,
  type TVShow,
} from "../models";
import type { FetchFn, MovieProvider, TVProvider } from "./base";
import { RunMemo } from "./memo";
import {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  isoDateYear,
  isRecord,
  optionalArray,
  optionalNumber,
  optionalString,
  parseIsoDate,
  InflightRequests,
  readJson,
  requestKey,
  requireNumber,
  requireObject,
  requireString,
  sendRequest,
  sendWithRateLimitRetry,
  yearPrefix,
  type JsonObject,
  type QueryParams,
  type RateLimitRetryOptions,
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
  /** Retries for HTTP 429 (default: 2 retries, honoring `Retry-After` up to 10 s). */
  rateLimitRetry?: RateLimitRetryOptions;
  /**
   * Episode order for season/episode numbers (default "aired"). DVD order
   * needs a DVD episode group on the show; absolute order counts the aired
   * episodes.
   */
  episodeOrder?: EpisodeOrder;
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
  private readonly rateLimitRetry: RateLimitRetryOptions;
  private readonly inflight = new InflightRequests<JsonObject>();
  /** Seasons, show details, episode groups, and English fallbacks, once per client (one run). */
  private readonly memo = new RunMemo();
  readonly episodeOrder: EpisodeOrder;
  /** True when the key is a v4 bearer token (those are 200+ characters). */
  readonly usesBearerToken: boolean;

  constructor(options: TMDBClientOptions) {
    this.apiKey = options.apiKey;
    this.cache = options.cache;
    this.language = options.language ?? DEFAULT_METADATA_LANGUAGE;
    this.episodeOrder = options.episodeOrder ?? DEFAULT_EPISODE_ORDER;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitRetry = options.rateLimitRetry ?? {};
    this.usesBearerToken = options.apiKey.length > 50;
  }

  /** Make an API request with caching and error handling. */
  private async request(
    endpoint: string,
    params: QueryParams = {},
    language: string = this.language,
  ): Promise<JsonObject> {
    const query: QueryParams = { ...params, language };
    if (!this.usesBearerToken) query.api_key = this.apiKey;

    const cached = this.cache?.get(TMDBClient.PROVIDER_NAME, endpoint, query);
    if (cached !== undefined && cached !== null) {
      return requireObject(cached, LABEL, "cached response");
    }

    // Identical requests in flight at the same time share one network call.
    return this.inflight.run(requestKey(endpoint, query), () => this.fetchJson(endpoint, query));
  }

  private async fetchJson(endpoint: string, query: QueryParams): Promise<JsonObject> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.usesBearerToken) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await sendWithRateLimitRetry(
      () =>
        sendRequest(
          this.fetchFn,
          buildUrl(TMDBClient.BASE_URL, endpoint, query),
          { method: "GET", headers },
          LABEL,
          this.timeoutMs,
        ),
      this.rateLimitRetry,
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
    const items = optionalArray(data.results, LABEL, "results").map((raw) =>
      requireObject(raw, LABEL, "search result"),
    );
    // Validate before any fallback request, so a malformed page fails as before.
    items.forEach((item) => parseMovie(item, false));
    const named = await this.withEnglishNames("/search/movie", params, items, "title", "original_title");
    return named.map((item) => parseMovie(item, false));
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
    const items = optionalArray(data.results, LABEL, "results").map((raw) => {
      const item = requireObject(raw, LABEL, "search result");
      requireString(item, "name", LABEL);
      requireNumber(item, "id", LABEL);
      return item;
    });
    const named = await this.withEnglishNames("/search/tv", params, items, "name", "original_name");
    return named.map((item) => {
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
    const localized = await this.showDetails(showId, this.language);
    if (!localized) return undefined;
    requireString(localized, "name", LABEL);
    const data = (await this.withEnglishNames(`/tv/${showId}`, {}, [localized], "name", "original_name"))[0]!;

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
   * Get episode details in the configured order. Fetches the show, then
   * the season (once per run, shared by its episodes), and picks the
   * episode. Returns `undefined` if the show or season request fails or the
   * season has no such episode.
   *
   * DVD order maps the numbers through the show's DVD episode group;
   * absolute order reads the episode number as the absolute number (season
   * 0 keeps aired numbers). Titles always come from the aired season, in
   * the metadata language.
   *
   * @throws EpisodeOrderUnavailableError in DVD order when the show has no
   *   DVD episode group.
   */
  async getEpisode(
    showId: number,
    season: number,
    episode: number,
  ): Promise<Episode | undefined> {
    const show = await this.getShow(showId);
    if (!show) return undefined;

    if (this.episodeOrder === "aired" || (season === 0 && this.episodeOrder === "absolute")) {
      return this.airedEpisode(show, season, episode);
    }
    if (this.episodeOrder === "absolute") return this.absoluteEpisode(show, episode);

    const dvd = await this.requireDvdGroup(show);
    const entry = dvd.find((e) => e.season === season && e.episode === episode);
    if (!entry) return season === 0 ? this.airedEpisode(show, 0, episode) : undefined;
    const aired = await this.airedEpisode(show, entry.airedSeason, entry.airedEpisode);
    return aired && { ...aired, season, episode };
  }

  /**
   * The episode that aired on `airDate` ("YYYY-MM-DD"), with its aired
   * numbers. TMDB has no search by air date: the show's seasons that started
   * on or before the date are checked, latest first (at most three, then
   * the specials), each fetched once per run.
   */
  async getEpisodeByAirDate(showId: number, airDate: string): Promise<Episode | undefined> {
    const show = await this.getShow(showId);
    if (!show) return undefined;
    const details = await this.showDetails(showId, this.language);
    if (!details) return undefined;

    const seasons = optionalArray(details.seasons, LABEL, "seasons")
      .filter(isRecord)
      .map((s) => ({ number: optionalNumber(s.season_number), start: parseIsoDate(s.air_date) }))
      .filter((s): s is { number: number; start: string | undefined } => s.number !== undefined);
    const candidates = seasons
      .filter((s) => s.number > 0 && s.start !== undefined && s.start <= airDate)
      .sort((a, b) => (a.start! < b.start! ? 1 : a.start! > b.start! ? -1 : 0))
      .slice(0, 3)
      .map((s) => s.number);
    if (seasons.some((s) => s.number === 0)) candidates.push(0);

    for (const season of candidates) {
      const data = await this.seasonData(showId, season, this.language);
      const raw = data && seasonEpisodes(data).find((ep) => parseIsoDate(ep.air_date) === airDate);
      if (raw) return this.buildEpisode(show, season, raw);
    }
    return undefined;
  }

  /** The episode with an absolute number, numbered in the configured order. */
  async getEpisodeByAbsoluteNumber(
    showId: number,
    absoluteNumber: number,
  ): Promise<Episode | undefined> {
    const show = await this.getShow(showId);
    if (!show) return undefined;
    return this.absoluteEpisode(show, absoluteNumber);
  }

  private async absoluteEpisode(show: TVShow, absoluteNumber: number): Promise<Episode | undefined> {
    const position = await this.absoluteToAired(show.id, absoluteNumber);
    if (!position) return undefined;
    const aired = await this.airedEpisode(show, position.season, position.episode);
    if (!aired) return undefined;
    const episode = { ...aired, absoluteNumber };
    if (this.episodeOrder === "aired") return episode;
    if (this.episodeOrder === "absolute") return { ...episode, season: 1, episode: absoluteNumber };
    const dvd = await this.requireDvdGroup(show);
    const entry = dvd.find((e) => e.airedSeason === aired.season && e.airedEpisode === aired.episode);
    return entry ? { ...episode, season: entry.season, episode: entry.episode } : undefined;
  }

  /**
   * Aired season and episode of an absolute number: the Nth episode of
   * seasons 1 and up, in aired order (specials do not count).
   *
   * TMDB's "Absolute" episode groups are not used. They are community lists
   * and many are something else: Detective Conan's only one is a reordered
   * Chinese release, Naruto Shippuden has nine, most of them story arcs.
   * Counting aired episodes is what an absolute number means, and it is by
   * position, because some shows keep counting across seasons (One Piece's
   * season 22 starts at episode 1089).
   */
  private async absoluteToAired(
    showId: number,
    absoluteNumber: number,
  ): Promise<{ season: number; episode: number } | undefined> {
    if (!Number.isInteger(absoluteNumber) || absoluteNumber < 1) return undefined;
    const details = await this.showDetails(showId, this.language);
    if (!details) return undefined;
    const seasons = optionalArray(details.seasons, LABEL, "seasons")
      .filter(isRecord)
      .map((s) => ({ number: optionalNumber(s.season_number), count: optionalNumber(s.episode_count) ?? 0 }))
      .filter((s): s is { number: number; count: number } => s.number !== undefined && s.number > 0)
      .sort((a, b) => a.number - b.number);
    let before = 0;
    for (const season of seasons) {
      if (absoluteNumber <= before + season.count) {
        const data = await this.seasonData(showId, season.number, this.language);
        if (!data) return undefined;
        const numbers = seasonEpisodes(data)
          .map((ep) => optionalNumber(ep.episode_number))
          .filter((n): n is number => n !== undefined)
          .sort((a, b) => a - b);
        const episode = numbers[absoluteNumber - before - 1];
        return episode === undefined ? undefined : { season: season.number, episode };
      }
      before += season.count;
    }
    return undefined;
  }

  private async requireDvdGroup(show: TVShow): Promise<GroupEntry[]> {
    const group = await this.episodeGroup(show.id, EPISODE_GROUP_DVD);
    if (!group) {
      throw new EpisodeOrderUnavailableError(
        TMDBClient.PROVIDER_NAME,
        "dvd",
        `TMDB has no DVD order for ${show.title || `show ${show.id}`} (no DVD episode group)`,
      );
    }
    return group;
  }

  /**
   * The show's episode group of a type (the one with the most episodes),
   * flattened, once per run; `undefined` when it has none. Groups are
   * numbered as seasons in their order, a group named "Specials" being
   * season 0; episodes by their order within the group.
   */
  private episodeGroup(showId: number, type: number): Promise<GroupEntry[] | undefined> {
    return this.memo.run(`group:${showId}:${type}`, async () => {
      let list: JsonObject;
      try {
        list = await this.request(`/tv/${showId}/episode_groups`);
      } catch (error) {
        if (isFatal(error) || !(error instanceof ProviderError)) throw error;
        return undefined;
      }
      const candidates = optionalArray(list.results, LABEL, "results")
        .filter(isRecord)
        .filter((g) => g.type === type && typeof g.id === "string");
      if (candidates.length === 0) return undefined;
      const best = candidates.reduce((a, b) =>
        (optionalNumber(b.episode_count) ?? 0) > (optionalNumber(a.episode_count) ?? 0) ? b : a,
      );

      const details = await this.request(`/tv/episode_group/${String(best.id)}`);
      const groups = optionalArray(details.groups, LABEL, "groups")
        .filter(isRecord)
        .sort(byOrder);
      const entries: GroupEntry[] = [];
      let season = 0;
      for (const group of groups) {
        const specials = /^specials?$/i.test((optionalString(group.name) ?? "").trim());
        if (!specials) season += 1;
        const episodes = optionalArray(group.episodes, LABEL, "episodes").filter(isRecord).sort(byOrder);
        episodes.forEach((ep, i) => {
          const airedSeason = optionalNumber(ep.season_number);
          const airedEpisode = optionalNumber(ep.episode_number);
          if (airedSeason === undefined || airedEpisode === undefined) return;
          entries.push({ season: specials ? 0 : season, episode: i + 1, airedSeason, airedEpisode });
        });
      }
      return entries;
    });
  }

  /** An episode in aired order, with its title in the metadata language. */
  private async airedEpisode(show: TVShow, season: number, episode: number): Promise<Episode | undefined> {
    const data = await this.seasonData(show.id, season, this.language);
    if (!data) return undefined;
    const raw = seasonEpisodes(data).find((ep) => ep.episode_number === episode);
    return raw ? this.buildEpisode(show, season, raw) : undefined;
  }

  private async buildEpisode(show: TVShow, season: number, raw: JsonObject): Promise<Episode> {
    const number = optionalNumber(raw.episode_number) ?? 0;
    const actualSeason = optionalNumber(raw.season_number) ?? season;
    return createEpisode({
      show,
      season: actualSeason,
      episode: number,
      title: await this.episodeTitle(show.id, actualSeason, number, raw),
      airDate: parseIsoDate(raw.air_date),
      overview: optionalString(raw.overview),
    });
  }

  /**
   * The episode's name in the metadata language; when it is missing or
   * only a placeholder ("Episode 5", "Folge 5"), the English name; then
   * whatever there is; then "Episode N".
   */
  private async episodeTitle(showId: number, season: number, number: number, raw: JsonObject): Promise<string> {
    const name = optionalString(raw.name)?.trim() ?? "";
    if (name && !isPlaceholderEpisodeName(name, number)) return name;
    let english = "";
    if (!isEnglish(this.language)) {
      const data = await this.seasonData(showId, season, ENGLISH);
      const ep = data && seasonEpisodes(data).find((e) => e.episode_number === number);
      english = (ep && optionalString(ep.name)?.trim()) ?? "";
      if (english && !isPlaceholderEpisodeName(english, number)) return english;
    }
    return name || english || `Episode ${number}`;
  }

  /** A season in a language, once per run; `undefined` when the request fails. */
  private seasonData(showId: number, season: number, language: string): Promise<JsonObject | undefined> {
    return this.memo.run(`season:${showId}:${season}:${language}`, async () => {
      try {
        return await this.request(`/tv/${showId}/season/${season}`, {}, language);
      } catch (error) {
        if (error instanceof ProviderError) return undefined;
        throw error;
      }
    });
  }

  /** Show details in a language, once per run; `undefined` when the request fails. */
  private showDetails(showId: number, language: string): Promise<JsonObject | undefined> {
    return this.memo.run(`show:${showId}:${language}`, async () => {
      try {
        return await this.request(`/tv/${showId}`, {}, language);
      } catch (error) {
        if (error instanceof ProviderError) return undefined;
        throw error;
      }
    });
  }

  /**
   * Replace untranslated names in search results with English ones. TMDB
   * answers with the original title when there is no translation; for a
   * non-English language, results whose name is empty, or is the original
   * title in another language, get the English name from the same search in
   * English (one more request, once per run). Without one, the original
   * title stays.
   */
  private async withEnglishNames(
    endpoint: string,
    params: QueryParams,
    items: JsonObject[],
    key: "title" | "name",
    originalKey: "original_title" | "original_name",
  ): Promise<JsonObject[]> {
    if (isEnglish(this.language)) return items.map((item) => withName(item, key, originalKey));
    const base = this.language.slice(0, 2);
    const needs = (item: JsonObject): boolean => {
      const name = optionalString(item[key])?.trim() ?? "";
      if (!name) return true;
      const originalLanguage = optionalString(item.original_language);
      return (
        name === optionalString(item[originalKey]) &&
        originalLanguage !== undefined &&
        originalLanguage !== base &&
        originalLanguage !== "en"
      );
    };
    if (!items.some(needs)) return items;
    const english = await this.memo.run(`english:${requestKey(endpoint, params)}`, async () => {
      const data = await this.request(endpoint, params, ENGLISH);
      const names = new Map<unknown, string>();
      for (const raw of optionalArray(data.results ?? [data], LABEL, "results")) {
        if (!isRecord(raw)) continue;
        const name = optionalString(raw[key])?.trim();
        if (name) names.set(raw.id, name);
      }
      return names;
    });
    return items.map((item) => {
      if (!needs(item)) return item;
      const name = english.get(item.id);
      return name ? { ...item, [key]: name } : withName(item, key, originalKey);
    });
  }
}

/** TMDB episode group type for DVD order (`/tv/episode_group/{id}`). */
const EPISODE_GROUP_DVD = 3;

const ENGLISH = "en-US";

/** One episode of a flattened episode group: its numbers there and in aired order. */
interface GroupEntry {
  season: number;
  episode: number;
  airedSeason: number;
  airedEpisode: number;
}

function byOrder(a: JsonObject, b: JsonObject): number {
  return (optionalNumber(a.order) ?? 0) - (optionalNumber(b.order) ?? 0);
}

function seasonEpisodes(data: JsonObject): JsonObject[] {
  return optionalArray(data.episodes, LABEL, "episodes").map((raw) => requireObject(raw, LABEL, "episode"));
}

/** An item whose empty name is replaced by its original name. */
function withName(item: JsonObject, key: string, originalKey: string): JsonObject {
  const name = optionalString(item[key])?.trim();
  if (name) return item;
  const original = optionalString(item[originalKey])?.trim();
  return original ? { ...item, [key]: original } : item;
}

/** Errors that must reach the caller even where a failed lookup reads as "not found". */
function isFatal(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof RateLimitError;
}

/** Words TMDB uses for generated episode names ("Episode 5", "Folge 5", "Épisode 5"). */
const PLACEHOLDER_WORDS = new Set([
  "episode", "episodio", "episódio", "épisode", "episodi", "episodio n.", "folge", "aflevering",
  "afsnit", "avsnitt", "episod", "jakso", "odcinek", "epizód", "epizoda", "epizod", "bölüm",
  "серия", "эпизод", "епізод", "серія", "επεισόδιο", "פרק", "حلقة", "ตอนที่", "tập", "episode no.",
  "에피소드", "エピソード", "第", "集", "第集",
]);

/** True for a generated name such as "Episode 5" or "第5話" for episode 5. */
export function isPlaceholderEpisodeName(name: string, number: number): boolean {
  const m = /^(.*?)[\s#.:]*0*(\d+)\s*(?:話|集|화)?$/u.exec(name.trim());
  if (!m || Number(m[2]) !== number) return false;
  const word = m[1]!.trim().toLowerCase();
  return word === "" || PLACEHOLDER_WORDS.has(word);
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
