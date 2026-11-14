import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, RateLimitError } from "../../src/errors";
import { APICache } from "../../src/providers/cache";
import {
  MusicBrainzClient,
  parseRecording,
  parseRelease,
} from "../../src/providers/musicbrainz";
import { mockFetch, queryOf } from "./mock-fetch";

// --- Ported from tests/test_musicbrainz.py -----------------------------------

describe("MusicBrainz response parsing", () => {
  it("parses a basic recording", () => {
    const track = parseRecording({
      id: "abc123",
      title: "Comfortably Numb",
      length: 382000,
      "artist-credit": [
        { artist: { id: "artist123", name: "Pink Floyd", "sort-name": "Pink Floyd" } },
      ],
    });

    expect(track.kind).toBe("track");
    expect(track.id).toBe("abc123");
    expect(track.title).toBe("Comfortably Numb");
    expect(track.artist.name).toBe("Pink Floyd");
    expect(track.artist.id).toBe("artist123");
    expect(track.durationMs).toBe(382000);
  });

  it("parses a recording with release (album) info", () => {
    const track = parseRecording({
      id: "abc123",
      title: "Comfortably Numb",
      "artist-credit": [{ artist: { id: "artist123", name: "Pink Floyd" } }],
      releases: [
        {
          id: "release123",
          title: "The Wall",
          date: "1979-11-30",
          "artist-credit": [{ artist: { id: "artist123", name: "Pink Floyd" } }],
        },
      ],
    });

    expect(track.album).toBeDefined();
    expect(track.album?.title).toBe("The Wall");
    expect(track.album?.year).toBe(1979);
  });

  it("parses a recording with no artist credit", () => {
    const track = parseRecording({ id: "abc123", title: "Unknown Track" });

    expect(track.title).toBe("Unknown Track");
    expect(track.artist.name).toBe("Unknown Artist");
  });

  it("parses a basic release", () => {
    const album = parseRelease({
      id: "release123",
      title: "The Wall",
      date: "1979-11-30",
      "track-count": 26,
      "artist-credit": [
        { artist: { id: "artist123", name: "Pink Floyd", "sort-name": "Pink Floyd" } },
      ],
    });

    expect(album.kind).toBe("album");
    expect(album.id).toBe("release123");
    expect(album.title).toBe("The Wall");
    expect(album.year).toBe(1979);
    expect(album.totalTracks).toBe(26);
    expect(album.artist.name).toBe("Pink Floyd");
  });

  it("parses a release with no date", () => {
    const album = parseRelease({
      id: "release123",
      title: "Unknown Album",
      "artist-credit": [{ artist: { id: "artist123", name: "Artist" } }],
    });

    expect(album.title).toBe("Unknown Album");
    expect(album.year).toBeUndefined();
  });

  it("sums track counts across media", () => {
    const album = parseRelease({
      id: "release123",
      title: "Double Album",
      "artist-credit": [{ artist: { id: "artist123", name: "Artist" } }],
      media: [{ "track-count": 12 }, { "track-count": 14 }],
    });

    expect(album.totalTracks).toBe(26);
  });
});

describe("MusicBrainz client constants", () => {
  it("has the correct base URL", () => {
    expect(MusicBrainzClient.BASE_URL).toBe("https://musicbrainz.org/ws/2");
  });

  it("has the correct provider name", () => {
    expect(MusicBrainzClient.PROVIDER_NAME).toBe("musicbrainz");
  });

  it("sets a User-Agent (required by MusicBrainz)", () => {
    expect(MusicBrainzClient.USER_AGENT).toBeTruthy();
    expect(MusicBrainzClient.USER_AGENT).toContain("TidyTitles");
    expect(MusicBrainzClient.USER_AGENT).not.toMatch(/@/);
  });
});

