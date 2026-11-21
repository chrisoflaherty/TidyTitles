/**
 * TVDB episode orders, pagination, air dates, absolute numbers, and
 * translations, against a scripted TVDB (no network).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EpisodeOrderUnavailableError, RateLimitError } from "../../src/errors";
import { APICache } from "../../src/providers/cache";
import { TVDBClient, type TVDBClientOptions } from "../../src/providers/tvdb";
import { mockFetch, queryOf, type RecordedRequest, type Route } from "./mock-fetch";

const LOGIN: Route = { method: "POST", path: "/v4/login", reply: { json: { data: { token: "t" } } } };

interface Ep {
  id: number;
  seasonNumber: number;
  number: number;
  name?: string | null;
  aired?: string;
  absoluteNumber?: number;
  nameTranslations?: string[];
}

/** A scripted show: listings per season type, paged; translations by language. */
function tvdb(options: {
  series?: Record<string, unknown>;
  listings: Record<string, Ep[]>;
  pageSize?: number;
  /** Episode names in other languages: language -> id -> name. */
  episodeNames?: Record<string, Record<number, string | null>>;
  /** Series names in other languages. */
  seriesNames?: Record<string, string>;
  /** When false, translated listings carry no `episodes` (as the swagger documents). */
  translatedListings?: boolean;
}) {
  const pageSize = options.pageSize ?? 500;
  const series = { id: 100, name: "Show", year: "2010", originalLanguage: "eng", nameTranslations: ["eng"], ...options.series };
  const page = (all: Ep[], request: RecordedRequest, lang?: string) => {
    const q = queryOf(request);
    let rows = all;
    if (q.season !== undefined) rows = rows.filter((e) => e.seasonNumber === Number(q.season));
    if (q.airDate !== undefined) rows = rows.filter((e) => e.aired === q.airDate);
    const n = Number(q.page ?? 0);
    const slice = rows.slice(n * pageSize, (n + 1) * pageSize).map((e) =>
      lang ? { ...e, name: options.episodeNames?.[lang]?.[e.id] ?? null } : e,
    );
    const more = (n + 1) * pageSize < rows.length;
    return {
      json: {
        status: "success",
        data: lang && options.translatedListings === false ? { series } : { series, episodes: slice },
        links: { prev: null, self: "x", next: more ? `x?page=${n + 1}` : null, total_items: rows.length, page_size: pageSize },
      },
    };
  };
  const routes: Route[] = [
    LOGIN,
    { path: "/v4/series/100", reply: { json: { data: series } } },
    {
      path: /^\/v4\/series\/100\/translations\/\w+$/,
      reply: (r) => {
        const lang = r.url.pathname.split("/").pop()!;
        const name = options.seriesNames?.[lang];
        return name ? { json: { data: { name, language: lang } } } : { status: 404, json: {} };
      },
    },
    {
      path: /^\/v4\/episodes\/\d+\/translations\/\w+$/,
      reply: (r) => {
        const parts = r.url.pathname.split("/");
        const name = options.episodeNames?.[parts[5]!]?.[Number(parts[3])];
        return name ? { json: { data: { name } } } : { status: 404, json: {} };
      },
    },
    {
      path: /^\/v4\/series\/100\/episodes\/\w+(\/\w+)?$/,
      reply: (r) => {
        const [, , , , , type, lang] = r.url.pathname.split("/");
        return page(options.listings[type!] ?? [], r, lang);
      },
    },
  ];
  return mockFetch(routes);
}

const client = (fetch: TVDBClientOptions["fetch"], options: Partial<TVDBClientOptions> = {}) =>
  new TVDBClient({ apiKey: "k", fetch, ...options });

const paths = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === "GET").map((r) => `${r.url.pathname}${r.url.search}`);

const season = (s: number, count: number, startId = s * 1000, startAbs = 0): Ep[] =>
  Array.from({ length: count }, (_, i) => ({
    id: startId + i + 1,
    seasonNumber: s,
    number: i + 1,
    name: `S${s}E${i + 1}`,
    aired: `2010-0${s}-${String(i + 1).padStart(2, "0")}`,
    ...(startAbs ? { absoluteNumber: startAbs + i } : {}),
  }));

