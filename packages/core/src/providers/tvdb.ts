/** TVDB API client for TV show metadata. */

import { AuthenticationError, ProviderError, RateLimitError } from "../errors";
import { createEpisode, createTVShow, type Episode, type TVShow } from "../models";
import type { FetchFn, TVProvider } from "./base";
import {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  isRecord,
  malformed,
  optionalArray,
  optionalString,
  parseIsoDate,
  pyInt,
  readJson,
  requireKey,
  requireObject,
  requireString,
  sendRequest,
  truthy,
  yearPrefix,
  type JsonObject,
  type QueryParams,
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
}

/** Client for TheTVDB API v4. */
export class TVDBClient implements TVProvider {
  static readonly BASE_URL = "https://api4.thetvdb.com/v4";
  static readonly PROVIDER_NAME = "tvdb";

  private readonly apiKey: string;
  private readonly pin?: string;
  private readonly cache?: ResponseCache;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private token?: string;
  private pendingLogin?: Promise<string>;

  constructor(options: TVDBClientOptions) {
    this.apiKey = options.apiKey;
    this.pin = options.pin;
    this.cache = options.cache;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

    const response = await sendRequest(
      this.fetchFn,
      buildUrl(TVDBClient.BASE_URL, endpoint, params),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      },
      LABEL,
      this.timeoutMs,
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

      const name = optionalString(item.name) ?? optionalString(item.title) ?? "";
      const imageUrl = optionalString(item.image_url);
      const thumbnail = optionalString(item.thumbnail);

      return createTVShow({
        id,
        title: name,
        originalTitle: name,
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
    let data: JsonObject;
    try {
      data = await this.request(`/series/${showId}`);
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }

    const item = data.data == null ? {} : requireObject(data.data, LABEL, "data");

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

    const name = optionalString(item.name) ?? "";
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
      originalTitle: optionalString(item.originalName) ?? name,
      year: showYear,
      network,
      status,
      genres,
      posterPath: optionalString(item.image),
      provider: TVDBClient.PROVIDER_NAME,
    });
  }

  /**
   * Get episode details. Fetches the show, then the season's episodes from
   * the default ordering (first page only, as in the Python client), and
   * returns the matching episode or `undefined`.
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
      data = await this.request(`/series/${showId}/episodes/default`, { season });
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }

    const inner = data.data == null ? {} : requireObject(data.data, LABEL, "data");
    for (const raw of optionalArray(inner.episodes, LABEL, "episodes")) {
      const ep = requireObject(raw, LABEL, "episode");
      if (ep.seasonNumber === season && ep.number === episode) {
        return createEpisode({
          show,
          season,
          episode,
          title: optionalString(ep.name) ?? `Episode ${episode}`,
          airDate: parseIsoDate(ep.aired),
          overview: optionalString(ep.overview),
        });
      }
    }
    return undefined;
  }
}

/** Python `int(value)` where the Python code did not guard it: failure is malformed. */
function strictInt(value: unknown, field: string): number {
  const result = pyInt(value);
  if (result === undefined) malformed(LABEL, `"${field}" is not an integer`);
  return result;
}
