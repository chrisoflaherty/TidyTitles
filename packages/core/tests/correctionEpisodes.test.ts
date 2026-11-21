/** Changing a TV match for files that name several episodes, an air date, or an absolute number. */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings } from "../src/config";
import { createEpisode, type Episode, type TVShow } from "../src/models";
import type { TVProvider } from "../src/providers/base";
import { createSession } from "../src/session";
import { FakeMovieProvider, FakeMusicParser, breakingBad, breakingBadRemake, touch } from "./fakes";

let dir: string;
let config: ConfigService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-correction-episodes-"));
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Two shows found by the same search; each has season 1 episodes 1-3, one dated episode, and absolute numbers. */
class TwoShows implements TVProvider {
  async searchShow(): Promise<TVShow[]> {
    return [breakingBad, breakingBadRemake];
  }
  async getShow(): Promise<undefined> {
    return undefined;
  }
  private episode(showId: number, season: number, episode: number, extra: Partial<Episode> = {}): Episode {
    const show = showId === breakingBad.id ? breakingBad : breakingBadRemake;
    return createEpisode({ show, season, episode, title: `${show.year} Episode ${episode}`, ...extra });
  }
  async getEpisode(showId: number, season: number, episode: number): Promise<Episode | undefined> {
    return season === 1 && episode <= 3 ? this.episode(showId, season, episode) : undefined;
  }
  async getEpisodeByAirDate(showId: number, airDate: string): Promise<Episode | undefined> {
    return airDate === "2024-03-15" ? this.episode(showId, 5, 40, { airDate }) : undefined;
  }
  async getEpisodeByAbsoluteNumber(showId: number, absoluteNumber: number): Promise<Episode | undefined> {
    return absoluteNumber === 12 ? this.episode(showId, 2, 4, { absoluteNumber }) : undefined;
  }
}

async function correctorFor(names: string[]) {
  const settings = createDefaultSettings();
  settings.api.tmdbApiKey = "key";
  settings.api.tvdbApiKey = "key";
  await config.save(settings);
  const session = await createSession(config, {
    cache: false,
    mediaType: "tv",
    musicParser: new FakeMusicParser(),
    providers: { movieProvider: new FakeMovieProvider(), tvProvider: new TwoShows() },
  });
  const media = path.join(dir, "media");
  const paths = await Promise.all(names.map((name) => touch(media, name)));
  return session.corrector(await session.plan(paths));
}

describe("changing the show of files that are not a single numbered episode", () => {
  it("keeps every episode of a multi-episode file", async () => {
    const corrector = await correctorFor(["Breaking.Bad.S01E01E02.mkv"]);
    const query = corrector.query(0);
    expect(query).toMatchObject({ mediaType: "tv_episode", season: 1, episode: 1 });

    expect((await corrector.chooseMatch(0, query, breakingBadRemake)).kind).toBe("applied");
    const match = corrector.operations[0]!.mediaFile.matchedMetadata as Episode;
    expect(match.show.id).toBe(breakingBadRemake.id);
    expect(match.parts?.map((part) => part.episode)).toEqual([1, 2]);
    expect(path.basename(corrector.operations[0]!.destination)).toContain("S01E01-E02");
  });

  it("uses only the numbers the user typed when they differ from the file's", async () => {
    const corrector = await correctorFor(["Breaking.Bad.S01E01E02.mkv"]);
    const query = { ...corrector.query(0), season: 1, episode: 3 };
    expect((await corrector.chooseMatch(0, query, breakingBadRemake)).kind).toBe("applied");
    const match = corrector.operations[0]!.mediaFile.matchedMetadata as Episode;
    expect(match.episode).toBe(3);
    expect(match.parts).toBeUndefined();
  });

  it("finds a file named by air date without season and episode numbers", async () => {
    const corrector = await correctorFor(["Breaking.Bad.2024.03.15.mkv"]);
    const query = corrector.query(0);
    expect(query).not.toHaveProperty("season");

    expect((await corrector.chooseMatch(0, query, breakingBadRemake)).kind).toBe("applied");
    const match = corrector.operations[0]!.mediaFile.matchedMetadata as Episode;
    expect(match).toMatchObject({ season: 5, episode: 40, airDate: "2024-03-15" });
    expect(match.show.id).toBe(breakingBadRemake.id);
  });

  it("finds a file with an absolute number, and asks for numbers when the show has no such episode", async () => {
    const corrector = await correctorFor(["[Group] Breaking Bad - 12 [1080p].mkv", "[Group] Breaking Bad - 99 [1080p].mkv"]);
    expect((await corrector.chooseMatch(0, corrector.query(0), breakingBadRemake)).kind).toBe("applied");
    expect(corrector.operations[0]!.mediaFile.matchedMetadata).toMatchObject({ season: 2, episode: 4, absoluteNumber: 12 });

    expect(await corrector.chooseMatch(1, corrector.query(1), breakingBadRemake)).toEqual({ kind: "needs_episode" });
  });

  it("applies a show to the other files of the same show, whatever they name", async () => {
    const corrector = await correctorFor([
      "Breaking.Bad.S01E03.mkv",
      "Breaking.Bad.S01E01E02.mkv",
      "Breaking.Bad.2024.03.15.mkv",
      "Breaking.Bad.S01E09.mkv",
    ]);
    expect(corrector.similarFiles(0)).toEqual([1, 2, 3]);

    const result = await corrector.chooseMatch(0, corrector.query(0), breakingBadRemake, { applyToSimilar: true });
    expect(result).toMatchObject({ kind: "applied", unmatched: [3] });
    const matches = corrector.operations.map((op) => op.mediaFile.matchedMetadata as Episode | undefined);
    expect(matches[1]?.parts?.map((part) => part.episode)).toEqual([1, 2]);
    expect(matches[2]).toMatchObject({ season: 5, episode: 40 });
    for (const match of matches.slice(0, 3)) expect(match?.show.id).toBe(breakingBadRemake.id);
  });
});
