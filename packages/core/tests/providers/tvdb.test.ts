import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthenticationError, ProviderError, RateLimitError } from "../../src/errors";
import { APICache } from "../../src/providers/cache";
import { TVDBClient } from "../../src/providers/tvdb";
import { mockFetch, queryOf, type Route } from "./mock-fetch";

const API_KEY = "test-tvdb-key";
const LOGIN: Route = {
  method: "POST",
  path: "/v4/login",
  reply: { json: { status: "success", data: { token: "tok-123" } } },
};

const SEARCH = {
  status: "success",
  data: [
    {
      tvdb_id: "81189",
      name: "Breaking Bad",
      year: "2008",
      network: "AMC",
      status: "Ended",
      image_url: "https://artworks.thetvdb.com/bb.jpg",
      thumbnail: "https://artworks.thetvdb.com/bb_t.jpg",
    },
    { id: 12, title: "Fallback Title", first_air_time: "1999-03-04", thumbnail: "thumb.jpg" },
    { tvdb_id: "13", name: "No Year", first_air_time: "unknown" },
  ],
};

const SERIES = {
  status: "success",
  data: {
    id: 81189,
    name: "Breaking Bad",
    originalName: "Breaking Bad (Original)",
    firstAired: "2008-01-20",
    year: "2008",
    image: "https://artworks.thetvdb.com/bb.jpg",
    genres: [{ id: 1, name: "Drama" }, { id: 2, name: "Crime" }],
    originalNetwork: { id: 7, name: "AMC" },
    status: { id: 2, name: "Ended" },
  },
};

const EPISODES = {
  status: "success",
  data: {
    series: { id: 81189 },
    episodes: [
      { seasonNumber: 1, number: 1, name: "Pilot", aired: "2008-01-20", overview: "Walt..." },
      { seasonNumber: 1, number: 2, name: "Cat's in the Bag...", aired: "2008-01-27" },
      { seasonNumber: 1, number: 3, aired: "not a date" },
    ],
  },
};

describe("TVDBClient constants", () => {
  it("exposes the base URL and provider name", () => {
    expect(TVDBClient.BASE_URL).toBe("https://api4.thetvdb.com/v4");
    expect(TVDBClient.PROVIDER_NAME).toBe("tvdb");
  });
});

describe("TVDBClient authentication", () => {
  it("logs in with the API key and uses the bearer token", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/search", reply: { json: SEARCH } }]);
    const client = new TVDBClient({ apiKey: API_KEY, fetch });
    expect(client.isAuthenticated).toBe(false);

    await client.searchShow("Breaking Bad");

    expect(client.isAuthenticated).toBe(true);
    const [login, search] = requests;
    expect(login?.url.href).toBe("https://api4.thetvdb.com/v4/login");
    expect(login?.method).toBe("POST");
    expect(login?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(login!.body!)).toEqual({ apikey: API_KEY });
    expect(search?.headers.authorization).toBe("Bearer tok-123");
    expect(search?.headers.accept).toBe("application/json");
    expect(search?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the subscriber PIN when given", async () => {
    const { fetch, requests } = mockFetch([LOGIN]);
    await new TVDBClient({ apiKey: API_KEY, pin: "1234", fetch }).authenticate();
    expect(JSON.parse(requests[0]!.body!)).toEqual({ apikey: API_KEY, pin: "1234" });
  });

  it("omits an empty PIN", async () => {
    const { fetch, requests } = mockFetch([LOGIN]);
    await new TVDBClient({ apiKey: API_KEY, pin: "", fetch }).authenticate();
    expect(JSON.parse(requests[0]!.body!)).toEqual({ apikey: API_KEY });
  });

  it("reuses the token across requests", async () => {
    const { fetch, requests } = mockFetch([
      LOGIN,
      { path: "/v4/search", reply: { json: SEARCH } },
      { path: "/v4/series/81189", reply: { json: SERIES } },
    ]);
    const client = new TVDBClient({ apiKey: API_KEY, fetch });

    await client.searchShow("Breaking Bad");
    await client.getShow(81189);
    await client.searchShow("Other");

    expect(requests.filter((r) => r.url.pathname === "/v4/login")).toHaveLength(1);
  });

  it("shares a single login between concurrent requests", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/search", reply: { json: SEARCH } }]);
    const client = new TVDBClient({ apiKey: API_KEY, fetch });

    await Promise.all([client.searchShow("a"), client.searchShow("b"), client.getShow(1)]);

    expect(requests.filter((r) => r.url.pathname === "/v4/login")).toHaveLength(1);
  });

  it("does not reuse a token after an explicit authenticate()", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      { method: "POST", path: "/v4/login", reply: () => ({ json: { data: { token: `tok-${++n}` } } }) },
      { path: "/v4/search", reply: { json: { data: [] } } },
    ]);
    const client = new TVDBClient({ apiKey: API_KEY, fetch });
    await client.searchShow("a");
    await client.authenticate();
    await client.searchShow("b");
    expect(requests.at(-1)?.headers.authorization).toBe("Bearer tok-2");
  });

  it("maps a 401 login to AuthenticationError", async () => {
    const { fetch } = mockFetch([{ method: "POST", path: "/v4/login", reply: { status: 401 } }]);
    const client = new TVDBClient({ apiKey: "bad", fetch });
    await expect(client.searchShow("x")).rejects.toThrow(AuthenticationError);
    await expect(client.authenticate()).rejects.toThrow("Invalid TVDB API key");
  });

  it("maps other login failures (including 429) to ProviderError", async () => {
    for (const status of [429, 500]) {
      const { fetch } = mockFetch([{ method: "POST", path: "/v4/login", reply: { status } }]);
      const error = await new TVDBClient({ apiKey: API_KEY, fetch })
        .authenticate()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(RateLimitError);
      expect((error as Error).message).toBe(`TVDB authentication failed: ${status}`);
    }
  });

  it("retries the login on the next call after a failed login", async () => {
    let n = 0;
    const { fetch, requests } = mockFetch([
      {
        method: "POST",
        path: "/v4/login",
        reply: () => (++n === 1 ? { status: 500 } : { json: { data: { token: "tok-ok" } } }),
      },
      { path: "/v4/search", reply: { json: { data: [] } } },
    ]);
    const client = new TVDBClient({ apiKey: API_KEY, fetch });
    await expect(client.searchShow("x")).rejects.toThrow(ProviderError);
    await expect(client.searchShow("x")).resolves.toEqual([]);
    expect(requests.at(-1)?.headers.authorization).toBe("Bearer tok-ok");
  });

  it("rejects a login response without a token", async () => {
    const { fetch } = mockFetch([{ method: "POST", path: "/v4/login", reply: { json: { data: {} } } }]);
    await expect(new TVDBClient({ apiKey: API_KEY, fetch }).authenticate()).rejects.toThrow(
      /missing "token"/,
    );
  });

  it("maps a 401 on a data request to AuthenticationError without logging in again", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/search", reply: { status: 401 } }]);
    const client = new TVDBClient({ apiKey: API_KEY, fetch });
    await expect(client.searchShow("x")).rejects.toThrow("TVDB token expired or invalid");
    await expect(client.searchShow("x")).rejects.toThrow(AuthenticationError);
    expect(requests.filter((r) => r.url.pathname === "/v4/login")).toHaveLength(1);
  });
});