describe("MusicBrainz client initialization", () => {
  it("defaults to a 1 second rate limit", () => {
    expect(new MusicBrainzClient().rateLimitDelayMs).toBe(1000);
  });

  it("accepts a custom rate limit", () => {
    expect(new MusicBrainzClient({ rateLimitDelayMs: 2000 }).rateLimitDelayMs).toBe(2000);
  });

  it("makes no request until a method is called", () => {
    // Python: the httpx client was not created before entering the context.
    const { mock, fetch } = mockFetch([]);
    new MusicBrainzClient({ fetch });
    expect(mock).not.toHaveBeenCalled();
  });
});

// --- Additional parsing rules ------------------------------------------------

describe("MusicBrainz parsing details", () => {
  it("uses only the first artist credit and keeps sort name and disambiguation", () => {
    const track = parseRecording({
      id: "r1",
      title: "Under Pressure",
      "artist-credit": [
        {
          artist: { id: "a1", name: "Queen", "sort-name": "Queen", disambiguation: "UK rock group" },
          joinphrase: " & ",
        },
        { artist: { id: "a2", name: "David Bowie" } },
      ],
    });
    expect(track.artist).toEqual({
      kind: "artist",
      id: "a1",
      name: "Queen",
      sortName: "Queen",
      disambiguation: "UK rock group",
      provider: "musicbrainz",
    });
  });

  it("drops artist disambiguation on releases", () => {
    const album = parseRelease({
      id: "x",
      title: "T",
      "artist-credit": [{ artist: { id: "a", name: "N", disambiguation: "d" } }],
    });
    expect(album.artist.disambiguation).toBeUndefined();
  });

  it("defaults missing artist fields", () => {
    const track = parseRecording({ id: "r", title: "t", "artist-credit": [{}] });
    expect(track.artist.id).toBe("");
    expect(track.artist.name).toBe("Unknown Artist");
  });

  it("finds the track number from the first release's media", () => {
    const track = parseRecording({
      id: "rec-2",
      title: "Song",
      releases: [
        {
          id: "rel",
          title: "Album",
          media: [
            { tracks: [{ position: 1, recording: { id: "rec-1" } }] },
            {
              tracks: [
                { position: 1, recording: { id: "other" } },
                { position: 4, recording: { id: "rec-2" } },
              ],
            },
          ],
        },
        { id: "second", title: "Ignored" },
      ],
    });
    expect(track.trackNumber).toBe(4);
    expect(track.album?.id).toBe("rel");
    expect(track.album?.provider).toBe("musicbrainz");
    expect(track.genres).toEqual([]);
  });

  it("leaves track number undefined when the recording is not in the media", () => {
    const track = parseRecording({
      id: "rec",
      title: "Song",
      releases: [{ id: "rel", title: "Album", media: [{ tracks: [] }] }],
    });
    expect(track.trackNumber).toBeUndefined();
  });

  it("extracts the year from partial and invalid dates", () => {
    expect(parseRelease({ id: "a", title: "t", date: "1979" }).year).toBe(1979);
    expect(parseRelease({ id: "a", title: "t", date: "19xx-01-01" }).year).toBeUndefined();
    expect(parseRelease({ id: "a", title: "t", date: "" }).year).toBeUndefined();
    expect(parseRelease({ id: "a", title: "t", date: null }).year).toBeUndefined();
  });

  it("prefers track-count over media counts", () => {
    const album = parseRelease({
      id: "a",
      title: "t",
      "track-count": 10,
      media: [{ "track-count": 3 }],
    });
    expect(album.totalTracks).toBe(10);
  });

  it("leaves totalTracks undefined without any counts", () => {
    expect(parseRelease({ id: "a", title: "t", media: [{}] }).totalTracks).toBeUndefined();
  });

  it("defaults missing id and title to empty strings", () => {
    const album = parseRelease({});
    expect(album.id).toBe("");
    expect(album.title).toBe("");
    expect(album.artist.name).toBe("Unknown Artist");
  });
});

// --- HTTP behavior -----------------------------------------------------------

