import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthenticationError, ProviderError, RateLimitError } from "../../src/errors";
import { APICache } from "../../src/providers/cache";
import { TMDBClient } from "../../src/providers/tmdb";
import { mockFetch, queryOf } from "./mock-fetch";

const V3_KEY = "0123456789abcdef0123456789abcdef"; // 32 chars
const V4_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${"x".repeat(200)}`;

const SEARCH_RESULTS = {
  page: 1,
  results: [
    {
      id: 348,
      title: "Alien",
      original_title: "Alien",
      release_date: "1979-05-25",
      overview: "In space no one can hear you scream.",
      poster_path: "/alien.jpg",
      genre_ids: [27, 878],
    },
    { id: 8077, title: "Alien³", release_date: "" },
    { id: 1, title: "Le Samouraï", original_title: "Le Samouraï Original", release_date: "not-a-date" },
  ],
};

const MOVIE_DETAILS = {
  id: 348,
  title: "Alien",
  original_title: "Alien",
  release_date: "1979-05-25",
  overview: "Overview",
  poster_path: "/alien.jpg",
  genres: [
    { id: 27, name: "Horror" },
    { id: 878, name: "Science Fiction" },
  ],
};

const SHOW_DETAILS = {
  id: 1396,
  name: "Breaking Bad",
  original_name: "Breaking Bad",
  first_air_date: "2008-01-20",
  status: "Ended",
  poster_path: "/bb.jpg",
  genres: [{ id: 18, name: "Drama" }],
  networks: [{ id: 174, name: "AMC" }, { id: 2, name: "Other" }],
};

const EPISODE = {
  id: 62085,
  name: "Pilot",
  season_number: 1,
  episode_number: 1,
  air_date: "2008-01-20",
  overview: "A chemistry teacher...",
};

describe("TMDBClient constants and auth mode", () => {
  it("exposes the base URL and provider name", () => {
    expect(TMDBClient.BASE_URL).toBe("https://api.themoviedb.org/3");
    expect(TMDBClient.PROVIDER_NAME).toBe("tmdb");
  });

  it("treats keys longer than 50 characters as bearer tokens", () => {
    expect(new TMDBClient({ apiKey: V3_KEY }).usesBearerToken).toBe(false);
    expect(new TMDBClient({ apiKey: "a".repeat(50) }).usesBearerToken).toBe(false);
    expect(new TMDBClient({ apiKey: "a".repeat(51) }).usesBearerToken).toBe(true);
    expect(new TMDBClient({ apiKey: V4_TOKEN }).usesBearerToken).toBe(true);
  });

  it("sends a v3 key as the api_key query parameter", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [] } } },
    ]);
    await new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Alien");

    const [request] = requests;
    expect(queryOf(request!)).toEqual({ query: "Alien", language: "en-US", api_key: V3_KEY });
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers.accept).toBe("application/json");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a v4 token as a bearer header and not in the query", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [] } } },
    ]);
    await new TMDBClient({ apiKey: V4_TOKEN, fetch, language: "fr-FR" }).searchMovie("Alien");

    const [request] = requests;
    expect(queryOf(request!)).toEqual({ query: "Alien", language: "fr-FR" });
    expect(request?.headers.authorization).toBe(`Bearer ${V4_TOKEN}`);
  });
});

describe("TMDBClient.searchMovie", () => {
  it("parses results, release years, and original titles", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/3/search/movie", reply: { json: SEARCH_RESULTS } },
    ]);
    const movies = await new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Alien", 1979);

    expect(queryOf(requests[0]!).year).toBe("1979");
    expect(movies).toHaveLength(3);
    expect(movies[0]).toEqual({
      kind: "movie",
      id: 348,
      title: "Alien",
      originalTitle: "Alien",
      year: 1979,
      releaseDate: "1979-05-25",
      overview: "In space no one can hear you scream.",
      genres: [],
      posterPath: "/alien.jpg",
      provider: "tmdb",
    });
    // Empty date: year 0, no release date; original title falls back to title.
    expect(movies[1]).toMatchObject({ title: "Alien³", originalTitle: "Alien³", year: 0 });
    expect(movies[1]?.releaseDate).toBeUndefined();
    // Unparseable date: year 0.
    expect(movies[2]).toMatchObject({ originalTitle: "Le Samouraï Original", year: 0 });
    expect(movies[2]?.releaseDate).toBeUndefined();
  });

  it("omits year 0 and undefined from the query", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [] } } },
    ]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch });
    await client.searchMovie("Alien", 0);
    await client.searchMovie("Alien");
    expect(queryOf(requests[0]!).year).toBeUndefined();
    expect(queryOf(requests[1]!).year).toBeUndefined();
  });

  it("returns an empty list for empty or missing results", async () => {
    const { fetch } = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [] } } },
      { path: "/3/search/tv", reply: { json: {} } },
    ]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch });
    expect(await client.searchMovie("Nothing")).toEqual([]);
    expect(await client.searchShow("Nothing")).toEqual([]);
  });

  it("encodes the title in the query string", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [] } } },
    ]);
    await new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Amélie & Co?");
    expect(requests[0]?.url.search).toContain("query=Am%C3%A9lie+%26+Co%3F");
    expect(queryOf(requests[0]!).query).toBe("Amélie & Co?");
  });
});

describe("TMDBClient.getMovie", () => {
  it("parses details including genres", async () => {
    const { fetch } = mockFetch([{ path: "/3/movie/348", reply: { json: MOVIE_DETAILS } }]);
    const movie = await new TMDBClient({ apiKey: V3_KEY, fetch }).getMovie(348);
    expect(movie).toMatchObject({
      kind: "movie",
      id: 348,
      year: 1979,
      releaseDate: "1979-05-25",
      genres: ["Horror", "Science Fiction"],
    });
  });

  it("returns undefined when the request fails", async () => {
    for (const status of [404, 401, 429, 500]) {
      const { fetch } = mockFetch([{ path: /.*/, reply: { status } }]);
      const client = new TMDBClient({ apiKey: V3_KEY, fetch, rateLimitRetry: { retries: 0 } });
      expect(await client.getMovie(1)).toBeUndefined();
    }
  });

  it("returns undefined on a network failure", async () => {
    const { fetch } = mockFetch([{ path: /.*/, reply: new TypeError("fetch failed") }]);
    expect(await new TMDBClient({ apiKey: V3_KEY, fetch }).getMovie(1)).toBeUndefined();
  });
});

describe("TMDBClient TV", () => {
  it("searches shows with first_air_date_year", async () => {
    const { fetch, requests } = mockFetch([
      {
        path: "/3/search/tv",
        reply: {
          json: {
            results: [
              { id: 1396, name: "Breaking Bad", original_name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: "/bb.jpg" },
              { id: 2, name: "Unknown", first_air_date: "" },
              { id: 3, name: "Odd", first_air_date: "20x8-01-01" },
            ],
          },
        },
      },
    ]);
    const shows = await new TMDBClient({ apiKey: V3_KEY, fetch }).searchShow("Breaking Bad", 2008);

    expect(queryOf(requests[0]!).first_air_date_year).toBe("2008");
    expect(shows[0]).toEqual({
      kind: "show",
      id: 1396,
      title: "Breaking Bad",
      originalTitle: "Breaking Bad",
      year: 2008,
      genres: [],
      posterPath: "/bb.jpg",
      provider: "tmdb",
    });
    expect(shows[1]).toMatchObject({ originalTitle: "Unknown", year: 0 });
    expect(shows[2]?.year).toBe(0);
  });

  it("gets show details with the first network", async () => {
    const { fetch } = mockFetch([{ path: "/3/tv/1396", reply: { json: SHOW_DETAILS } }]);
    const show = await new TMDBClient({ apiKey: V3_KEY, fetch }).getShow(1396);
    expect(show).toMatchObject({
      kind: "show",
      year: 2008,
      network: "AMC",
      status: "Ended",
      genres: ["Drama"],
      posterPath: "/bb.jpg",
    });
  });

  it("leaves network undefined when there are none", async () => {
    const { fetch } = mockFetch([
      { path: "/3/tv/1", reply: { json: { id: 1, name: "X", networks: [] } } },
    ]);
    const show = await new TMDBClient({ apiKey: V3_KEY, fetch }).getShow(1);
    expect(show?.network).toBeUndefined();
    expect(show?.year).toBe(0);
  });

  it("gets an episode from its season after looking up the show", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/3/tv/1396", reply: { json: SHOW_DETAILS } },
      {
        path: "/3/tv/1396/season/1",
        reply: { json: { season_number: 1, episodes: [{ ...EPISODE, episode_number: 2, name: "Cat's in the Bag..." }, EPISODE] } },
      },
    ]);
    const episode = await new TMDBClient({ apiKey: V3_KEY, fetch }).getEpisode(1396, 1, 1);

    expect(requests.map((r) => r.url.pathname)).toEqual(["/3/tv/1396", "/3/tv/1396/season/1"]);
    expect(episode).toMatchObject({
      kind: "episode",
      season: 1,
      episode: 1,
      title: "Pilot",
      airDate: "2008-01-20",
      overview: "A chemistry teacher...",
    });
    expect(episode?.show.title).toBe("Breaking Bad");
  });

  it("falls back to the requested season and an \"Episode N\" title", async () => {
    const { fetch } = mockFetch([
      { path: "/3/tv/1396", reply: { json: SHOW_DETAILS } },
      { path: "/3/tv/1396/season/2", reply: { json: { episodes: [{ episode_number: 5, air_date: "bad" }] } } },
    ]);
    const episode = await new TMDBClient({ apiKey: V3_KEY, fetch }).getEpisode(1396, 2, 5);
    expect(episode).toMatchObject({ season: 2, episode: 5, title: "Episode 5" });
    expect(episode?.airDate).toBeUndefined();
  });

  it("returns undefined when the show, the season, or the episode is missing", async () => {
    const noShow = mockFetch([]);
    expect(
      await new TMDBClient({ apiKey: V3_KEY, fetch: noShow.fetch }).getEpisode(1, 1, 1),
    ).toBeUndefined();
    expect(noShow.requests).toHaveLength(1);

    const noSeason = mockFetch([{ path: "/3/tv/1396", reply: { json: SHOW_DETAILS } }]);
    expect(
      await new TMDBClient({ apiKey: V3_KEY, fetch: noSeason.fetch }).getEpisode(1396, 9, 9),
    ).toBeUndefined();

    const noEpisode = mockFetch([
      { path: "/3/tv/1396", reply: { json: SHOW_DETAILS } },
      { path: "/3/tv/1396/season/1", reply: { json: { episodes: [EPISODE] } } },
    ]);
    expect(
      await new TMDBClient({ apiKey: V3_KEY, fetch: noEpisode.fetch }).getEpisode(1396, 1, 9),
    ).toBeUndefined();

    const noList = mockFetch([
      { path: "/3/tv/1396", reply: { json: SHOW_DETAILS } },
      { path: "/3/tv/1396/season/1", reply: { json: { season_number: 1 } } },
    ]);
    expect(
      await new TMDBClient({ apiKey: V3_KEY, fetch: noList.fetch }).getEpisode(1396, 1, 1),
    ).toBeUndefined();
  });

  it("fetches a season once for all of its episodes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tidytitles-tmdb-season-"));
    try {
      const { fetch, requests } = mockFetch([
        { path: "/3/tv/1396", reply: { json: SHOW_DETAILS } },
        {
          path: "/3/tv/1396/season/1",
          reply: {
            json: {
              episodes: Array.from({ length: 24 }, (_, i) => ({ ...EPISODE, episode_number: i + 1, name: `E${i + 1}` })),
            },
          },
        },
      ]);
      const client = new TMDBClient({ apiKey: V3_KEY, fetch, cache: new APICache({ cacheDir: dir }) });
      // Concurrent calls share the in-flight requests; later ones hit the cache.
      const first = await Promise.all([1, 2, 3, 4, 5, 6].map((e) => client.getEpisode(1396, 1, e)));
      const rest = await Promise.all([7, 8, 24].map((e) => client.getEpisode(1396, 1, e)));
      expect([...first, ...rest].map((e) => e?.title)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E24"]);
      expect(requests.map((r) => r.url.pathname)).toEqual(["/3/tv/1396", "/3/tv/1396/season/1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TMDBClient error mapping", () => {
  const client = (status: number) =>
    new TMDBClient({
      apiKey: V3_KEY,
      fetch: mockFetch([{ path: /.*/, reply: { status } }]).fetch,
      rateLimitRetry: { retries: 0 },
    });

  it("maps 401 to AuthenticationError", async () => {
    await expect(client(401).searchMovie("x")).rejects.toThrow(AuthenticationError);
    await expect(client(401).searchMovie("x")).rejects.toThrow("Invalid TMDB API key");
  });

  it("maps 429 to RateLimitError", async () => {
    await expect(client(429).searchShow("x")).rejects.toThrow(RateLimitError);
  });

  it("maps other 4xx/5xx to ProviderError", async () => {
    for (const status of [400, 404, 500, 503]) {
      const error = await client(status).searchMovie("x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(AuthenticationError);
      expect(error).not.toBeInstanceOf(RateLimitError);
      expect((error as Error).message).toBe(`TMDB API error: ${status}`);
    }
  });

  it("maps network failures and timeouts to ProviderError with a cause", async () => {
    const cause = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { fetch } = mockFetch([{ path: /.*/, reply: cause }]);
    const error = await new TMDBClient({ apiKey: V3_KEY, fetch, timeoutMs: 5000 })
      .searchMovie("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("timed out after 5000 ms");
    expect((error as Error).cause).toBe(cause);
  });
});

describe("TMDBClient malformed payloads", () => {
  const withBody = (reply: { json?: unknown; body?: string }) =>
    new TMDBClient({ apiKey: V3_KEY, fetch: mockFetch([{ path: /.*/, reply }]).fetch });

  it("rejects invalid JSON", async () => {
    await expect(withBody({ body: "<html>oops</html>" }).searchMovie("x")).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("rejects non-object bodies and non-array results", async () => {
    await expect(withBody({ json: [] }).searchMovie("x")).rejects.toThrow(ProviderError);
    await expect(withBody({ json: { results: {} } }).searchMovie("x")).rejects.toThrow(
      ProviderError,
    );
  });

  it("rejects results missing required fields", async () => {
    await expect(withBody({ json: { results: [{ title: "No id" }] } }).searchMovie("x")).rejects.toThrow(
      /missing "id"/,
    );
    await expect(withBody({ json: { results: [{ id: 1 }] } }).searchMovie("x")).rejects.toThrow(
      /missing "title"/,
    );
    await expect(withBody({ json: { results: [{ id: 1 }] } }).searchShow("x")).rejects.toThrow(
      /missing "name"/,
    );
  });

  it("propagates malformed detail payloads instead of returning undefined", async () => {
    await expect(withBody({ json: { title: "No id" } }).getMovie(1)).rejects.toThrow(ProviderError);
    await expect(
      withBody({ json: { id: 1, title: "T", genres: [{ id: 1 }] } }).getMovie(1),
    ).rejects.toThrow(/missing "name"/);
  });

  it("treats null optional fields as absent", async () => {
    const movie = await withBody({
      json: { id: 1, title: "T", original_title: null, overview: null, poster_path: null, release_date: null, genres: null },
    }).getMovie(1);
    expect(movie).toMatchObject({ originalTitle: "T", year: 0, genres: [] });
    expect(movie?.posterPath).toBeUndefined();
  });
});

describe("TMDBClient caching", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tidytitles-tmdb-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves repeated requests from the cache, keyed by params", async () => {
    const { fetch, mock } = mockFetch([
      { path: "/3/search/movie", reply: { json: SEARCH_RESULTS } },
    ]);
    const cache = new APICache({ cacheDir: dir });
    const client = new TMDBClient({ apiKey: V3_KEY, fetch, cache });

    const first = await client.searchMovie("Alien", 1979);
    const second = await client.searchMovie("Alien", 1979);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    await client.searchMovie("Alien", 1986);
    expect(mock).toHaveBeenCalledTimes(2);

    expect(
      cache.get("tmdb", "/search/movie", {
        query: "Alien",
        year: 1979,
        language: "en-US",
        api_key: V3_KEY,
      }),
    ).toEqual(SEARCH_RESULTS);
  });

  it("does not cache failures", async () => {
    const { fetch, mock } = mockFetch([{ path: /.*/, reply: { status: 500 } }]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch, cache: new APICache({ cacheDir: dir }) });
    await expect(client.searchMovie("x")).rejects.toThrow(ProviderError);
    await expect(client.searchMovie("x")).rejects.toThrow(ProviderError);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
