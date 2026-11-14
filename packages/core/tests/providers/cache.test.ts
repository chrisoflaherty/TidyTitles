import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APICache,
  cacheKey,
  DEFAULT_CACHE_TTL_MS,
  formatPythonIsoDateTime,
  parsePythonIsoDateTime,
  pythonJsonDumps,
} from "../../src/providers/cache";

const HOUR = 60 * 60 * 1000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tidytitles-cache-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const entryFiles = () => readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("cache keys", () => {
  it("matches the Python key for a TMDB request", () => {
    // Computed with the Python implementation:
    // sha256('tmdb:/search/movie:' + json.dumps(params, sort_keys=True))[:16]
    expect(
      cacheKey("tmdb", "/search/movie", {
        query: "Alien",
        year: 1979,
        language: "en-US",
        api_key: "k",
      }),
    ).toBe("147046efd0064d7a");
  });

  it("matches Python json.dumps for non-ASCII and nested values", () => {
    const params = {
      query: 'recording:"Café ☕ 😀\u007f"',
      limit: "10",
      fmt: "json",
      nested: { b: [1, true, null], a: "x" },
    };
    expect(pythonJsonDumps(params)).toBe(
      '{"fmt": "json", "limit": "10", "nested": {"a": "x", "b": [1, true, null]}, ' +
        '"query": "recording:\\"Caf\\u00e9 \\u2615 \\ud83d\\ude00\\u007f\\""}',
    );
    expect(cacheKey("musicbrainz", "/recording", params as never)).toBe("ea2bff4e59804333");
  });

  it("does not depend on parameter order", () => {
    expect(cacheKey("p", "/e", { a: 1, b: "2" })).toBe(cacheKey("p", "/e", { b: "2", a: 1 }));
    expect(cacheKey("p", "/e", { a: 1 })).not.toBe(cacheKey("p", "/e", { a: "1" }));
    expect(cacheKey("p", "/e", { a: 1 })).not.toBe(cacheKey("q", "/e", { a: 1 }));
    expect(cacheKey("p", "/e", {})).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("timestamp helpers", () => {
  it("formats like Python datetime.isoformat() in local time", () => {
    expect(formatPythonIsoDateTime(new Date(2026, 10, 14, 10, 0, 0).getTime())).toBe(
      "2026-11-14T10:00:00",
    );
    expect(formatPythonIsoDateTime(new Date(2026, 10, 14, 10, 0, 0, 1).getTime())).toBe(
      "2026-11-14T10:00:00.001000",
    );
  });

  it("parses naive local, UTC, and offset timestamps", () => {
    const local = new Date(2026, 10, 14, 10, 0, 0, 1).getTime();
    expect(parsePythonIsoDateTime("2026-11-14T10:00:00.001500")).toBe(local);
    expect(parsePythonIsoDateTime("2026-11-14T10:00:00Z")).toBe(Date.UTC(2026, 10, 14, 10));
    expect(parsePythonIsoDateTime("2026-11-14T10:00:00+02:00")).toBe(Date.UTC(2026, 10, 14, 8));
    expect(parsePythonIsoDateTime("not a date")).toBeUndefined();
    expect(parsePythonIsoDateTime("2026-02-30T00:00:00")).toBeUndefined();
    expect(parsePythonIsoDateTime(42)).toBeUndefined();
  });
});

describe("APICache", () => {
  it("creates the cache directory", () => {
    const nested = path.join(dir, "a", "b");
    const cache = new APICache({ cacheDir: nested });
    expect(existsSync(nested)).toBe(true);
    expect(cache.cacheDir).toBe(nested);
    expect(cache.defaultTtlMs).toBe(DEFAULT_CACHE_TTL_MS);
    expect(DEFAULT_CACHE_TTL_MS).toBe(24 * HOUR);
  });

  it("round-trips a response", () => {
    const cache = new APICache({ cacheDir: dir });
    const response = { results: [{ id: 1, title: "Alien" }] };
    cache.set("tmdb", "/search/movie", { query: "Alien" }, response);

    expect(cache.get("tmdb", "/search/movie", { query: "Alien" })).toEqual(response);
    expect(cache.get("tmdb", "/search/movie", { query: "Aliens" })).toBeUndefined();
    expect(cache.get("tvdb", "/search/movie", { query: "Alien" })).toBeUndefined();
  });

  it("writes one Python-compatible JSON file per entry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0));
    const cache = new APICache({ cacheDir: dir });
    cache.set("tmdb", "/movie/1", { language: "en-US" }, { id: 1 });

    const key = cacheKey("tmdb", "/movie/1", { language: "en-US" });
    expect(entryFiles()).toEqual([`${key}.json`]);
    expect(JSON.parse(readFileSync(path.join(dir, `${key}.json`), "utf8"))).toEqual({
      response: { id: 1 },
      expires_at: "2026-11-15T10:00:00",
      cached_at: "2026-11-14T10:00:00",
      provider: "tmdb",
      endpoint: "/movie/1",
    });
  });

  it("reads entries written by the Python app", () => {
    const cache = new APICache({ cacheDir: dir });
    const key = cacheKey("tmdb", "/movie/1", {});
    writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({
        response: { id: 1 },
        expires_at: "2999-01-01T00:00:00.123456",
        cached_at: "2026-01-01T00:00:00.123456",
        provider: "tmdb",
        endpoint: "/movie/1",
      }),
    );
    expect(cache.get("tmdb", "/movie/1", {})).toEqual({ id: 1 });
  });

  it("expires entries after the default TTL and deletes them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0));
    const cache = new APICache({ cacheDir: dir });
    cache.set("tmdb", "/e", {}, "value");

    vi.setSystemTime(Date.now() + 24 * HOUR);
    expect(cache.get("tmdb", "/e", {})).toBe("value"); // not past expiry yet (strict >)

    vi.setSystemTime(Date.now() + 1000);
    expect(cache.get("tmdb", "/e", {})).toBeUndefined();
    expect(entryFiles()).toEqual([]);
  });

  it("honors a custom default TTL and a per-entry TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0));
    const cache = new APICache({ cacheDir: dir, defaultTtlMs: HOUR });
    cache.set("p", "/short", {}, 1);
    cache.set("p", "/long", {}, 2, 3 * HOUR);
    cache.set("p", "/zero", {}, 3, 0); // 0 falls back to the default, as in Python

    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect(cache.get("p", "/short", {})).toBeUndefined();
    expect(cache.get("p", "/zero", {})).toBeUndefined();
    expect(cache.get("p", "/long", {})).toBe(2);
  });

  it("treats a cached null as a miss", () => {
    const cache = new APICache({ cacheDir: dir });
    cache.set("p", "/e", {}, null);
    expect(cache.get("p", "/e", {})).toBeUndefined();
  });

  it("removes corrupt entries on read", () => {
    const cache = new APICache({ cacheDir: dir });
    const file = (endpoint: string) => path.join(dir, `${cacheKey("p", endpoint, {})}.json`);
    writeFileSync(file("/bad-json"), "{not json");
    writeFileSync(file("/no-expiry"), JSON.stringify({ response: 1 }));
    writeFileSync(file("/bad-expiry"), JSON.stringify({ response: 1, expires_at: "soon" }));
    writeFileSync(file("/no-response"), JSON.stringify({ expires_at: "2999-01-01T00:00:00" }));

    for (const endpoint of ["/bad-json", "/no-expiry", "/bad-expiry", "/no-response"]) {
      expect(cache.get("p", endpoint, {})).toBeUndefined();
      expect(existsSync(file(endpoint))).toBe(false);
    }
  });

  it("clears all entries or one provider's entries", () => {
    const cache = new APICache({ cacheDir: dir });
    cache.set("tmdb", "/a", {}, 1);
    cache.set("tmdb", "/b", {}, 2);
    cache.set("tvdb", "/a", {}, 3);
    writeFileSync(path.join(dir, "corrupt.json"), "{");
    writeFileSync(path.join(dir, "notes.txt"), "keep me");
    mkdirSync(path.join(dir, "folder.json"));

    // Corrupt entries are removed (and counted) even when filtering by provider.
    expect(cache.clear("tmdb")).toBe(3);
    expect(cache.get("tvdb", "/a", {})).toBe(3);
    expect(cache.clear()).toBe(1);
    expect(entryFiles()).toEqual(["folder.json"]);
    expect(existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("clears only expired and corrupt entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0));
    const cache = new APICache({ cacheDir: dir });
    cache.set("p", "/old", {}, 1, HOUR);
    cache.set("p", "/new", {}, 2, 5 * HOUR);
    writeFileSync(path.join(dir, "corrupt.json"), JSON.stringify({ response: 1 }));

    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect(cache.clearExpired()).toBe(2);
    expect(cache.get("p", "/new", {})).toBe(2);
    expect(entryFiles()).toHaveLength(1);
  });

  it("returns 0 when clearing an empty cache", () => {
    const cache = new APICache({ cacheDir: dir });
    expect(cache.clear()).toBe(0);
    expect(cache.clearExpired()).toBe(0);
  });
});
