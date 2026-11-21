/**
 * Multi-episode files, date-based shows, and absolute numbering. Expected
 * values are guessit 3.8.0 output (its `episode` list and `date`), checked
 * by scripts/parser-parity.ts.
 */

import { describe, expect, it } from "vitest";
import { episodeTarget } from "../src/episodeLookup";
import { GuessItParser } from "../src/parser";

const parser = new GuessItParser();
const parse = (name: string) => parser.parse(name);

describe("multi-episode files", () => {
  it.each([
    ["Show.S01E01E02.mkv", 1, [1, 2]],
    ["Show.S01E01-E03.mkv", 1, [1, 2, 3]],
    ["Show.S01E01-03.mkv", 1, [1, 2, 3]],
    ["Show.S01E01+E02.mkv", 1, [1, 2]],
    ["Show.S01E01xE02.mkv", 1, [1, 2]],
    ["Show.S01E01-S01E03.mkv", 1, [1, 2, 3]],
    ["Show.S01E01E03.mkv", 1, [1, 3]],
    ["Show.S01E01-E03E05.mkv", 1, [1, 2, 3, 5]],
    ["Show.S01E01-E03-E05.mkv", 1, [1, 2, 3, 4, 5]],
    ["Show.S01E05-E03.mkv", 1, [5, 3]],
    ["Show.1x01-02.mkv", 1, [1, 2]],
    ["Show.1x01x02.mkv", 1, [1, 2]],
    ["Show.1x01-1x03.mkv", 1, [1, 3]],
    ["Show.S01.E01-E02.mkv", 1, [1, 2]],
    ["Show.S01E01.E02.mkv", 1, [1, 2]],
    ["Show.S01E01 E02.mkv", 1, [1, 2]],
    ["Show.S01E01.S01E02.mkv", 1, [1, 2]],
    ["Show.S01E01.1080p.E02.mkv", 1, [1, 2]],
    ["The.Office.US.S02E01E02.720p.HDTV.x264-LOL.mkv", 2, [1, 2]],
  ])("%s", (name, season, episodes) => {
    const info = parse(name);
    expect(info.mediaType).toBe("tv_episode");
    expect(info.season).toBe(season);
    expect(info.episode).toBe(episodes[0]);
    expect(info.episodes).toEqual(episodes);
  });

  it("keeps the episode title and release tags", () => {
    expect(parse("Lost.S01E01-E02.Pilot.720p.BluRay.mkv")).toMatchObject({
      title: "Lost",
      episodes: [1, 2],
      episodeTitle: "Pilot",
      quality: "720p",
    });
    expect(parse("Show.S01E01-E02.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv")).toMatchObject({
      episodes: [1, 2],
      group: "GRP",
    });
    expect(parse("Futurama - S01E01-E02 - Space Pilot 3000.mkv")).toMatchObject({
      title: "Futurama",
      episodes: [1, 2],
      episodeTitle: "Space Pilot 3000",
    });
  });

  it("reads anime ranges after a dash", () => {
    expect(parse("[SubsPlease] Frieren - 01-02 (1080p).mkv")).toMatchObject({ episode: 1, episodes: [1, 2] });
    expect(parse("[Erai-raws] Spy x Family - 01 - 02 [1080p].mkv")).toMatchObject({ episodes: [1, 2] });
    // guessit reads "~" and " - " as two episodes, not a range.
    expect(parse("[HorribleSubs] Naruto - 01~03 [720p].mkv")).toMatchObject({ episodes: [1, 3] });
    expect(parse("[Group] Show - 01 - 03 [1080p].mkv")).toMatchObject({ episodes: [1, 3] });
    expect(parse("Show.E01-E02.mkv")).toMatchObject({ episode: 1, episodes: [1, 2] });
    expect(parse("Show.Ep01-02.mkv")).toMatchObject({ episode: 1, episodes: [1, 2] });
  });

  it("stops at a second season, keeping the first (guessit lists both seasons)", () => {
    const info = parse("Show.S01E01.S02E01.mkv");
    expect(info).toMatchObject({ season: 1, episode: 1 });
    expect(info.episodes).toBeUndefined();
  });

  it("leaves single episodes without an episodes list", () => {
    for (const name of ["Show.S01E01.mkv", "Show.1x05.mkv", "[Group] Show - 12v2 [1080p].mkv"]) {
      expect(parse(name).episodes).toBeUndefined();
    }
    expect(parse("[Group] Show - 12v2 [1080p].mkv")).toMatchObject({ episode: 12 });
  });

  it("does not expand an absurd range", () => {
    expect(parse("Show.S01E01-E9999.mkv").episodes).toEqual([1, 9999]);
  });
});

