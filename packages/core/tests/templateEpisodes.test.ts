import { describe, expect, it } from "vitest";
import { combineEpisodes } from "../src/episodeLookup";
import { createEpisode, type Episode } from "../src/models";
import { TemplateEngine } from "../src/template";
import { EpisodeNumbers, joinEpisodeTitles } from "../src/templateEpisodes";
import { breakingBad } from "./fakes";

const ep = (episode: number, title: string, fields: Partial<Episode> = {}): Episode =>
  createEpisode({ show: breakingBad, season: 1, episode, title, ...fields });

const multi = (...episodes: Episode[]): Episode => combineEpisodes(episodes)!;

const render = (template: string, episode: Episode, extension = ".mkv") =>
  new TemplateEngine({ tvTemplate: template }).renderEpisode(episode, extension);

describe("multi-episode names", () => {
  it("the default template names them as Plex and Jellyfin expect", () => {
    const file = multi(ep(1, "Pilot"), ep(2, "Cat's in the Bag..."));
    expect(new TemplateEngine().renderEpisode(file, ".mkv")).toBe(
      "Breaking Bad - S01E01-E02 - Pilot & Cat's in the Bag....mkv",
    );
  });

  it("a range shows the first and last episode", () => {
    const file = multi(ep(1, "One"), ep(2, "Two"), ep(3, "Three"));
    expect(render("{title} - S{season2}E{episode2} - {episode_title}", file)).toBe(
      "Breaking Bad - S01E01-E03 - One & Two & Three.mkv",
    );
  });

  it("repeats the letter written before the placeholder, in its case", () => {
    const file = multi(ep(18, "A"), ep(19, "B"));
    expect(render("{title} - s{season2}e{episode2}", file)).toBe("Breaking Bad - s01e18-e19.mkv");
    expect(render("{title} {season}x{episode2}", file)).toBe("Breaking Bad 1x18-19.mkv");
    expect(render("{title} E{episode}", file)).toBe("Breaking Bad E18-E19.mkv");
  });

  it("lists every number when the episodes are not contiguous", () => {
    const file = multi(ep(1, "A"), ep(3, "C"));
    expect(render("S{season2}E{episode2}", file)).toBe("S01E01E03.mkv");
    expect(render("{season}x{episode2}", file)).toBe("1x01-03.mkv");
  });

  it("applies formatters to each number", () => {
    const file = multi(ep(1, "A"), ep(2, "B"));
    expect(render("S{season2}E{episode|pad:3}", file)).toBe("S01E001-E002.mkv");
    expect(render("{episode_title|upper}", file)).toBe("A & B.mkv");
  });

  it("leaves out repeated and empty titles", () => {
    expect(joinEpisodeTitles(["Pilot", "Pilot", " ", "Two"])).toBe("Pilot & Two");
    const file = multi(ep(1, "The Finale"), ep(2, "The Finale"));
    expect(render("{episode_title}", file)).toBe("The Finale.mkv");
  });

  it("renders single episodes exactly as before", () => {
    const single = ep(5, "Gray Matter");
    expect(new TemplateEngine().renderEpisode(single, ".mkv")).toBe("Breaking Bad - S01E05 - Gray Matter.mkv");
    expect(render("E{episode|pad:3} {episode}", single)).toBe("E005 5.mkv");
    expect(combineEpisodes([single])).toBe(single);
  });
});

describe("absolute and air date fields", () => {
  it("renders {absolute} and {air_date}, empty when unknown", () => {
    const anime = ep(5, "Five", { absoluteNumber: 1100, airDate: "2024-03-15" });
    expect(render("{title} - {absolute} ({air_date})", anime)).toBe("Breaking Bad - 1100 (2024-03-15).mkv");
    expect(render("{title} - {absolute}", ep(5, "Five"))).toBe("Breaking Bad - .mkv");
  });

  it("validates the new fields", () => {
    const engine = new TemplateEngine();
    expect(engine.validateTemplate("{absolute} {air_date}").isValid).toBe(true);
    expect(TemplateEngine.getAvailableFields()).toHaveProperty("absolute");
    expect(TemplateEngine.getAvailableFields()).toHaveProperty("air_date");
  });
});

describe("combineEpisodes", () => {
  it("needs every episode, all in one season", () => {
    expect(combineEpisodes([ep(1, "A"), undefined])).toBeUndefined();
    expect(combineEpisodes([ep(1, "A"), ep(1, "B", { season: 2 })])).toBeUndefined();
    expect(combineEpisodes([])).toBeUndefined();
  });

  it("keeps the first episode's fields and lists the parts", () => {
    const file = multi(ep(1, "A", { airDate: "2008-01-20" }), ep(2, "B"));
    expect(file).toMatchObject({ season: 1, episode: 1, title: "A", airDate: "2008-01-20" });
    expect(file.parts).toEqual([
      { episode: 1, title: "A", airDate: "2008-01-20" },
      { episode: 2, title: "B" },
    ]);
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });

  it("EpisodeNumbers reads as plain text outside a template", () => {
    expect(String(new EpisodeNumbers([1, 2], 2))).toBe("01-02");
  });
});
