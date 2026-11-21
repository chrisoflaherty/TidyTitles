/** Tests for optional template sections (`<...>`) and unchanged output for existing templates. */

import { describe, expect, it } from "vitest";

import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createTrack,
  createTVShow,
} from "../src/models";
import { TemplateEngine } from "../src/template";
import { hasSections, sectionErrors } from "../src/templateSections";

const engine = new TemplateEngine();
const render = (template: string, context: Record<string, unknown>) =>
  engine.cleanPath(engine.render(template, context));

const movie = createMovie({ id: 603, title: "The Matrix", originalTitle: "The Matrix", year: 1999 });
const show = createTVShow({ id: 81189, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008 });
const episode = createEpisode({ show, season: 1, episode: 1, title: "Pilot" });
const floyd = createArtist({ id: "a", name: "Pink Floyd" });
const track = createTrack({
  id: "t",
  title: "Comfortably Numb",
  artist: floyd,
  album: createAlbum({ id: "r", title: "The Wall", artist: floyd, year: 1979 }),
  trackNumber: 6,
  discNumber: 2,
});

describe("today's templates render exactly as before", () => {
  // Expected values are the output of the engine before optional sections existed.
  it("renders the default templates", () => {
    expect(engine.renderMovie(movie, ".mkv")).toBe("The Matrix (1999).mkv");
    expect(engine.renderEpisode(episode, ".mkv")).toBe("Breaking Bad - S01E01 - Pilot.mkv");
    expect(engine.renderTrack(track, ".flac")).toBe("Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac");
  });

  it("keeps the debris of empty values outside sections", () => {
    const noYear = { ...track, album: createAlbum({ id: "r", title: "The Wall", artist: floyd }) };
    expect(engine.renderTrack(noYear, ".flac")).toBe("Pink Floyd/The Wall ()/06 - Comfortably Numb.flac");
    const emptyTitle = createEpisode({ show, season: 1, episode: 1, title: "" });
    expect(engine.renderEpisode(emptyTitle, ".mkv")).toBe("Breaking Bad - S01E01 - .mkv");
    expect(render("{title} ({year}) [{quality}]", { title: "Mission Impossible", year: 1996 })).toBe(
      "Mission Impossible (1996) []",
    );
    expect(render("{title} - {quality} - {source}", { title: "X", source: "Web" })).toBe("X -  - Web");
  });

  it("gives the same names for templates with stray or paired angle brackets", () => {
    // "<" and ">" were always removed from names, so a pair around literal
    // text or a placeholder with a value gives the same name as before.
    expect(render("a<b>{title}", { title: "T" })).toBe("abT");
    expect(render("{title} > {year}", { title: "T", year: 1999 })).toBe("T  1999");
    expect(render("<{title}>", { title: "T" })).toBe("T");
    expect(render("<", {})).toBe("");
  });

  it("uses sections only when a < has a matching >", () => {
    expect(hasSections("{title} ({year})")).toBe(false);
    expect(hasSections("{title} > {year} <")).toBe(false);
    expect(hasSections("{title}< [{quality}]>")).toBe(true);
  });
});

