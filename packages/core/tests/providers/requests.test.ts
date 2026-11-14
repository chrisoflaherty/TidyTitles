/** Request-layer behavior shared by the providers: in-flight sharing and 429 retries. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, RateLimitError } from "../../src/errors";
import { MusicBrainzClient, parseReleaseTracks } from "../../src/providers/musicbrainz";
import { TMDBClient } from "../../src/providers/tmdb";
import { TVDBClient } from "../../src/providers/tvdb";
import { InflightRequests, parseRetryAfter } from "../../src/providers/util";
import { mockFetch, type MockReply, type Route } from "./mock-fetch";

const V3_KEY = "0123456789abcdef0123456789abcdef";
const TVDB_LOGIN: Route = { method: "POST", path: "/v4/login", reply: { json: { data: { token: "t" } } } };

/** A reply that waits until `release()` is called. */
function gate(reply: MockReply) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    reply: (async () => {
      await opened;
      return reply;
    }) as MockReply,
    release: () => open(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InflightRequests", () => {
  it("shares a pending promise and forgets it once settled", async () => {
    const inflight = new InflightRequests<number>();
    let calls = 0;
    const start = () => {
      calls += 1;
      return Promise.resolve(calls);
    };
    const [a, b] = [inflight.run("k", start), inflight.run("k", start)];
    expect(inflight.size).toBe(1);
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(inflight.size).toBe(0);
    expect(await inflight.run("k", start)).toBe(2);
  });

  it("shares a rejection too, then lets the next call try again", async () => {
    const inflight = new InflightRequests<number>();
    const failing = () => Promise.reject(new Error("down"));
    const results = await Promise.allSettled([inflight.run("k", failing), inflight.run("k", failing)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(await inflight.run("k", () => Promise.resolve(7))).toBe(7);
  });
});

describe("identical requests in flight share one network call", () => {
  it("TMDB: 24 concurrent searches for one show send one request", async () => {
    const g = gate({ json: { results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" }] } });
    const { fetch, requests } = mockFetch([{ path: "/3/search/tv", reply: g.reply }]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch });
    const searches = Array.from({ length: 24 }, () => client.searchShow("Breaking Bad"));
    g.release();
    const results = await Promise.all(searches);
    expect(requests).toHaveLength(1);
    expect(results.every((r) => r[0]?.id === 1396)).toBe(true);
    // Each caller gets its own parsed objects.
    expect(results[0]![0]).not.toBe(results[1]![0]);
  });

  it("TMDB: different requests are not shared", async () => {
    const { fetch, requests } = mockFetch([{ path: "/3/search/tv", reply: { json: { results: [] } } }]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch });
    await Promise.all([client.searchShow("A"), client.searchShow("B"), client.searchShow("A", 2001)]);
    expect(requests).toHaveLength(3);
  });

  it("TMDB: without a cache, a later identical request goes out again", async () => {
    const { fetch, requests } = mockFetch([{ path: "/3/search/tv", reply: { json: { results: [] } } }]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch });
    await client.searchShow("A");
    await client.searchShow("A");
    expect(requests).toHaveLength(2);
  });

  it("TVDB: concurrent identical searches send one request after one login", async () => {
    const g = gate({ json: { data: [{ tvdb_id: "81189", name: "Breaking Bad", year: "2008" }] } });
    const { fetch, requests } = mockFetch([TVDB_LOGIN, { path: "/v4/search", reply: g.reply }]);
    const client = new TVDBClient({ apiKey: "k", fetch });
    const searches = Array.from({ length: 6 }, () => client.searchShow("Breaking Bad"));
    // Let the login finish and the searches reach the request layer.
    await vi.waitFor(() => expect(requests.map((r) => r.url.pathname)).toContain("/v4/search"));
    g.release();
    await Promise.all(searches);
    expect(requests.map((r) => r.url.pathname)).toEqual(["/v4/login", "/v4/search"]);
  });

  it("MusicBrainz: concurrent identical lookups take one queue slot", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/ws/2/release", reply: { json: { releases: [{ id: "r1", title: "Album" }] } } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    const results = await Promise.all([
      client.searchRelease("Album", "Artist"),
      client.searchRelease("Album", "Artist"),
      client.searchRelease("Album", "Artist"),
    ]);
    expect(requests).toHaveLength(1);
    expect(results.map((r) => r[0]?.id)).toEqual(["r1", "r1", "r1"]);
  });
});

describe("parseRetryAfter", () => {
  it("reads delay-seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    expect(parseRetryAfter("Sat, 14 Nov 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Sat, 14 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for a missing or unusable value", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
  });
});