describe("TVDB episode orders", () => {
  const official = [...season(0, 2), ...season(1, 3, 1000, 1), ...season(2, 3, 2000, 4)];
  const dvd = [
    { id: 1001, seasonNumber: 1, number: 2, name: "S1E1" },
    { id: 1002, seasonNumber: 1, number: 1, name: "S1E2" },
  ];

  it("reads aired numbers from the official listing", async () => {
    const { fetch, requests } = tvdb({ listings: { official } });
    const episode = await client(fetch).getEpisode(100, 2, 3);
    expect(episode).toMatchObject({ season: 2, episode: 3, title: "S2E3", airDate: "2010-02-03" });
    expect(paths(requests)).toContain("/v4/series/100/episodes/official?page=0&season=2");
  });

  it("finds specials in season 0", async () => {
    const { fetch } = tvdb({ listings: { official } });
    expect(await client(fetch).getEpisode(100, 0, 2)).toMatchObject({ season: 0, episode: 2, title: "S0E2" });
    const absolute = tvdb({ listings: { official } });
    // Specials keep aired numbers in absolute order.
    expect(await client(absolute.fetch, { episodeOrder: "absolute" }).getEpisode(100, 0, 1)).toMatchObject({
      season: 0,
      episode: 1,
    });
  });

  it("reads DVD numbers from the dvd listing", async () => {
    const { fetch, requests } = tvdb({ listings: { official, dvd } });
    const episode = await client(fetch, { episodeOrder: "dvd" }).getEpisode(100, 1, 1);
    expect(episode).toMatchObject({ season: 1, episode: 1, title: "S1E2" });
    expect(paths(requests)).toContain("/v4/series/100/episodes/dvd?page=0&season=1");
  });

  it("reports a show with no DVD order as order_unavailable, not as no match", async () => {
    const { fetch } = tvdb({ listings: { official } });
    const error = await client(fetch, { episodeOrder: "dvd" }).getEpisode(100, 1, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EpisodeOrderUnavailableError);
    expect(error).toMatchObject({ provider: "tvdb", order: "dvd" });
  });

  it("in absolute order, the episode number is the absolute number, named in season 1", async () => {
    const absolute = [{ id: 2002, seasonNumber: 1, number: 5, name: "Abs five" }];
    const { fetch } = tvdb({ listings: { official, absolute } });
    expect(await client(fetch, { episodeOrder: "absolute" }).getEpisode(100, 1, 5)).toMatchObject({
      season: 1,
      episode: 5,
      absoluteNumber: 5,
      title: "Abs five",
    });
  });

  it("reads every page of a long season, and each page once per run", async () => {
    const long = season(1, 1200);
    const { fetch, requests } = tvdb({ listings: { official: long } });
    const c = client(fetch);
    const [a, b] = await Promise.all([c.getEpisode(100, 1, 1100), c.getEpisode(100, 1, 3)]);
    expect(a?.title).toBe("S1E1100");
    expect(b?.title).toBe("S1E3");
    await c.getEpisode(100, 1, 7);
    const pages = paths(requests).filter((p) => p.includes("/episodes/official"));
    expect(pages).toEqual([
      "/v4/series/100/episodes/official?page=0&season=1",
      "/v4/series/100/episodes/official?page=1&season=1",
      "/v4/series/100/episodes/official?page=2&season=1",
    ]);
    expect(paths(requests).filter((p) => p === "/v4/series/100")).toHaveLength(1);
  });

  it("stops at the page limit", async () => {
    const { fetch, requests } = tvdb({ listings: { official: season(1, 300) }, pageSize: 1 });
    await client(fetch).getEpisode(100, 1, 300);
    expect(paths(requests).filter((p) => p.includes("/episodes/official"))).toHaveLength(100);
  });

  it("still reports rate limiting from a listing", async () => {
    const { fetch } = mockFetch([
      LOGIN,
      { path: "/v4/series/100", reply: { json: { data: { id: 100, name: "Show", originalLanguage: "eng" } } } },
      { path: "/v4/series/100/episodes/official", reply: { status: 400, json: {} } },
    ]);
    expect(await client(fetch).getEpisode(100, 1, 1)).toBeUndefined();
    const limited = mockFetch([
      LOGIN,
      { path: "/v4/series/100", reply: { json: { data: { id: 100, name: "Show", originalLanguage: "eng" } } } },
      { path: "/v4/series/100/episodes/official", reply: { status: 429, json: {} } },
    ]);
    await expect(
      client(limited.fetch, { rateLimitRetry: { retries: 0 } }).getEpisode(100, 1, 1),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("TVDB air dates and absolute numbers", () => {
  it("finds an episode by air date with the airDate filter", async () => {
    const official = [
      { id: 1, seasonNumber: 0, number: 1, name: "Special", aired: "2024-03-15" },
      { id: 2, seasonNumber: 29, number: 70, name: "Guest", aired: "2024-03-15" },
      { id: 3, seasonNumber: 29, number: 71, name: "Other", aired: "2024-03-18" },
    ];
    const { fetch, requests } = tvdb({ listings: { official } });
    const episode = await client(fetch).getEpisodeByAirDate(100, "2024-03-15");
    expect(episode).toMatchObject({ season: 29, episode: 70, title: "Guest", airDate: "2024-03-15" });
    expect(paths(requests)).toContain("/v4/series/100/episodes/official?page=0&airDate=2024-03-15");
    expect(await client(fetch).getEpisodeByAirDate(100, "2024-03-16")).toBeUndefined();
  });

  it("reads the whole listing once after two dates of the same show", async () => {
    const official = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      seasonNumber: 1,
      number: i + 1,
      name: `Day ${i + 1}`,
      aired: `2024-03-1${i}`,
    }));
    const { fetch, requests } = tvdb({ listings: { official } });
    const c = client(fetch);
    for (let i = 0; i < 6; i++) {
      expect((await c.getEpisodeByAirDate(100, `2024-03-1${i}`))?.title).toBe(`Day ${i + 1}`);
    }
    expect(paths(requests).filter((p) => p.includes("/episodes/official"))).toEqual([
      "/v4/series/100/episodes/official?page=0&airDate=2024-03-10",
      "/v4/series/100/episodes/official?page=0&airDate=2024-03-11",
      "/v4/series/100/episodes/official?page=0",
    ]);
  });

  it("maps an absolute number through absoluteNumber in the aired listing", async () => {
    const official = [...season(1, 3, 1000, 1), ...season(2, 3, 2000, 4)];
    const { fetch, requests } = tvdb({ listings: { official } });
    expect(await client(fetch).getEpisodeByAbsoluteNumber(100, 5)).toMatchObject({
      season: 2,
      episode: 2,
      absoluteNumber: 5,
      title: "S2E2",
    });
    expect(paths(requests)).toContain("/v4/series/100/episodes/official?page=0");
  });

  it("falls back to the absolute listing, by id, when the aired listing has no absolute numbers", async () => {
    const official = [...season(1, 3), ...season(2, 3)];
    const absolute = [{ id: 2001, seasonNumber: 1, number: 4 }];
    const { fetch } = tvdb({ listings: { official, absolute } });
    expect(await client(fetch).getEpisodeByAbsoluteNumber(100, 4)).toMatchObject({
      season: 2,
      episode: 1,
      absoluteNumber: 4,
    });
  });

  it("names an absolute number in DVD order when that is the order", async () => {
    const official = [...season(1, 2, 1000, 1)];
    const dvd = [
      { id: 1002, seasonNumber: 1, number: 1, absoluteNumber: 2, name: "Second" },
      { id: 1001, seasonNumber: 1, number: 2, absoluteNumber: 1, name: "First" },
    ];
    const { fetch } = tvdb({ listings: { official, dvd } });
    expect(await client(fetch, { episodeOrder: "dvd" }).getEpisodeByAbsoluteNumber(100, 2)).toMatchObject({
      season: 1,
      episode: 1,
      title: "Second",
    });
  });
});

describe("TVDB translations", () => {
  const official: Ep[] = [
    { id: 11, seasonNumber: 1, number: 1, name: "Original One", nameTranslations: ["jpn", "eng", "deu"] },
    { id: 12, seasonNumber: 1, number: 2, name: "Original Two", nameTranslations: ["jpn", "eng"] },
    { id: 13, seasonNumber: 1, number: 3, name: "Original Three", nameTranslations: ["jpn"] },
  ];
  const anime = { originalLanguage: "jpn", name: "進撃の巨人", nameTranslations: ["jpn", "eng", "deu"] };
  const episodeNames = {
    eng: { 11: "English One", 12: "English Two" },
    deu: { 11: "Deutsch Eins" },
  };
  const seriesNames = { eng: "Attack on Titan", deu: "Attack on Titan (DE)" };

  it("uses the translation in the chosen language", async () => {
    const { fetch, requests } = tvdb({ series: anime, listings: { official }, episodeNames, seriesNames });
    const episode = await client(fetch, { language: "de-DE" }).getEpisode(100, 1, 1);
    expect(episode?.show.title).toBe("Attack on Titan (DE)");
    expect(episode?.show.originalTitle).toBe("進撃の巨人");
    expect(episode?.title).toBe("Deutsch Eins");
    expect(paths(requests)).toContain("/v4/series/100/translations/deu");
    expect(paths(requests)).toContain("/v4/series/100/episodes/official/deu?page=0");
  });

  it("falls back to English, then the original name, never to an empty title", async () => {
    const { fetch } = tvdb({ series: anime, listings: { official }, episodeNames, seriesNames });
    const c = client(fetch, { language: "de-DE" });
    expect((await c.getEpisode(100, 1, 2))?.title).toBe("English Two");
    expect((await c.getEpisode(100, 1, 3))?.title).toBe("Original Three");
    const untitled = tvdb({
      series: anime,
      listings: { official: [{ id: 14, seasonNumber: 1, number: 4, name: null, nameTranslations: [] }] },
    });
    expect((await client(untitled.fetch, { language: "de-DE" }).getEpisode(100, 1, 4))?.title).toBe("Episode 4");
  });

  it("skips languages the record does not list, and the original language", async () => {
    const { fetch, requests } = tvdb({ series: anime, listings: { official }, episodeNames, seriesNames });
    // English user, Japanese show: the English translation, no German requests.
    const episode = await client(fetch).getEpisode(100, 1, 3);
    expect(episode?.show.title).toBe("Attack on Titan");
    expect(episode?.title).toBe("Original Three");
    expect(paths(requests).some((p) => p.includes("/deu"))).toBe(false);
    expect(paths(requests).some((p) => p.includes("/episodes/official/eng"))).toBe(false);
  });

  it("sends no translation requests when the show is already in the chosen language", async () => {
    const { fetch, requests } = tvdb({ listings: { official: season(1, 2) } });
    await client(fetch).getEpisode(100, 1, 1);
    expect(paths(requests).some((p) => p.includes("translations") || /official\/\w+/.test(p))).toBe(false);
  });

  it("fetches the translated listing once for all episodes of a show", async () => {
    const { fetch, requests } = tvdb({ series: anime, listings: { official }, episodeNames, seriesNames });
    const c = client(fetch, { language: "de-DE" });
    await Promise.all([c.getEpisode(100, 1, 1), c.getEpisode(100, 1, 1)]);
    await c.getEpisode(100, 1, 1);
    expect(paths(requests).filter((p) => p.includes("/episodes/official/deu"))).toHaveLength(1);
    expect(paths(requests).filter((p) => p.includes("/series/100/translations/deu"))).toHaveLength(1);
  });

  it("uses each episode's translation record when the translated listing has no episodes", async () => {
    const { fetch, requests } = tvdb({
      series: anime,
      listings: { official },
      episodeNames,
      seriesNames,
      translatedListings: false,
    });
    expect((await client(fetch, { language: "de-DE" }).getEpisode(100, 1, 1))?.title).toBe("Deutsch Eins");
    expect(paths(requests)).toContain("/v4/episodes/11/translations/deu");
  });

  it("uses search result translations for show names", async () => {
    const { fetch } = mockFetch([
      LOGIN,
      {
        path: "/v4/search",
        reply: {
          json: {
            data: [
              { tvdb_id: "1", name: "進撃の巨人", translations: { eng: "Attack on Titan", deu: "Angriff" } },
              { tvdb_id: "2", name: "Plain" },
            ],
          },
        },
      },
    ]);
    const [german, plain] = await client(fetch, { language: "de-DE" }).searchShow("x");
    expect(german).toMatchObject({ title: "Angriff", originalTitle: "進撃の巨人" });
    expect(plain).toMatchObject({ title: "Plain" });
    const [english] = await client(fetch, { language: "pt-BR" }).searchShow("x");
    expect(english?.title).toBe("Attack on Titan");
  });
});

describe("TVDB cache keys by language", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps translated responses apart from each other in the file cache", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "tt-tvdb-lang-"));
    const cache = new APICache({ cacheDir: dir });
    const anime = { originalLanguage: "jpn", nameTranslations: ["eng", "deu", "fra"] };
    const first = tvdb({ series: anime, listings: {}, seriesNames: { deu: "DE", fra: "FR" } });
    expect((await client(first.fetch, { cache, language: "de-DE" }).getShow(100))?.title).toBe("DE");
    const second = tvdb({ series: anime, listings: {}, seriesNames: { deu: "DE", fra: "FR" } });
    expect((await client(second.fetch, { cache, language: "fr-FR" }).getShow(100))?.title).toBe("FR");
    expect(paths(second.requests)).toContain("/v4/series/100/translations/fra");
  });
});
