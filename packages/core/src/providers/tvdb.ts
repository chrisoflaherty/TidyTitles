/** TVDB API client for TV show metadata. */

import { DEFAULT_EPISODE_ORDER, type EpisodeOrder } from "../episodeOrder";
import {
  AuthenticationError,
  EpisodeOrderUnavailableError,
  ProviderError,
  RateLimitError,
} from "../errors";
import { DEFAULT_METADATA_LANGUAGE, tvdbLanguageCode } from "../languages";
import { createEpisode, createTVShow, type Episode, type TVShow } from "../models";
import type { FetchFn, TVProvider } from "./base";
import { RunMemo } from "./memo";
import {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  isRecord,
  malformed,
  optionalArray,
  optionalString,
  parseIsoDate,
  pyInt,
  InflightRequests,
  readJson,
  requestKey,
  requireKey,
  requireObject,
  requireString,
  sendRequest,
  sendWithRateLimitRetry,
  truthy,
  yearPrefix,
  type JsonObject,
  type QueryParams,
  type RateLimitRetryOptions,
  type ResponseCache,
} from "./util";

const LABEL = "TVDB";

export interface TVDBClientOptions {
  /** TVDB API key. */
  apiKey: string;
  /** Optional subscriber PIN for extended access, sent with the login request. */
  pin?: string;
  /** Optional response cache. */
  cache?: ResponseCache;
  /** Fetch implementation (default `globalThis.fetch`). */
  fetch?: FetchFn;
  /** Per-request timeout in milliseconds (default 30,000). */
  timeoutMs?: number;
  /** Retries for HTTP 429 (default: 2 retries, honoring `Retry-After` up to 10 s). */
  rateLimitRetry?: RateLimitRetryOptions;
  /**
   * Metadata language, as stored in settings ("en-US", "de-DE"; default
   * "en-US"). Series and episode names use TVDB's translation in this
   * language, then English, then the original name.
   */
  language?: string;
  /** Episode order for season/episode numbers (default "aired"). */
  episodeOrder?: EpisodeOrder;
}

/** TVDB season types (`/series/{id}/episodes/{season-type}`) for each order. */
export const TVDB_SEASON_TYPES: Readonly<Record<EpisodeOrder, string>> = {
  aired: "official",
  dvd: "dvd",
  absolute: "absolute",
};

/** Most pages read from one episode listing. */
export const TVDB_MAX_PAGES = 100;

/** Air dates of one show asked for one at a time before the whole listing is read. */
export const TVDB_DATE_QUERIES_PER_SHOW = 2;

/** Client for TheTVDB API v4. */
export class TVDBClient implements TVProvider {
  static readonly BASE_URL = "https://api4.thetvdb.com/v4";
  static readonly PROVIDER_NAME = "tvdb";

  private readonly apiKey: string;
  private readonly pin?: string;
  private readonly cache?: ResponseCache;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly rateLimitRetry: RateLimitRetryOptions;
  private readonly inflight = new InflightRequests<JsonObject>();
  private token?: string;
  private pendingLogin?: Promise<string>;
  /** Listings, series records, and translations, once per client (one run). */
  private readonly memo = new RunMemo();
  /** TVDB language codes to try for names, in order: the setting, then English. */
  private readonly languages: string[];
  readonly episodeOrder: EpisodeOrder;
  /** Air date lookups per show in this run (see `getEpisodeByAirDate`). */
  private readonly dateLookups = new Map<number, number>();

  constructor(options: TVDBClientOptions) {
    this.apiKey = options.apiKey;
    this.pin = options.pin;
    this.cache = options.cache;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitRetry = options.rateLimitRetry ?? {};
    const language = tvdbLanguageCode(options.language ?? DEFAULT_METADATA_LANGUAGE);
    this.languages = language === "eng" ? ["eng"] : [language, "eng"];
    this.episodeOrder = options.episodeOrder ?? DEFAULT_EPISODE_ORDER;
  }

  /** The TVDB language code names are requested in ("eng", "deu"). */
  get language(): string {
    return this.languages[0]!;
  }

  /** True once a bearer token has been obtained. */
  get isAuthenticated(): boolean {
    return this.token !== undefined;
  }

  /**
   * Log in to TVDB and store a new bearer token. Requests call this lazily
   * on first use; call it directly to validate the key up front (the Python
   * client did this when entering its async context).
   */
  async authenticate(): Promise<void> {
    await this.startLogin();
  }

