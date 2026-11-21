/**
 * TMDB metadata language, DVD episode groups, absolute numbers, and air
 * dates, against a scripted TMDB (no network).
 */

import { describe, expect, it } from "vitest";
import { EpisodeOrderUnavailableError } from "../../src/errors";
import { cacheKey } from "../../src/providers/cache";
import { isPlaceholderEpisodeName, TMDBClient, type TMDBClientOptions } from "../../src/providers/tmdb";
import { mockFetch, queryOf, type RecordedRequest, type Route } from "./mock-fetch";

const KEY = "v3-key";

interface TmdbEp {
  episode_number: number;
  name?: string;
  air_date?: string;
}

/** Seasons by language ("en-US" is the fallback); episode groups by type. */
function tmdb(options: {
  show?: Record<string, unknown>;
  seasons: Record<number, { air_date?: string; episodes: Record<string, TmdbEp[]> }>;
  groups?: Array<{ type: number; episode_count?: number; groups: Array<{ name: string; order: number; episodes: Array<{ season_number: number; episode_number: number; order: number }> }> }>;
}) {
  const show = {
    id: 1,
    name: "Show",
    original_name: "Show",
    original_language: "en",
    first_air_date: "2010-01-01",
    seasons: Object.entries(options.seasons).map(([n, s]) => ({
      season_number: Number(n),
      air_date: s.air_date,
      episode_count: (s.episodes["en-US"] ?? Object.values(s.episodes)[0] ?? []).length,
    })),
    ...options.show,
  };
  const routes: Route[] = [
    { path: "/3/tv/1", reply: { json: show } },
    {
      path: /^\/3\/tv\/1\/season\/\d+$/,
      reply: (r) => {
        const n = Number(r.url.pathname.split("/").pop());
        const lang = queryOf(r).language!;
        const season = options.seasons[n];
        if (!season) return { status: 404, json: {} };
        const episodes = season.episodes[lang] ?? season.episodes["en-US"] ?? [];
        return { json: { season_number: n, episodes: episodes.map((e) => ({ ...e, season_number: n })) } };
      },
    },
    {
      path: "/3/tv/1/episode_groups",
      reply: {
        json: {
          id: 1,
          results: (options.groups ?? []).map((g, i) => ({ id: `g${i}`, type: g.type, episode_count: g.episode_count ?? 0 })),
        },
      },
    },
    {
      path: /^\/3\/tv\/episode_group\/g\d+$/,
      reply: (r) => {
        const i = Number(r.url.pathname.split("/").pop()!.slice(1));
        return { json: { id: `g${i}`, groups: options.groups![i]!.groups } };
      },
    },
  ];
  return mockFetch(routes);
}

const client = (fetch: TMDBClientOptions["fetch"], options: Partial<TMDBClientOptions> = {}) =>
  new TMDBClient({ apiKey: KEY, fetch, ...options });

const paths = (requests: RecordedRequest[]) => requests.map((r) => `${r.url.pathname}?language=${queryOf(r).language}`);

const eps = (count: number, prefix: string, start = "2010-01-01"): TmdbEp[] =>
  Array.from({ length: count }, (_, i) => ({ episode_number: i + 1, name: `${prefix}${i + 1}`, air_date: start }));