describe("TVDBClient.searchShow", () => {
  it("parses ids, years, titles, and images", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/search", reply: { json: SEARCH } }]);
    const shows = await new TVDBClient({ apiKey: API_KEY, fetch }).searchShow("Breaking Bad", 2008);

    expect(queryOf(requests[1]!)).toEqual({ query: "Breaking Bad", type: "series", year: "2008" });
    expect(shows[0]).toEqual({
      kind: "show",
      id: 81189,
      title: "Breaking Bad",
      originalTitle: "Breaking Bad",
      year: 2008,
      network: "AMC",
      status: "Ended",
      genres: [],
      posterPath: "https://artworks.thetvdb.com/bb.jpg",
      provider: "tvdb",
    });
    expect(shows[1]).toMatchObject({
      id: 12,
      title: "Fallback Title",
      originalTitle: "Fallback Title",
      year: 1999,
      posterPath: "thumb.jpg",
    });
    expect(shows[2]).toMatchObject({ id: 13, year: 0 });
    expect(shows[2]?.posterPath).toBeUndefined();
  });

  it("omits the year when not given", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/search", reply: { json: { data: [] } } }]);
    expect(await new TVDBClient({ apiKey: API_KEY, fetch }).searchShow("Nothing")).toEqual([]);
    expect(queryOf(requests[1]!)).toEqual({ query: "Nothing", type: "series" });
  });

  it("returns an empty list when data is missing", async () => {
    const { fetch } = mockFetch([LOGIN, { path: "/v4/search", reply: { json: { status: "success" } } }]);
    expect(await new TVDBClient({ apiKey: API_KEY, fetch }).searchShow("Nothing")).toEqual([]);
  });

  it("rejects malformed results", async () => {
    const run = (data: unknown) =>
      new TVDBClient({
        apiKey: API_KEY,
        fetch: mockFetch([LOGIN, { path: "/v4/search", reply: { json: { data } } }]).fetch,
      }).searchShow("x");

    await expect(run({})).rejects.toThrow(ProviderError);
    await expect(run([{ tvdb_id: "abc", name: "Bad id" }])).rejects.toThrow(/not an integer/);
    await expect(run([{ tvdb_id: "1", name: "Bad year", year: "20o8" }])).rejects.toThrow(/not an integer/);
    await expect(run([{ name: "No id" }])).rejects.toThrow(/missing "tvdb_id"/);
  });
});