  /** Start a login, store its token on success, and share it with concurrent callers. */
  private startLogin(): Promise<string> {
    const login = this.login().then(
      (token) => {
        this.token = token;
        return token;
      },
    );
    this.pendingLogin = login;
    const clear = (): void => {
      if (this.pendingLogin === login) this.pendingLogin = undefined;
    };
    login.then(clear, clear);
    return login;
  }

  private async login(): Promise<string> {
    const body: Record<string, string> = { apikey: this.apiKey };
    if (this.pin) body.pin = this.pin;

    const response = await sendRequest(
      this.fetchFn,
      `${TVDBClient.BASE_URL}/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      LABEL,
      this.timeoutMs,
    );

    if (response.status === 401) throw new AuthenticationError("Invalid TVDB API key");
    if (response.status >= 400) {
      throw new ProviderError(`TVDB authentication failed: ${response.status}`);
    }

    const data = requireObject(await readJson(response, LABEL), LABEL, "login response");
    const inner = requireObject(data.data, LABEL, "login data");
    return requireString(inner, "token", LABEL);
  }

  /** The current token, logging in first if needed (one login shared by concurrent callers). */
  private ensureToken(): Promise<string> {
    if (this.token !== undefined) return Promise.resolve(this.token);
    return this.pendingLogin ?? this.startLogin();
  }

  /** Make an API request with caching and error handling. */
  private async request(endpoint: string, params: QueryParams = {}): Promise<JsonObject> {
    const token = await this.ensureToken();

    const cached = this.cache?.get(TVDBClient.PROVIDER_NAME, endpoint, params);
    if (cached !== undefined && cached !== null) {
      return requireObject(cached, LABEL, "cached response");
    }

    // Identical requests in flight at the same time share one network call.
    return this.inflight.run(requestKey(endpoint, params), () =>
      this.fetchJson(endpoint, params, token),
    );
  }

  private async fetchJson(endpoint: string, params: QueryParams, token: string): Promise<JsonObject> {
    const response = await sendWithRateLimitRetry(
      () =>
        sendRequest(
          this.fetchFn,
          buildUrl(TVDBClient.BASE_URL, endpoint, params),
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          },
          LABEL,
          this.timeoutMs,
        ),
      this.rateLimitRetry,
    );

    if (response.status === 401) throw new AuthenticationError("TVDB token expired or invalid");
    if (response.status === 429) throw new RateLimitError("TVDB rate limit exceeded");
    if (response.status >= 400) throw new ProviderError(`TVDB API error: ${response.status}`);

    const data = requireObject(await readJson(response, LABEL), LABEL, "response");
    this.cache?.set(TVDBClient.PROVIDER_NAME, endpoint, params, data);
    return data;
  }

  /** Search for TV shows by title, optionally narrowed by year. */
  async searchShow(title: string, year?: number): Promise<TVShow[]> {
    const params: QueryParams = { query: title, type: "series" };
    if (year) params.year = year;

    const data = await this.request("/search", params);
    return optionalArray(data.data, LABEL, "data").map((raw) => {
      const item = requireObject(raw, LABEL, "search result");

      let showYear = 0;
      if (truthy(item.year)) {
        showYear = strictInt(item.year, "year");
      } else if (truthy(item.first_air_time)) {
        showYear = yearPrefix(item.first_air_time) ?? 0;
      }

      const rawId = truthy(item.tvdb_id) ? item.tvdb_id : item.id;
      const id = typeof rawId === "string" ? strictInt(rawId, "tvdb_id") : rawId;
      if (typeof id !== "number") malformed(LABEL, 'missing "tvdb_id"');

      const original = optionalString(item.name) ?? optionalString(item.title) ?? "";
      const name = this.pickTranslation(item.translations) ?? original;
      const imageUrl = optionalString(item.image_url);
      const thumbnail = optionalString(item.thumbnail);

      return createTVShow({
        id,
        title: name,
        originalTitle: original || name,
        year: showYear,
        network: optionalString(item.network),
        status: optionalString(item.status),
        genres: [],
        posterPath: imageUrl || thumbnail,
        provider: TVDBClient.PROVIDER_NAME,
      });
    });
  }

  /** Get TV show details by ID, or `undefined` if the request fails. */
  async getShow(showId: number): Promise<TVShow | undefined> {
    const item = await this.seriesRecord(showId);
    if (!item) return undefined;

    let showYear = 0;
    if (truthy(item.year)) {
      showYear = strictInt(item.year, "year");
    } else if (truthy(item.firstAired)) {
      showYear = yearPrefix(item.firstAired) ?? 0;
    }

    const genres = optionalArray(item.genres, LABEL, "genres").map((g) =>
      requireString(requireObject(g, LABEL, "genre"), "name", LABEL),
    );

    const id = requireKey(item, "id", LABEL);
    if (typeof id !== "number") malformed(LABEL, '"id" is not a number');

    const original = optionalString(item.name) ?? "";
    const name = await this.seriesName(showId, item, original);
    const network =
      truthy(item.originalNetwork) && isRecord(item.originalNetwork)
        ? optionalString(item.originalNetwork.name)
        : undefined;
    const status = isRecord(item.status)
      ? optionalString(item.status.name)
      : optionalString(item.status);

    return createTVShow({
      id,
      title: name,
      originalTitle: optionalString(item.originalName) ?? (original || name),
      year: showYear,
      network,
      status,
      genres,
      posterPath: optionalString(item.image),
      provider: TVDBClient.PROVIDER_NAME,
    });
  }

  /**
   * Get episode details in the configured order. Fetches the show, then the
   * season's listing (every page, once per run), and returns the matching
   * episode or `undefined`.
   *
   * In absolute order the episode number is the absolute number (the season
   * is ignored, except season 0 for specials, which keep aired numbers).
   *
   * @throws EpisodeOrderUnavailableError when the show has no episodes in
   *   the configured DVD or absolute order.
   */
  async getEpisode(
    showId: number,
    season: number,
    episode: number,
  ): Promise<Episode | undefined> {
    const show = await this.getShow(showId);
    if (!show) return undefined;

    if (this.episodeOrder === "absolute" && season !== 0) {
      return this.absoluteEpisode(show, episode);
    }
    const type =
      this.episodeOrder === "absolute" ? TVDB_SEASON_TYPES.aired : TVDB_SEASON_TYPES[this.episodeOrder];
    const listing = await this.listEpisodes(showId, type, { season });
    if (listing === undefined) return undefined;
    const raw = listing.find((ep) => ep.seasonNumber === season && ep.number === episode);
    if (!raw) {
      if (listing.length === 0) await this.requireOrder(show, type);
      return undefined;
    }
    return this.toEpisode(show, type, raw);
  }

  /**
   * The episode that aired on `airDate` ("YYYY-MM-DD"), with its aired
   * numbers. A regular episode wins over a special on the same day.
   *
   * The first dates of a show are asked for one at a time (the `airDate`
   * filter, one request each); from the third on, the show's whole aired
   * listing is read once and shared, so a folder of a daily show costs a
   * few requests rather than one per file.
   */
  async getEpisodeByAirDate(showId: number, airDate: string): Promise<Episode | undefined> {
    const show = await this.getShow(showId);
    if (!show) return undefined;
    const type = TVDB_SEASON_TYPES.aired;
    const lookups = (this.dateLookups.get(showId) ?? 0) + 1;
    this.dateLookups.set(showId, lookups);
    const filter: QueryParams = lookups > TVDB_DATE_QUERIES_PER_SHOW ? {} : { airDate };
    const listing = await this.listEpisodes(showId, type, filter);
    if (listing === undefined) return undefined;
    // The filter is applied here too, in case the server ignores it.
    const sameDay = listing.filter((ep) => parseIsoDate(ep.aired) === airDate);
    const raw = sameDay.find((ep) => ep.seasonNumber !== 0) ?? sameDay[0];
    return raw ? this.toEpisode(show, type, raw) : undefined;
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

  /**
   * Find an absolute number. In absolute order: number N of TVDB's
   * absolute listing. Otherwise: the episode whose `absoluteNumber` is N in
   * the configured order's listing, or, when that listing has no absolute
   * numbers, the episode at N in the absolute listing, found by id.
   */
  private async absoluteEpisode(show: TVShow, absoluteNumber: number): Promise<Episode | undefined> {
    const absoluteType = TVDB_SEASON_TYPES.absolute;
    const findInAbsolute = async (): Promise<JsonObject | undefined> => {
      const listing = await this.listEpisodes(show.id, absoluteType);
      if (listing === undefined) return undefined;
      const raw = listing.find((ep) => ep.number === absoluteNumber && ep.seasonNumber !== 0);
      if (!raw && listing.length === 0 && this.episodeOrder === "absolute") {
        await this.requireOrder(show, absoluteType);
      }
      return raw;
    };

    if (this.episodeOrder === "absolute") {
      const raw = await findInAbsolute();
      if (!raw) return undefined;
      const episode = await this.toEpisode(show, absoluteType, raw);
      return { ...episode, season: 1, episode: absoluteNumber, absoluteNumber };
    }

    const type = TVDB_SEASON_TYPES[this.episodeOrder];
    const listing = await this.listEpisodes(show.id, type);
    if (listing === undefined) return undefined;
    if (listing.length === 0) {
      await this.requireOrder(show, type);
      return undefined;
    }
    let raw = listing.find((ep) => ep.absoluteNumber === absoluteNumber && ep.seasonNumber !== 0);
    if (!raw && !listing.some((ep) => typeof ep.absoluteNumber === "number" && ep.absoluteNumber > 0)) {
      const inAbsolute = await findInAbsolute();
      if (inAbsolute) raw = listing.find((ep) => ep.id === inAbsolute.id);
    }
    if (!raw) return undefined;
    const episode = await this.toEpisode(show, type, raw);
    return { ...episode, absoluteNumber };
  }

  /** Throw when the show has no episodes at all in a season type other than aired. */
  private async requireOrder(show: TVShow, type: string): Promise<void> {
    if (type === TVDB_SEASON_TYPES.aired) return;
    const firstPage = await this.memo.run(`order-check:${show.id}:${type}`, async () => {
      try {
        const data = await this.request(`/series/${show.id}/episodes/${type}`, { page: 0 });
        return episodesOf(data) ?? [];
      } catch (error) {
        if (isFatal(error)) throw error;
        return undefined;
      }
    });
    if (firstPage && firstPage.length === 0) {
      const order = type === TVDB_SEASON_TYPES.dvd ? "DVD" : "absolute";
      throw new EpisodeOrderUnavailableError(
        TVDBClient.PROVIDER_NAME,
        type === TVDB_SEASON_TYPES.dvd ? "dvd" : "absolute",
        `TVDB has no ${order} order for ${show.title || `series ${show.id}`}`,
      );
    }
  }

  /**
   * Every episode of a listing, reading every page (once per run). With
   * `language`, the translated listing. `undefined` when the request fails
   * (as the Python client returned no episode), or, for a translated
   * listing, when the response carries no episodes.
   */
  private listEpisodes(
    showId: number,
    type: string,
    filter: QueryParams = {},
    language?: string,
  ): Promise<JsonObject[] | undefined> {
    const endpoint = language
      ? `/series/${showId}/episodes/${type}/${language}`
      : `/series/${showId}/episodes/${type}`;
    return this.memo.run(`list:${requestKey(endpoint, filter)}`, async () => {
      const all: JsonObject[] = [];
      try {
        for (let page = 0; page < TVDB_MAX_PAGES; page++) {
          const data = await this.request(endpoint, { page, ...filter });
          const episodes = episodesOf(data);
          if (episodes === undefined) {
            if (language && page === 0) return undefined;
            break;
          }
          all.push(...episodes);
          if (episodes.length === 0 || !hasNextPage(data)) break;
        }
      } catch (error) {
        if (isFatal(error) || !(error instanceof ProviderError)) throw error;
        return undefined;
      }
      return all;
    });
  }

  /** The `/series/{id}` record, once per run; `undefined` when the request fails. */
  private seriesRecord(showId: number): Promise<JsonObject | undefined> {
    return this.memo.run(`series:${showId}`, async () => {
      let data: JsonObject;
      try {
        data = await this.request(`/series/${showId}`);
      } catch (error) {
        if (error instanceof ProviderError) return undefined;
        throw error;
      }
      return data.data == null ? {} : requireObject(data.data, LABEL, "data");
    });
  }

  /** The first non-empty name in `translations` (a search result's map) for our languages. */
  private pickTranslation(translations: unknown): string | undefined {
    if (!isRecord(translations)) return undefined;
    for (const language of this.languages) {
      const name = optionalString(translations[language])?.trim();
      if (name) return name;
    }
    return undefined;
  }

  /**
   * The series name in our language: the original name when it is already
   * in that language, else the translation, else the English translation,
   * else the original name. Languages the record lists as untranslated
   * (`nameTranslations`) are not requested.
   */
  private async seriesName(showId: number, item: JsonObject, original: string): Promise<string> {
    const originalLanguage = optionalString(item.originalLanguage);
    const available = stringList(item.nameTranslations);
    for (const language of this.languages) {
      if (language === originalLanguage && original) return original;
      if (available && !available.includes(language)) continue;
      const name = await this.translatedName(`/series/${showId}/translations/${language}`);
      if (name) return name;
    }
    return original;
  }

  /** `data.name` of a translation record, once per run; `undefined` when missing or empty. */
  private translatedName(endpoint: string): Promise<string | undefined> {
    return this.memo.run(`translation:${endpoint}`, async () => {
      try {
        const data = await this.request(endpoint);
        const inner = isRecord(data.data) ? data.data : {};
        return optionalString(inner.name)?.trim() || undefined;
      } catch (error) {
        if (isFatal(error) || !(error instanceof ProviderError)) throw error;
        return undefined;
      }
    });
  }

  /** Episode names by id from the translated listing, once per run. */
  private translatedEpisodeNames(
    showId: number,
    type: string,
    language: string,
  ): Promise<Map<unknown, string> | undefined> {
    return this.memo.run(`names:${showId}:${type}:${language}`, async () => {
      const listing = await this.listEpisodes(showId, type, {}, language);
      if (listing === undefined) return undefined;
      const names = new Map<unknown, string>();
      for (const ep of listing) {
        const name = optionalString(ep.name)?.trim();
        if (name) names.set(ep.id, name);
      }
      return names;
    });
  }

  /**
   * An episode's name in our language, falling back to English, then the
   * original name, then "Episode N". Uses the translated listing (one
   * request per page for the whole show), or the episode's own translation
   * record when the listing has no episodes.
   */
  private async episodeName(show: TVShow, type: string, raw: JsonObject): Promise<string> {
    const original = optionalString(raw.name)?.trim() ?? "";
    const series = await this.seriesRecord(show.id);
    const originalLanguage = series ? optionalString(series.originalLanguage) : undefined;
    const available = stringList(raw.nameTranslations);
    for (const language of this.languages) {
      if (language === originalLanguage && original) return original;
      if (available && !available.includes(language)) continue;
      // Without translation data, an English user keeps the default name.
      if (!available && language === "eng" && original) return original;
      const names = await this.translatedEpisodeNames(show.id, type, language);
      let name = names?.get(raw.id);
      if (names === undefined && raw.id != null) {
        name = await this.translatedName(`/episodes/${String(raw.id)}/translations/${language}`);
      }
      if (name) return name;
    }
    return original || `Episode ${String(raw.number ?? "")}`.trim();
  }

  private async toEpisode(show: TVShow, type: string, raw: JsonObject): Promise<Episode> {
    const season = typeof raw.seasonNumber === "number" ? raw.seasonNumber : 0;
    const number = typeof raw.number === "number" ? raw.number : 0;
    const absolute =
      typeof raw.absoluteNumber === "number" && raw.absoluteNumber > 0 ? raw.absoluteNumber : undefined;
    return createEpisode({
      show,
      season,
      episode: number,
      title: await this.episodeName(show, type, raw),
      airDate: parseIsoDate(raw.aired),
      overview: optionalString(raw.overview),
      ...(absolute !== undefined ? { absoluteNumber: absolute } : {}),
    });
  }
}

/** Python `int(value)` where the Python code did not guard it: failure is malformed. */
function strictInt(value: unknown, field: string): number {
  const result = pyInt(value);
  if (result === undefined) malformed(LABEL, `"${field}" is not an integer`);
  return result;
}

/** The `data.episodes` of a listing page, or `undefined` when there is none. */
function episodesOf(data: JsonObject): JsonObject[] | undefined {
  const inner = data.data == null ? {} : requireObject(data.data, LABEL, "data");
  if (inner.episodes == null) return undefined;
  return optionalArray(inner.episodes, LABEL, "episodes").map((raw) =>
    requireObject(raw, LABEL, "episode"),
  );
}

/** True when a listing page links to a next page (`links.next`). */
function hasNextPage(data: JsonObject): boolean {
  return isRecord(data.links) && typeof data.links.next === "string" && data.links.next !== "";
}

/** Errors that must reach the caller even where a failed lookup reads as "not found". */
function isFatal(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof RateLimitError;
}

/** An array of strings (`nameTranslations`), or `undefined` when absent or not one. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}