describe("TMDB metadata language", () => {
  it("sends the language with every request and keys the cache by it", async () => {
    const { fetch, requests } = tmdb({ seasons: { 1: { episodes: { "de-DE": eps(2, "Folge Name ") } } } });
    const episode = await client(fetch, { language: "de-DE" }).getEpisode(1, 1, 2);
    expect(episode?.title).toBe("Folge Name 2");
    expect(requests.every((r) => queryOf(r).language === "de-DE")).toBe(true);
    expect(cacheKey("tmdb", "/tv/1/season/1", { language: "de-DE" })).not.toBe(
      cacheKey("tmdb", "/tv/1/season/1", { language: "en-US" }),
    );
  });

  it("falls back to the English name for a missing or placeholder episode name", async () => {
    const { fetch, requests } = tmdb({
      seasons: {
        1: {
          episodes: {
            "de-DE": [
              { episode_number: 1, name: "Folge 1" },
              { episode_number: 2, name: "" },
              { episode_number: 3, name: "Echter Titel" },
              { episode_number: 4 },
            ],
            "en-US": [
              { episode_number: 1, name: "Pilot" },
              { episode_number: 2, name: "Second" },
              { episode_number: 3, name: "Real Title" },
              { episode_number: 4, name: "Episode 4" },
            ],
          },
        },
      },
    });
    const c = client(fetch, { language: "de-DE" });
    expect((await c.getEpisode(1, 1, 1))?.title).toBe("Pilot");
    expect((await c.getEpisode(1, 1, 2))?.title).toBe("Second");
    expect((await c.getEpisode(1, 1, 3))?.title).toBe("Echter Titel");
    // Nothing better anywhere: TMDB's own placeholder, never empty.
    expect((await c.getEpisode(1, 1, 4))?.title).toBe("Episode 4");
    // Each season is fetched once per language.
    expect(paths(requests).filter((p) => p.startsWith("/3/tv/1/season/1"))).toEqual([
      "/3/tv/1/season/1?language=de-DE",
      "/3/tv/1/season/1?language=en-US",
    ]);
  });

  it("recognizes generated episode names", () => {
    expect(isPlaceholderEpisodeName("Episode 5", 5)).toBe(true);
    expect(isPlaceholderEpisodeName("Folge 5", 5)).toBe(true);
    expect(isPlaceholderEpisodeName("Épisode 05", 5)).toBe(true);
    expect(isPlaceholderEpisodeName("第5話", 5)).toBe(true);
    expect(isPlaceholderEpisodeName("Episode 5", 6)).toBe(false);
    expect(isPlaceholderEpisodeName("Chapter 5", 5)).toBe(false);
    expect(isPlaceholderEpisodeName("Pilot", 1)).toBe(false);
  });

  it("uses the English title for an untranslated movie, else the original", async () => {
    const { fetch, requests } = mockFetch([
      {
        path: "/3/search/movie",
        reply: (r) =>
          queryOf(r).language === "de-DE"
            ? {
                json: {
                  results: [
                    { id: 1, title: "千と千尋の神隠し", original_title: "千と千尋の神隠し", original_language: "ja" },
                    { id: 2, title: "Die Reise", original_title: "The Trip", original_language: "en" },
                    { id: 3, title: "", original_title: "Orig", original_language: "fr" },
                  ],
                },
              }
            : { json: { results: [{ id: 1, title: "Spirited Away" }, { id: 3, title: "" }] } },
      },
    ]);
    const movies = await client(fetch, { language: "de-DE" }).searchMovie("x");
    expect(movies.map((m) => m.title)).toEqual(["Spirited Away", "Die Reise", "Orig"]);
    expect(movies[0]?.originalTitle).toBe("千と千尋の神隠し");
    expect(requests).toHaveLength(2);
  });

  it("sends no English request when nothing needs it, or for an English user", async () => {
    const results = { results: [{ id: 1, title: "千と千尋の神隠し", original_title: "千と千尋の神隠し", original_language: "ja" }] };
    const english = mockFetch([{ path: "/3/search/movie", reply: { json: results } }]);
    await client(english.fetch).searchMovie("x");
    expect(english.requests).toHaveLength(1);
    const translated = mockFetch([
      { path: "/3/search/movie", reply: { json: { results: [{ id: 1, title: "Chihiros Reise", original_title: "千と千尋の神隠し", original_language: "ja" }] } } },
    ]);
    expect((await client(translated.fetch, { language: "de-DE" }).searchMovie("x"))[0]?.title).toBe("Chihiros Reise");
    expect(translated.requests).toHaveLength(1);
  });

  it("uses the English show name for an untranslated show", async () => {
    const { fetch } = mockFetch([
      {
        path: "/3/tv/9",
        reply: (r) => ({
          json: {
            id: 9,
            name: queryOf(r).language === "en-US" ? "Attack on Titan" : "進撃の巨人",
            original_name: "進撃の巨人",
            original_language: "ja",
          },
        }),
      },
    ]);
    const show = await client(fetch, { language: "de-DE" }).getShow(9);
    expect(show).toMatchObject({ title: "Attack on Titan", originalTitle: "進撃の巨人" });
  });
});

