/**
 * Multi-episode files, date-based and absolute-numbered episodes, and
 * episode orders through the whole rename service, with the real TVDB and
 * TMDB clients against scripted APIs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpisodeOrderUnavailableError } from "../src/errors";
import { createEpisode, type Episode, type TVShow } from "../src/models";
import type { TVProvider } from "../src/providers/base";
import { TMDBClient } from "../src/providers/tmdb";
import { TVDBClient } from "../src/providers/tvdb";
import { describeLookupError, RenameService } from "../src/renameService";
import { breakingBad, FakeMusicParser, touch } from "./fakes";
import { mockFetch, queryOf } from "./providers/mock-fetch";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-episodes-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const service = (tvProvider: TVProvider) => new RenameService({ musicParser: new FakeMusicParser(), tvProvider });

async function plan(tvProvider: TVProvider, names: string[]) {
  const files = await Promise.all(names.map((name) => touch(dir, name)));
  return service(tvProvider).processFiles(files);
}

/** A TVDB with one show, 2 seasons of 10 episodes, absolute numbers 1-20. */
function fakeTvdb() {
  const episodes = [1, 2].flatMap((s) =>
    Array.from({ length: 10 }, (_, i) => ({
      id: s * 100 + i + 1,
      seasonNumber: s,
      number: i + 1,
      absoluteNumber: (s - 1) * 10 + i + 1,
      name: `Title ${s}-${i + 1}`,
      aired: `2024-0${s}-${String(i + 1).padStart(2, "0")}`,
    })),
  );
  return mockFetch([
    { method: "POST", path: "/v4/login", reply: { json: { data: { token: "t" } } } },
    { path: "/v4/search", reply: { json: { data: [{ tvdb_id: "7", name: "Show", year: "2024" }] } } },
    { path: "/v4/series/7", reply: { json: { data: { id: 7, name: "Show", year: "2024", originalLanguage: "eng" } } } },
    {
      path: /^\/v4\/series\/7\/episodes\/official$/,
      reply: (r) => {
        const q = queryOf(r);
        let rows = episodes;
        if (q.season !== undefined) rows = rows.filter((e) => e.seasonNumber === Number(q.season));
        if (q.airDate !== undefined) rows = rows.filter((e) => e.aired === q.airDate);
        return { json: { data: { episodes: rows }, links: { next: null } } };
      },
    },
    { path: /^\/v4\/series\/7\/episodes\/dvd$/, reply: { json: { data: { episodes: [] }, links: { next: null } } } },
  ]);
}

const names = (ops: { destination: string }[]) => ops.map((op) => path.basename(op.destination));

describe("TV files beyond SxxEyy", () => {
  it("names multi-episode files with every episode, fetching each season once", async () => {
    const { fetch, requests } = fakeTvdb();
    const ops = await plan(new TVDBClient({ apiKey: "k", fetch }), [
      "Show.S01E01E02.mkv",
      "Show.S01E03-E05.720p.mkv",
      "Show.1x06-07.mkv",
      "Show.S01E08.mkv",
    ]);
    expect(names(ops)).toEqual([
      "Show - S01E01-E02 - Title 1-1 & Title 1-2.mkv",
      "Show - S01E03-E05 - Title 1-3 & Title 1-4 & Title 1-5.mkv",
      "Show - S01E06-E07 - Title 1-6 & Title 1-7.mkv",
      "Show - S01E08 - Title 1-8.mkv",
    ]);
    expect(ops.every((op) => op.status === "pending")).toBe(true);
    const gets = requests.filter((r) => r.method === "GET").map((r) => r.url.pathname + r.url.search);
    expect(gets.filter((p) => p.startsWith("/v4/series/7/episodes"))).toEqual([
      "/v4/series/7/episodes/official?page=0&season=1",
    ]);
    expect(gets.filter((p) => p === "/v4/series/7")).toHaveLength(1);
  });

  it("leaves a multi-episode file unmatched when one of its episodes does not exist", async () => {
    const { fetch } = fakeTvdb();
    const [op] = await plan(new TVDBClient({ apiKey: "k", fetch }), ["Show.S01E10E11.mkv"]);
    expect(op).toMatchObject({ status: "skipped", skipReason: "no_match" });
  });

  it("finds a date-based episode and names it with season and episode numbers", async () => {
    const { fetch } = fakeTvdb();
    const [op] = await plan(new TVDBClient({ apiKey: "k", fetch }), ["Show.2024.02.03.720p.WEB.mkv"]);
    expect(path.basename(op!.destination)).toBe("Show - S02E03 - Title 2-3.mkv");
    expect(op!.mediaFile.matchedMetadata).toMatchObject({ kind: "episode", airDate: "2024-02-03" });
  });

  it("maps absolute numbers (anime) to seasons, including a range", async () => {
    const { fetch, requests } = fakeTvdb();
    const ops = await plan(new TVDBClient({ apiKey: "k", fetch }), [
      "[Group] Show - 12 [1080p].mkv",
      "[Group] Show - 13-14 [1080p].mkv",
      "[Group] Show - 15v2 [1080p].mkv",
    ]);
    expect(names(ops)).toEqual([
      "Show - S02E02 - Title 2-2.mkv",
      "Show - S02E03-E04 - Title 2-3 & Title 2-4.mkv",
      "Show - S02E05 - Title 2-5.mkv",
    ]);
    // One full listing for every absolute number in the run.
    const listings = requests.filter((r) => r.url.pathname === "/v4/series/7/episodes/official");
    expect(listings).toHaveLength(1);
  });

  it("reports an order the provider has no data for as order_unavailable", async () => {
    const { fetch } = fakeTvdb();
    const [op] = await plan(new TVDBClient({ apiKey: "k", fetch, episodeOrder: "dvd" }), ["Show.S01E01.mkv"]);
    expect(op).toMatchObject({ status: "skipped", skipReason: "lookup_failed" });
    expect(op!.lookupError).toMatchObject({ kind: "order_unavailable", name: "EpisodeOrderUnavailableError" });
    expect(describeLookupError(new EpisodeOrderUnavailableError("tmdb", "dvd", "x")).kind).toBe("order_unavailable");
  });

  it("TMDB: DVD order without a DVD group is reported the same way", async () => {
    const { fetch } = mockFetch([
      { path: "/3/search/tv", reply: { json: { results: [{ id: 3, name: "Show", first_air_date: "2024-01-01" }] } } },
      { path: "/3/tv/3", reply: { json: { id: 3, name: "Show", first_air_date: "2024-01-01" } } },
      { path: "/3/tv/3/episode_groups", reply: { json: { id: 3, results: [] } } },
    ]);
    const [op] = await plan(new TMDBClient({ apiKey: "k", fetch, episodeOrder: "dvd" }), ["Show.S01E01.mkv"]);
    expect(op!.lookupError?.kind).toBe("order_unavailable");
  });

  it("skips date and absolute files when the provider cannot look them up", async () => {
    const plain: TVProvider = {
      searchShow: async (): Promise<TVShow[]> => [breakingBad],
      getShow: async () => breakingBad,
      getEpisode: async (_id, season, episode): Promise<Episode> =>
        createEpisode({ show: breakingBad, season, episode, title: "T" }),
    };
    const ops = await plan(plain, ["Show.2024.02.03.mkv", "[Group] Show - 12 [1080p].mkv", "Show.S01E01E02.mkv"]);
    expect(ops.map((op) => op.skipReason ?? op.status)).toEqual(["no_match", "no_match", "pending"]);
    expect(path.basename(ops[2]!.destination)).toBe("Breaking Bad - S01E01-E02 - T.mkv");
  });
});