describe("optional sections", () => {
  it("drops a section whose placeholders are all empty", () => {
    const t = "{title} ({year})< [{quality}]>";
    expect(render(t, { title: "The Matrix", year: 1999, quality: "1080p" })).toBe("The Matrix (1999) [1080p]");
    expect(render(t, { title: "The Matrix", year: 1999 })).toBe("The Matrix (1999)");
    expect(render(t, { title: "The Matrix", year: 1999, quality: "" })).toBe("The Matrix (1999)");
  });

  it("collapses the spaces around a dropped section", () => {
    expect(render("{title} <[{quality}]> - {year}", { title: "M", year: 1999 })).toBe("M - 1999");
    expect(render("{title} <({year})>", { title: "M" })).toBe("M");
    expect(render("<({year}) >{title}", { title: "M" })).toBe("M");
    expect(render("{title} <({year})>/{title}", { title: "M" })).toBe("M/M");
  });

  it("removes a folder made only of an empty section", () => {
    const t = "{artist}/{album}/<Disc {disc_multi}/>{track2} - {title}";
    expect(render(t, { artist: "A", album: "B", track2: "06", title: "T" })).toBe("A/B/06 - T");
    expect(render(t, { artist: "A", album: "B", track2: "06", title: "T", disc_multi: 2 })).toBe("A/B/Disc 2/06 - T");
  });

  it("tidies brackets and separators around an empty value in a kept section", () => {
    const t = "{title}< [{quality} {source}]>";
    expect(render(t, { title: "M", quality: "1080p", source: "Blu-ray" })).toBe("M [1080p Blu-ray]");
    expect(render(t, { title: "M", quality: "1080p" })).toBe("M [1080p]");
    expect(render(t, { title: "M", source: "Blu-ray" })).toBe("M [Blu-ray]");
    expect(render(t, { title: "M" })).toBe("M");
  });

  it("keeps only one separator between values", () => {
    const t = "<{quality} - {source} - {codec}>";
    expect(render(t, { quality: "1080p", codec: "H.264" })).toBe("1080p - H.264");
    expect(render(t, { source: "Web" })).toBe("Web");
    expect(render(t, { quality: "1080p" })).toBe("1080p");
    expect(render("<{quality}-{group}>", { group: "GRP" })).toBe("GRP");
    expect(render("<[{quality}-{group}]>", { group: "GRP" })).toBe("[GRP]");
  });

  it("removes brackets left empty inside a kept section", () => {
    expect(render("<{title} ({year}) [{quality}]>", { title: "M", quality: "720p" })).toBe("M [720p]");
  });

  it("supports nested sections", () => {
    const t = "{title}< [{quality}< {source}>]>";
    expect(render(t, { title: "M", quality: "1080p" })).toBe("M [1080p]");
    expect(render(t, { title: "M", source: "Web" })).toBe("M [Web]");
    expect(render(t, { title: "M" })).toBe("M");
  });

  it("keeps a section of literal text only", () => {
    expect(render("{title}< - copy>", { title: "M" })).toBe("M - copy");
  });

  it("counts a formatted value as a value", () => {
    expect(render("{title}< {year|pad:5}>", { title: "M", year: 1999 })).toBe("M 01999");
    expect(render("{title}< {year|pad:5}>", { title: "M" })).toBe("M");
  });

  it("literal braces around a placeholder work inside a section (Plex style)", () => {
    const t = "{title} ({year})< {edition-{edition}}>";
    expect(render(t, { title: "Blade Runner", year: 1982, edition: "Director's Cut" })).toBe(
      "Blade Runner (1982) {edition-Director's Cut}",
    );
    expect(render(t, { title: "Blade Runner", year: 1982 })).toBe("Blade Runner (1982)");
  });

  it("never turns a value's angle brackets or slashes into sections or folders", () => {
    expect(render("<{title}>", { title: "<x>" })).toBe("x");
    expect(render("<{title} ({year})>", { title: "Face/Off", year: 1997 })).toBe("FaceOff (1997)");
    expect(render("{artist}/<{album}/>{title}", { artist: "../..", album: "..", title: "T" })).toBe("T");
  });

  it("validates matching angle brackets", () => {
    expect(sectionErrors("{title}< [{quality}]>")).toEqual([]);
    expect(sectionErrors("{title}< [{quality}]")).toEqual(["Mismatched < > in template"]);
    expect(engine.validateTemplate("{title}> x").errors).toContain("Mismatched < > in template");
    expect(engine.validateTemplate("{title}<<{year}>>").isValid).toBe(true);
  });

  it("ignores angle brackets inside a formatter argument", () => {
    expect(hasSections("{title|replace:<:x}")).toBe(false);
  });
});