describe("TMDB episode orders", () => {
  const seasons = {
    0: { air_date: "2009-12-01", episodes: { "en-US": eps(1, "Special ") } },
    1: { air_date: "2010-01-01", episodes: { "en-US": eps(3, "One-") } },
    2: { air_date: "2011-01-01", episodes: { "en-US": eps(3, "Two-") } },
  };
  const dvdGroup = {
    type: 3,
    episode_count: 6,
    groups: [
      { name: "Specials", order: 0, episodes: [{ season_number: 0, episode_number: 1, order: 0 }] },
      {
        name: "Disc Season 1",
        order: 1,
        episodes: [
          { season_number: 1, episode_number: 2, order: 0 },
          { season_number: 1, episode_number: 1, order: 1 },
        ],
      },
      { name: "Disc Season 2", order: 2, episodes: [{ season_number: 1, episode_number: 3, order: 0 }] },
    ],
  };

  it("maps DVD numbers through the DVD episode group, with titles from the aired season", async () => {
    const { fetch, requests } = tmdb({ seasons, groups: [{ type: 1, episode_count: 99, groups: [] }, dvdGroup] });
    const c = client(fetch, { episodeOrder: "dvd" });
    expect(await c.getEpisode(1, 1, 1)).toMatchObject({ season: 1, episode: 1, title: "One-2" });
    expect(await c.getEpisode(1, 2, 1)).toMatchObject({ season: 2, episode: 1, title: "One-3" });
    expect(await c.getEpisode(1, 0, 1)).toMatchObject({ season: 0, episode: 1, title: "Special 1" });
    expect(await c.getEpisode(1, 1, 9)).toBeUndefined();
    expect(paths(requests).filter((p) => p.startsWith("/3/tv/episode_group/"))).toEqual([
      "/3/tv/episode_group/g1?language=en-US",
    ]);
  });

  it("reports a show without a DVD group as order_unavailable", async () => {
    const { fetch } = tmdb({ seasons });
    const error = await client(fetch, { episodeOrder: "dvd" }).getEpisode(1, 1, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EpisodeOrderUnavailableError);
    expect(error).toMatchObject({ provider: "tmdb", order: "dvd" });
  });

  it("ignores Absolute episode groups: they are community lists, and many reorder the show", async () => {
    // Like Detective Conan's only Absolute group (a reordered Chinese release).
    const reordered = {
      type: 2,
      groups: [
        { name: "Season 01", order: 1, episodes: [{ season_number: 2, episode_number: 3, order: 0 }, { season_number: 1, episode_number: 1, order: 1 }] },
      ],
    };
    const { fetch, requests } = tmdb({ seasons, groups: [reordered] });
    expect(await client(fetch).getEpisodeByAbsoluteNumber(1, 1)).toMatchObject({ season: 1, episode: 1, absoluteNumber: 1 });
    expect(await client(fetch, { episodeOrder: "absolute" }).getEpisode(1, 1, 4)).toMatchObject({
      season: 1,
      episode: 4,
      title: "Two-1",
    });
    expect(requests.some((r) => r.url.pathname.includes("episode_group"))).toBe(false);
  });

  it("counts by position when a show keeps numbering across seasons", async () => {
    // Like One Piece, whose season 22 starts at episode 1089.
    const continuing = {
      1: { episodes: { "en-US": eps(3, "One-") } },
      2: {
        episodes: {
          "en-US": [
            { episode_number: 4, name: "Two-4" },
            { episode_number: 5, name: "Two-5" },
          ],
        },
      },
    };
    const { fetch } = tmdb({ seasons: continuing });
    const c = client(fetch);
    expect(await c.getEpisodeByAbsoluteNumber(1, 4)).toMatchObject({ season: 2, episode: 4, title: "Two-4", absoluteNumber: 4 });
    expect(await c.getEpisodeByAbsoluteNumber(1, 5)).toMatchObject({ season: 2, episode: 5 });
    expect(await c.getEpisodeByAbsoluteNumber(1, 6)).toBeUndefined();
    expect(await c.getEpisodeByAbsoluteNumber(1, 0)).toBeUndefined();
  });

  it("counts aired episodes for absolute numbers when there is no group (specials left out)", async () => {
    const { fetch } = tmdb({ seasons });
    const c = client(fetch);
    expect(await c.getEpisodeByAbsoluteNumber(1, 4)).toMatchObject({ season: 2, episode: 1, title: "Two-1" });
    expect(await c.getEpisodeByAbsoluteNumber(1, 3)).toMatchObject({ season: 1, episode: 3 });
    expect(await c.getEpisodeByAbsoluteNumber(1, 7)).toBeUndefined();
  });

  it("names an absolute number in DVD order through the DVD group", async () => {
    const { fetch } = tmdb({ seasons, groups: [dvdGroup] });
    expect(await client(fetch, { episodeOrder: "dvd" }).getEpisodeByAbsoluteNumber(1, 3)).toMatchObject({
      season: 2,
      episode: 1,
      title: "One-3",
    });
  });
});

describe("TMDB air dates", () => {
  it("checks the latest season that started on or before the date, then earlier ones", async () => {
    const { fetch, requests } = tmdb({
      seasons: {
        1: { air_date: "2023-09-01", episodes: { "en-US": [{ episode_number: 120, name: "March", air_date: "2024-03-15" }] } },
        2: { air_date: "2024-09-01", episodes: { "en-US": [{ episode_number: 1, name: "Fall", air_date: "2024-09-01" }] } },
      },
    });
    const c = client(fetch);
    expect(await c.getEpisodeByAirDate(1, "2024-03-15")).toMatchObject({ season: 1, episode: 120, title: "March" });
    expect(await c.getEpisodeByAirDate(1, "2024-09-01")).toMatchObject({ season: 2, episode: 1 });
    expect(await c.getEpisodeByAirDate(1, "2020-01-01")).toBeUndefined();
    expect(paths(requests).filter((p) => p.startsWith("/3/tv/1/season/"))).toEqual([
      "/3/tv/1/season/1?language=en-US",
      "/3/tv/1/season/2?language=en-US",
    ]);
  });

  it("looks in the specials last", async () => {
    const { fetch } = tmdb({
      seasons: {
        0: { episodes: { "en-US": [{ episode_number: 3, name: "Special", air_date: "2024-12-24" }] } },
        1: { air_date: "2024-01-01", episodes: { "en-US": eps(2, "E", "2024-01-08") } },
      },
    });
    expect(await client(fetch).getEpisodeByAirDate(1, "2024-12-24")).toMatchObject({ season: 0, episode: 3 });
  });
});