const RECORDING = {
  id: "rec-1",
  title: "Comfortably Numb",
  length: 382000,
  "artist-credit": [{ artist: { id: "a1", name: "Pink Floyd" } }],
};

describe("MusicBrainz HTTP requests", () => {
  it("builds the recording search query and sends the User-Agent", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [RECORDING] } } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });

    const tracks = await client.searchRecording("Comfortably Numb", "Pink Floyd", "The Wall");

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.title).toBe("Comfortably Numb");
    const [request] = requests;
    expect(request?.url.origin).toBe("https://musicbrainz.org");
    expect(queryOf(request!)).toEqual({
      query: 'recording:"Comfortably Numb" AND artist:"Pink Floyd" AND release:"The Wall"',
      limit: "10",
      fmt: "json",
    });
    expect(request?.headers["user-agent"]).toBe(MusicBrainzClient.USER_AGENT);
    expect(request?.headers.accept).toBe("application/json");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits optional search terms", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [] } } },
      { path: "/ws/2/release", reply: { json: { releases: [] } } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });

    expect(await client.searchRecording("Song")).toEqual([]);
    expect(await client.searchRelease("Album")).toEqual([]);
    expect(queryOf(requests[0]!).query).toBe('recording:"Song"');
    expect(queryOf(requests[1]!).query).toBe('release:"Album"');
  });

  it("builds the release search query", async () => {
    const { fetch, requests } = mockFetch([
      {
        path: "/ws/2/release",
        reply: { json: { releases: [{ id: "rel", title: "The Wall", "track-count": 26 }] } },
      },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });

    const albums = await client.searchRelease("The Wall", "Pink Floyd");

    expect(albums.map((a) => a.totalTracks)).toEqual([26]);
    expect(queryOf(requests[0]!).query).toBe('release:"The Wall" AND artist:"Pink Floyd"');
  });

  it("returns empty results when the list is missing", async () => {
    const { fetch } = mockFetch([{ path: "/ws/2/recording", reply: { json: {} } }]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    expect(await client.searchRecording("x")).toEqual([]);
  });

  it("looks up a recording with artist credits and releases", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/ws/2/recording/rec-1", reply: { json: RECORDING } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });

    const track = await client.getRecording("rec-1");

    expect(track?.id).toBe("rec-1");
    expect(queryOf(requests[0]!)).toEqual({ inc: "artist-credits+releases", fmt: "json" });
  });

  it("looks up a release with artist credits and recordings", async () => {
    const { fetch, requests } = mockFetch([
      { path: "/ws/2/release/rel-1", reply: { json: { id: "rel-1", title: "The Wall" } } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });

    const album = await client.getRelease("rel-1");

    expect(album?.title).toBe("The Wall");
    expect(queryOf(requests[0]!)).toEqual({ inc: "artist-credits+recordings", fmt: "json" });
  });

  it("returns undefined from lookups on provider errors", async () => {
    const { fetch } = mockFetch([{ path: /.*/, reply: { status: 404 } }]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    expect(await client.getRecording("missing")).toBeUndefined();
    expect(await client.getRelease("missing")).toBeUndefined();
  });

  it("maps 503 to RateLimitError", async () => {
    const { fetch } = mockFetch([{ path: /.*/, reply: { status: 503 } }]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    await expect(client.searchRecording("x")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps other HTTP failures to ProviderError", async () => {
    const { fetch } = mockFetch([{ path: /.*/, reply: { status: 500 } }]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    const error = await client.searchRelease("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as Error).message).toBe("MusicBrainz API error: 500");
  });

  it("maps network failures and invalid JSON to ProviderError", async () => {
    const network = mockFetch([{ path: /.*/, reply: new TypeError("fetch failed") }]);
    const a = new MusicBrainzClient({ fetch: network.fetch, rateLimitDelayMs: 0 });
    await expect(a.searchRecording("x")).rejects.toBeInstanceOf(ProviderError);

    const badJson = mockFetch([{ path: /.*/, reply: { body: "<html>" } }]);
    const b = new MusicBrainzClient({ fetch: badJson.fetch, rateLimitDelayMs: 0 });
    await expect(b.searchRecording("x")).rejects.toThrow(/invalid JSON/);
  });

  it("rejects malformed payloads with ProviderError", async () => {
    const { fetch } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: "nope" } } },
      { path: "/ws/2/release", reply: { json: [1, 2] } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 0 });
    await expect(client.searchRecording("x")).rejects.toBeInstanceOf(ProviderError);
    await expect(client.searchRelease("x")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("MusicBrainz rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits at least the delay between consecutive requests", async () => {
    const { fetch, mock } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [] } } },
    ]);
    const client = new MusicBrainzClient({ fetch });

    await client.searchRecording("first");
    expect(mock).toHaveBeenCalledTimes(1);

    const second = client.searchRecording("second");
    await vi.advanceTimersByTimeAsync(999);
    expect(mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not wait when enough time has passed", async () => {
    const { fetch, mock } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [] } } },
    ]);
    const client = new MusicBrainzClient({ fetch });

    await client.searchRecording("first");
    vi.setSystemTime(Date.now() + 1500);
    await client.searchRecording("second");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("only waits the remaining part of the delay", async () => {
    const { fetch, mock } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [] } } },
    ]);
    const client = new MusicBrainzClient({ fetch, rateLimitDelayMs: 2000 });

    await client.searchRecording("first");
    vi.setSystemTime(Date.now() + 1500);
    const second = client.searchRecording("second");
    await vi.advanceTimersByTimeAsync(499);
    expect(mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("spaces out concurrent requests", async () => {
    const { fetch, mock } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [] } } },
    ]);
    const client = new MusicBrainzClient({ fetch });

    const all = Promise.all([
      client.searchRecording("a"),
      client.searchRecording("b"),
      client.searchRecording("c"),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock).toHaveBeenCalledTimes(3);
    await all;
  });

  it("keeps spacing requests after a failed one", async () => {
    let calls = 0;
    const { fetch, mock } = mockFetch([
      {
        path: "/ws/2/recording",
        reply: () => (++calls === 1 ? { status: 503 } : { json: { recordings: [] } }),
      },
    ]);
    const client = new MusicBrainzClient({ fetch });

    await expect(client.searchRecording("a")).rejects.toBeInstanceOf(RateLimitError);
    const next = client.searchRecording("b");
    await vi.advanceTimersByTimeAsync(999);
    expect(mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("MusicBrainz caching", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tidytitles-mb-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves repeated searches from the cache", async () => {
    const { fetch, mock } = mockFetch([
      { path: "/ws/2/recording", reply: { json: { recordings: [RECORDING] } } },
    ]);
    const cache = new APICache({ cacheDir: dir });
    const client = new MusicBrainzClient({ fetch, cache, rateLimitDelayMs: 0 });

    const first = await client.searchRecording("Comfortably Numb", "Pink Floyd");
    const second = await client.searchRecording("Comfortably Numb", "Pink Floyd");

    expect(mock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(cache.get("musicbrainz", "/recording", {
      query: 'recording:"Comfortably Numb" AND artist:"Pink Floyd"',
      limit: "10",
      fmt: "json",
    })).toEqual({ recordings: [RECORDING] });
  });

  it("does not cache error responses", async () => {
    const { fetch, mock } = mockFetch([{ path: /.*/, reply: { status: 500 } }]);
    const cache = new APICache({ cacheDir: dir });
    const client = new MusicBrainzClient({ fetch, cache, rateLimitDelayMs: 0 });

    await expect(client.searchRelease("x")).rejects.toBeInstanceOf(ProviderError);
    await expect(client.searchRelease("x")).rejects.toBeInstanceOf(ProviderError);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