describe("date-based episodes", () => {
  it.each([
    ["Show.2024.03.15.mkv", "2024-03-15"],
    ["Show.2024-03-15.mkv", "2024-03-15"],
    ["Show 2024 03 15.mkv", "2024-03-15"],
    ["Show (2024-03-15).mkv", "2024-03-15"],
    ["Show.20240315.mkv", "2024-03-15"],
    // Day first, as guessit reads it, and month first only when the day can't be a month.
    ["Show.15.03.2024.mkv", "2024-03-15"],
    ["Show.03.04.2024.mkv", "2024-04-03"],
    ["Show.03.15.2024.mkv", "2024-03-15"],
  ])("%s", (name, airDate) => {
    const info = parse(name);
    expect(info).toMatchObject({ mediaType: "tv_episode", title: "Show", airDate });
    expect(info.year).toBeUndefined();
    expect(info.season).toBeUndefined();
  });

  it("keeps the title and the guest", () => {
    expect(parse("The.Daily.Show.2024.03.15.Guest.Name.720p.WEB.h264.mkv")).toMatchObject({
      title: "The Daily Show",
      airDate: "2024-03-15",
      episodeTitle: "Guest Name",
    });
  });

  it("never reports an impossible date", () => {
    expect(parse("Show.2024.02.30.mkv").airDate).toBeUndefined();
    expect(parse("Show.20241315.mkv").airDate).toBeUndefined();
  });
});

describe("movies stay movies", () => {
  it.each([
    "Movie.Title.2024.1080p.mkv",
    "Blade.Runner.2049.2017.1080p.mkv",
    "2012.2009.1080p.BluRay.mkv",
    "1917.2019.1080p.mkv",
    "Ocean's.Eleven.2001.720p.mkv",
    "Show.2024.mkv",
  ])("%s", (name) => {
    const info = parse(name);
    expect(info.mediaType).toBe("movie");
    expect(info.episodes).toBeUndefined();
    expect(info.airDate).toBeUndefined();
    expect(episodeTarget(info)).toBeUndefined();
  });
});

describe("episodeTarget", () => {
  it("picks numbered, multi-episode, date, and absolute lookups", () => {
    expect(episodeTarget(parse("Show.S01E05.mkv"))).toEqual({ kind: "numbered", season: 1, episodes: [5] });
    expect(episodeTarget(parse("Show.S00E01.mkv"))).toEqual({ kind: "numbered", season: 0, episodes: [1] });
    expect(episodeTarget(parse("Show.S01E01-E03.mkv"))).toEqual({
      kind: "numbered",
      season: 1,
      episodes: [1, 2, 3],
    });
    expect(episodeTarget(parse("Show.2024.03.15.mkv"))).toEqual({ kind: "date", airDate: "2024-03-15" });
    expect(episodeTarget(parse("[SubsPlease] One Piece - 1100 (1080p) [ABCDEF12].mkv"))).toEqual({
      kind: "absolute",
      episodes: [1100],
    });
    expect(episodeTarget(parse("[SubsPlease] Frieren - 01-02 (1080p).mkv"))).toEqual({
      kind: "absolute",
      episodes: [1, 2],
    });
  });

  it("has nothing to look up for a season pack or a bare show name", () => {
    expect(episodeTarget(parse("Breaking.Bad.S01.720p.mkv"))).toBeUndefined();
    expect(episodeTarget({ title: "Show", mediaType: "tv_episode", rawFilename: "Show.mkv" })).toBeUndefined();
  });
});