describe("429 retry (TMDB and TVDB)", () => {
  /** Replies 429 (with the given headers) `times` times, then 200. */
  function throttled(times: number, headers: Record<string, string> = {}, json: unknown = { results: [] }) {
    let count = 0;
    return (() => {
      count += 1;
      return count <= times ? { status: 429, headers } : { json };
    }) as MockReply;
  }

  it("waits as Retry-After asks, then succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: throttled(1, { "Retry-After": "2" }) }]);
    const search = new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Alien");

    await vi.advanceTimersByTimeAsync(1999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(search).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("waits 1 second when there is no Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: throttled(1) }]);
    const search = new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Alien");
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(search).resolves.toEqual([]);
  });

  it("gives up with RateLimitError after the retries run out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: throttled(99, { "Retry-After": "1" }) }]);
    const search = new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Alien");
    const outcome = expect(search).rejects.toBeInstanceOf(RateLimitError);
    await vi.advanceTimersByTimeAsync(5000);
    await outcome;
    expect(requests).toHaveLength(3); // the first try and 2 retries
  });

  it("does not wait out a Retry-After longer than the cap", async () => {
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: throttled(1, { "Retry-After": "120" }) }]);
    await expect(new TMDBClient({ apiKey: V3_KEY, fetch }).searchMovie("Alien")).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(requests).toHaveLength(1);
  });

  it("honors custom retry options", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: throttled(99, { "Retry-After": "20" }) }]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch, rateLimitRetry: { retries: 1, maxDelayMs: 30_000 } });
    const outcome = expect(client.searchMovie("Alien")).rejects.toBeInstanceOf(RateLimitError);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
    expect(requests).toHaveLength(2);
  });

  it("concurrent callers share one retrying request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: throttled(1, { "Retry-After": "1" }) }]);
    const client = new TMDBClient({ apiKey: V3_KEY, fetch });
    const searches = Promise.all([client.searchMovie("Alien"), client.searchMovie("Alien")]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(searches).resolves.toEqual([[], []]);
    expect(requests).toHaveLength(2);
  });

  it("TVDB retries a 429 too", async () => {
    const { fetch, requests } = mockFetch([
      TVDB_LOGIN,
      { path: "/v4/search", reply: throttled(2, { "Retry-After": "0" }, { data: [] }) },
    ]);
    const search = new TVDBClient({ apiKey: "k", fetch }).searchShow("x");
    await expect(search).resolves.toEqual([]);
    expect(requests.filter((r) => r.url.pathname === "/v4/search")).toHaveLength(3);
  });

  it("MusicBrainz is never retried, on 503 or 429", async () => {
    for (const [status, error] of [
      [503, RateLimitError],
      [429, ProviderError],
    ] as const) {
      const { fetch, requests } = mockFetch([{ path: /.*/, reply: { status, headers: { "Retry-After": "0" } } }]);
      const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
      await expect(client.searchRecording("x")).rejects.toBeInstanceOf(error);
      expect(requests).toHaveLength(1);
    }
  });
});

describe("MusicBrainz release tracks", () => {
  const credit = (name: string) => [{ name, artist: { id: `id-${name}`, name, "sort-name": name } }];
  const RELEASE = {
    id: "r1",
    title: "A Night at the Opera",
    date: "1975-11-21",
    "artist-credit": credit("Queen"),
    media: [
      {
        position: 1,
        "track-count": 2,
        tracks: [
          {
            id: "t1",
            position: 1,
            number: "1",
            title: "Death on Two Legs (Dedicated to...)",
            "artist-credit": credit("Queen"),
            recording: { id: "rec-a", title: "Death on Two Legs", length: 223000, "artist-credit": credit("Queen") },
          },
          { id: "t2", position: 2, title: "Track Only", "artist-credit": credit("Guest") },
        ],
      },
      { position: 2, tracks: [{ id: "t3", position: 1, title: "No Credits" }] },
    ],
  };

  it("parses tracks with recording titles and credits, disc and track numbers", () => {
    const tracks = parseReleaseTracks(RELEASE);
    expect(tracks.map((t) => [t.id, t.title, t.artist.name, t.discNumber, t.trackNumber])).toEqual([
      ["rec-a", "Death on Two Legs", "Queen", 1, 1],
      ["t2", "Track Only", "Guest", 1, 2],
      ["t3", "No Credits", "Queen", 2, 1],
    ]);
    expect(tracks[0]!.album?.title).toBe("A Night at the Opera");
    expect(tracks[0]!.durationMs).toBe(223000);
  });

  it("uses the same request as getRelease", async () => {
    const { fetch, requests } = mockFetch([{ path: "/ws/2/release/r1", reply: { json: RELEASE } }]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    await Promise.all([client.getReleaseTracks("r1"), client.getRelease("r1")]);
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({ inc: "artist-credits+recordings", fmt: "json" });
  });

  it("throws provider errors (getRelease returns undefined instead)", async () => {
    const { fetch } = mockFetch([]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    await expect(client.getReleaseTracks("missing")).rejects.toBeInstanceOf(ProviderError);
    expect(await client.getRelease("missing")).toBeUndefined();
  });
});