describe("TVDBClient.getShow", () => {
  it("parses series details", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/series/81189", reply: { json: SERIES } }]);
    const show = await new TVDBClient({ apiKey: API_KEY, fetch }).getShow(81189);

    expect(queryOf(requests[1]!)).toEqual({});
    expect(show).toEqual({
      kind: "show",
      id: 81189,
      title: "Breaking Bad",
      originalTitle: "Breaking Bad (Original)",
      year: 2008,
      network: "AMC",
      status: "Ended",
      genres: ["Drama", "Crime"],
      posterPath: "https://artworks.thetvdb.com/bb.jpg",
      provider: "tvdb",
    });
  });

  it("falls back to firstAired, name, and a string status", async () => {
    const { fetch } = mockFetch([
      LOGIN,
      {
        path: "/v4/series/5",
        reply: { json: { data: { id: 5, name: "Show", firstAired: "2011-04-17", status: "Continuing", originalNetwork: null } } },
      },
    ]);
    const show = await new TVDBClient({ apiKey: API_KEY, fetch }).getShow(5);
    expect(show).toMatchObject({ year: 2011, originalTitle: "Show", status: "Continuing", genres: [] });
    expect(show?.network).toBeUndefined();
  });

  it("returns undefined when the request fails", async () => {
    for (const status of [404, 429, 500]) {
      const { fetch } = mockFetch([LOGIN, { path: /\/v4\/series\//, reply: { status } }]);
      const client = new TVDBClient({ apiKey: API_KEY, fetch, rateLimitRetry: { retries: 0 } });
      expect(await client.getShow(1)).toBeUndefined();
    }
  });

  it("propagates a malformed series payload", async () => {
    const { fetch } = mockFetch([LOGIN, { path: "/v4/series/1", reply: { json: { data: { name: "No id" } } } }]);
    await expect(new TVDBClient({ apiKey: API_KEY, fetch }).getShow(1)).rejects.toThrow(/missing "id"/);
  });
});

describe("TVDBClient.getEpisode", () => {
  const routes = (): Route[] => [
    LOGIN,
    { path: "/v4/series/81189", reply: { json: SERIES } },
    { path: "/v4/series/81189/episodes/official", reply: { json: EPISODES } },
  ];

  it("finds the episode in the season listing", async () => {
    const { fetch, requests } = mockFetch(routes());
    const episode = await new TVDBClient({ apiKey: API_KEY, fetch }).getEpisode(81189, 1, 2);

    expect(queryOf(requests.at(-1)!)).toEqual({ page: "0", season: "1" });
    expect(episode).toMatchObject({
      kind: "episode",
      season: 1,
      episode: 2,
      title: "Cat's in the Bag...",
      airDate: "2008-01-27",
    });
    expect(episode?.overview).toBeUndefined();
    expect(episode?.show.id).toBe(81189);
  });

  it("defaults a missing name and ignores a bad air date", async () => {
    const { fetch } = mockFetch(routes());
    const episode = await new TVDBClient({ apiKey: API_KEY, fetch }).getEpisode(81189, 1, 3);
    expect(episode?.title).toBe("Episode 3");
    expect(episode?.airDate).toBeUndefined();
  });

  it("returns undefined when the episode is not listed", async () => {
    const { fetch } = mockFetch(routes());
    expect(await new TVDBClient({ apiKey: API_KEY, fetch }).getEpisode(81189, 1, 99)).toBeUndefined();
  });

  it("returns undefined when the show or the listing fails", async () => {
    const noShow = mockFetch([LOGIN]);
    expect(await new TVDBClient({ apiKey: API_KEY, fetch: noShow.fetch }).getEpisode(1, 1, 1)).toBeUndefined();

    const noList = mockFetch([LOGIN, { path: "/v4/series/81189", reply: { json: SERIES } }]);
    expect(await new TVDBClient({ apiKey: API_KEY, fetch: noList.fetch }).getEpisode(81189, 1, 1)).toBeUndefined();
  });
});

describe("TVDBClient error mapping", () => {
  const client = (reply: Route["reply"]) =>
    new TVDBClient({
      apiKey: API_KEY,
      fetch: mockFetch([LOGIN, { path: "/v4/search", reply }]).fetch,
      rateLimitRetry: { retries: 0 },
    });

  it("maps 429 to RateLimitError", async () => {
    await expect(client({ status: 429 }).searchShow("x")).rejects.toThrow(RateLimitError);
  });

  it("maps other failures to ProviderError", async () => {
    await expect(client({ status: 500 }).searchShow("x")).rejects.toThrow("TVDB API error: 500");
    await expect(client(new TypeError("fetch failed")).searchShow("x")).rejects.toThrow(ProviderError);
    await expect(client({ body: "not json" }).searchShow("x")).rejects.toThrow(/invalid JSON/);
  });
});

describe("TVDBClient caching", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tidytitles-tvdb-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves repeated requests from the cache", async () => {
    const { fetch, requests } = mockFetch([LOGIN, { path: "/v4/search", reply: { json: SEARCH } }]);
    const cache = new APICache({ cacheDir: dir });
    const client = new TVDBClient({ apiKey: API_KEY, fetch, cache });

    const first = await client.searchShow("Breaking Bad");
    const second = await client.searchShow("Breaking Bad");

    expect(second).toEqual(first);
    expect(requests.filter((r) => r.url.pathname === "/v4/search")).toHaveLength(1);
    expect(cache.get("tvdb", "/search", { query: "Breaking Bad", type: "series" })).toEqual(SEARCH);
  });
});
