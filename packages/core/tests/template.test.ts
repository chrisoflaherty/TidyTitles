/** Tests for the template engine (port of tests/test_template.py, plus more). */

import { describe, expect, it } from "vitest";

import { TemplateError } from "../src/errors";
import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createTrack,
  createTVShow,
} from "../src/models";
import type { Episode, Movie } from "../src/models";
import { TemplateEngine, pyTitle, zfill } from "../src/template";

// Fixtures from tests/conftest.py
const sampleMovie = (): Movie =>
  createMovie({
    id: 603,
    title: "The Matrix",
    originalTitle: "The Matrix",
    year: 1999,
    releaseDate: "1999-03-31",
    overview: "A computer hacker learns about the true nature of reality.",
    genres: ["Action", "Science Fiction"],
    provider: "tmdb",
  });

const sampleEpisode = (): Episode =>
  createEpisode({
    show: createTVShow({
      id: 1396,
      title: "Breaking Bad",
      originalTitle: "Breaking Bad",
      year: 2008,
      network: "AMC",
      status: "Ended",
      genres: ["Drama", "Crime"],
      provider: "tvdb",
    }),
    season: 1,
    episode: 1,
    title: "Pilot",
    airDate: "2008-01-20",
    overview: "A high school chemistry teacher receives a terminal diagnosis.",
  });

describe("TemplateEngine (ported cases)", () => {
  it("renders simple placeholders", () => {
    const engine = new TemplateEngine();
    expect(engine.render("{title} ({year})", { title: "Test", year: 2024 })).toBe("Test (2024)");
  });

  it("renders a missing field as empty", () => {
    const engine = new TemplateEngine();
    expect(engine.render("{title} ({year})", { title: "Test" })).toBe("Test ()");
  });

  it("applies the lower formatter", () => {
    expect(new TemplateEngine().render("{title|lower}", { title: "THE MATRIX" })).toBe("the matrix");
  });

  it("applies the upper formatter", () => {
    expect(new TemplateEngine().render("{title|upper}", { title: "test" })).toBe("TEST");
  });

  it("applies the pad formatter", () => {
    expect(new TemplateEngine().render("{episode|pad:3}", { episode: 5 })).toBe("005");
  });

  it("renders a movie filename", () => {
    const engine = new TemplateEngine({ movieTemplate: "{title} ({year})" });
    expect(engine.renderMovie(sampleMovie(), ".mkv")).toBe("The Matrix (1999).mkv");
  });

  it("renders an episode filename", () => {
    const engine = new TemplateEngine({
      tvTemplate: "{title} - S{season2}E{episode2} - {episode_title}",
    });
    expect(engine.renderEpisode(sampleEpisode(), ".mkv")).toBe("Breaking Bad - S01E01 - Pilot.mkv");
  });

  it("validates a valid template", () => {
    const { isValid, errors } = new TemplateEngine().validateTemplate("{title} ({year})");
    expect(isValid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("catches unknown fields", () => {
    const { isValid, errors } = new TemplateEngine().validateTemplate("{invalid_field}");
    expect(isValid).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("catches unknown formatters", () => {
    const { isValid, errors } = new TemplateEngine().validateTemplate("{title|invalid}");
    expect(isValid).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("removes invalid filename characters with the clean formatter", () => {
    const result = new TemplateEngine().render("{title|clean}", { title: 'Test: A/B "Movie"' });
    expect(result).toBe("Test AB Movie");
  });
});

// Expected outputs below were produced by the Python TemplateEngine.
describe("render matches Python", () => {
  const engine = new TemplateEngine();

  it.each<[string, Record<string, unknown>, string]>([
    ["{title|title}", { title: "they're bill's 1st movie" }, "They'Re Bill'S 1St Movie"],
    ["{title|title}", { title: "HELLO wORLD" }, "Hello World"],
    ["{title|title}", { title: "straße ǆungla" }, "Straße ǅungla"],
    ["{title|title}", { title: "ΣΊΣΥΦΟΣ odyssey" }, "Σίσυφος Odyssey"],
    ["{t|pad:3}", { t: "-5" }, "-05"],
    ["{t|pad:3}", { t: "abc" }, "abc"],
    ["{t|pad:0}", { t: 7 }, "7"],
    ["{t|pad:+4}", { t: 7 }, "0007"],
    ["{title|replace:_: }", { title: "a_b_c" }, "a b c"],
    ["{title|replace::-}", { title: "abc" }, "-a-b-c-"],
    ["{title|replace:x}", { title: "axb" }, "axb"],
    ["{title|replace:a:b:c}", { title: "aaa" }, "bbb"],
    ["{title|bogus}", { title: "Keep" }, "Keep"],
    ["{title} {missing}", { title: "T" }, "T "],
    ["{a}{b}", { a: true, b: 2.5 }, "True2.5"],
    ["{title|upper}", { title: "straße" }, "STRASSE"],
    ["{title|lower}", { title: "ΣΑΣ" }, "σας"],
    ["{ title }", { title: "x" }, "{ title }"],
    ["{title|lower:arg}", { title: "ABC" }, "abc"],
    ["{year}", { year: 0 }, "0"],
    ["{x}", { x: "" }, ""],
    ["{tïtle}", { tïtle: "u" }, "u"],
    ["{title|clean}", { title: 'a<b>c:d"e/f\\g|h?i*j\u0001k' }, "abcdefghijk"],
  ])("%s with %j", (template, context, expected) => {
    expect(engine.render(template, context)).toBe(expected);
  });

  it("renders null like a missing value", () => {
    expect(engine.render("[{quality}]", { quality: null })).toBe("[]");
  });

  it("does not read inherited object properties", () => {
    expect(engine.render("{constructor}{toString}", {})).toBe("");
  });

  it("leaves unknown inherited formatter names alone", () => {
    expect(engine.render("{title|constructor}", { title: "Keep" })).toBe("Keep");
  });
});

describe("malformed formatters", () => {
  const engine = new TemplateEngine();

  // Python raises TypeError/ValueError here; the port raises TemplateError.
  it.each(["{t|pad}", "{t|replace}", "{t|pad:x}", "{t|pad:3.0}"])("%s throws", (template) => {
    expect(() => engine.render(template, { t: "v" })).toThrow(TemplateError);
  });

  it("does not throw when the field is missing", () => {
    expect(engine.render("{t|pad}", {})).toBe("");
  });
});

describe("validateTemplate matches Python", () => {
  const engine = new TemplateEngine();

  it.each<[string, boolean, string[]]>([
    ["{title} ({year})", true, []],
    ["{invalid_field}", false, ["Unknown field: {invalid_field}"]],
    ["{title|invalid}", false, ["Unknown formatter: invalid"]],
    ["{title", false, ["Mismatched braces in template"]],
    ["{title}}", false, ["Mismatched braces in template"]],
    ["{a|b} {c}", false, ["Unknown field: {a}", "Unknown formatter: b", "Unknown field: {c}"]],
    ["{title|pad:2}", true, []],
    ["{title|replace:a:b}", true, []],
    ["no placeholders", true, []],
    ["{title|clean:x}", true, []],
    [TemplateEngine.DEFAULT_MOVIE_TEMPLATE, true, []],
    [TemplateEngine.DEFAULT_TV_TEMPLATE, true, []],
    [TemplateEngine.DEFAULT_MUSIC_TEMPLATE, true, []],
  ])("%s", (template, isValid, errors) => {
    expect(engine.validateTemplate(template)).toEqual({ isValid, errors });
  });

  it("can be called repeatedly (global regex state does not leak)", () => {
    expect(engine.validateTemplate("{bad}").errors).toHaveLength(1);
    expect(engine.validateTemplate("{bad}").errors).toHaveLength(1);
  });
});

describe("path and extension handling matches Python", () => {
  const show = createTVShow({ id: 1, title: "Show: Name?", originalTitle: "Orig", year: 2008 });
  const episode = createEpisode({ show, season: 1, episode: 2, title: 'What/Is "This"?' });

  it("cleans invalid characters; a slash in a value is removed, not a directory split", () => {
    expect(new TemplateEngine().renderEpisode(episode, ".mkv")).toBe("Show Name - S01E02 - WhatIs This.mkv");
  });

  it("supports directory templates and extensions without a dot", () => {
    const engine = new TemplateEngine({
      tvTemplate: "{title}/Season {season2}/{title} - S{season2}E{episode2}",
    });
    expect(engine.renderEpisode(episode, "mkv")).toBe("Show Name/Season 01/Show Name - S01E02.mkv");
  });

  it("drops empty path components", () => {
    const engine = new TemplateEngine({ tvTemplate: "/{title}//x/" });
    expect(engine.renderEpisode(episode, "")).toBe("Show Name/x");
  });

  it("removes backslashes instead of treating them as separators", () => {
    const engine = new TemplateEngine({ tvTemplate: "a\\b" });
    expect(engine.renderEpisode(episode, ".")).toBe("ab.");
  });

  it("does not double an extension the template already produced", () => {
    const engine = new TemplateEngine({ movieTemplate: "{title}.{ext}" });
    const movie = createMovie({ id: 1, title: "M", originalTitle: "M", year: 1999 });
    expect(engine.renderMovie(movie, "..mkv")).toBe("M.mkv");
  });

  it("lets extra context override and blank fields", () => {
    const engine = new TemplateEngine({ movieTemplate: "{title} [{quality}] {source}" });
    const movie = createMovie({ id: 1, title: "M", originalTitle: "O", year: 1999 });
    expect(engine.renderMovie(movie, ".mkv", { quality: undefined, source: "BluRay" })).toBe("M [] BluRay.mkv");
    expect(engine.renderMovie(movie, ".mkv", { title: "Override", quality: "1080p" })).toBe("Override [1080p] .mkv");
  });

  it("renders original_title", () => {
    const engine = new TemplateEngine({ movieTemplate: "{original_title} ({year})" });
    const movie = createMovie({ id: 1, title: "Spirited Away", originalTitle: "Sen to Chihiro", year: 2001 });
    expect(engine.renderMovie(movie)).toBe("Sen to Chihiro (2001)");
  });

  it("cleanPath without slashes cleans the whole string", () => {
    expect(new TemplateEngine().cleanPath('a:b*c?"d"')).toBe("abcd");
  });
});

describe("renderTrack", () => {
  const acdc = createArtist({ id: "x", name: "AC/DC" });
  const album = createAlbum({ id: "y", title: "Back in Black", artist: acdc, year: 1980 });
  const track = createTrack({
    id: "z",
    title: "Hells Bells",
    artist: acdc,
    album,
    trackNumber: 1,
    genres: ["Rock"],
  });

  it("uses the default music template (a slash in an artist name does not create a folder)", () => {
    expect(new TemplateEngine().renderTrack(track, ".flac")).toBe("ACDC/Back in Black (1980)/01 - Hells Bells.flac");
  });

  it("fills every music field", () => {
    const engine = new TemplateEngine({
      musicTemplate: "{album_artist} - {track} - {disc} - {disc2} - {genre} - {year} - {ext}",
    });
    expect(engine.renderTrack(track, "flac")).toBe("ACDC - 1 -  - 01 - Rock - 1980 - flac.flac");
  });

  it("handles a track with no album, number, or genre", () => {
    const solo = createTrack({ id: "z", title: "Solo", artist: createArtist({ id: "a", name: "Me" }) });
    expect(new TemplateEngine().renderTrack(solo, ".mp3")).toBe("Me/ ()/00 - Solo.mp3");
    const engine = new TemplateEngine({
      musicTemplate: "{album_artist}|{track}|{track2}|{disc2}|{genre}|{year}|{album}",
    });
    expect(engine.renderTrack(solo, "")).toBe("Me0001");
  });

  it("uses the album artist for compilations", () => {
    const various = createArtist({ id: "v", name: "Various Artists" });
    const comp = createAlbum({ id: "c", title: "Hits", artist: various, year: 2001 });
    const t = createTrack({ id: "t", title: "Song", artist: acdc, album: comp, trackNumber: 12, discNumber: 2 });
    const engine = new TemplateEngine({ musicTemplate: "{album_artist}/{album}/{disc2}-{track2} {artist} - {title}" });
    expect(engine.renderTrack(t, ".mp3")).toBe("Various Artists/Hits/02-12 ACDC - Song.mp3");
  });
});

describe("helpers and documentation", () => {
  it("documents every valid field", () => {
    expect(Object.keys(TemplateEngine.getAvailableFields()).sort()).toEqual([...TemplateEngine.VALID_FIELDS].sort());
  });

  it("documents every formatter", () => {
    const documented = Object.keys(TemplateEngine.getAvailableFormatters()).map((k) => k.split(":")[0]);
    expect(documented.sort()).toEqual(Object.keys(TemplateEngine.FORMATTERS).sort());
  });

  it("uses the Python defaults", () => {
    const engine = new TemplateEngine();
    expect(engine.movieTemplate).toBe("{title} ({year})");
    expect(engine.tvTemplate).toBe("{title} - S{season2}E{episode2} - {episode_title}");
    expect(engine.musicTemplate).toBe("{artist}/{album} ({year})/{track2} - {title}");
  });

  it("zfill and pyTitle follow Python", () => {
    expect(zfill("42", 5)).toBe("00042");
    expect(zfill("+42", 5)).toBe("+0042");
    expect(zfill("12345", 3)).toBe("12345");
    expect(pyTitle("o'neil mcdonald-smith")).toBe("O'Neil Mcdonald-Smith");
    expect(pyTitle("")).toBe("");
  });
});

describe("slashes in metadata values", () => {
  it("keeps a movie with a slash in its title in one file, not a folder", () => {
    const movie = createMovie({ id: 1, title: "Face/Off", originalTitle: "Face/Off", year: 1997 });
    expect(new TemplateEngine().renderMovie(movie, ".mkv")).toBe("FaceOff (1997).mkv");
  });

  it("still creates folders from slashes written in the template", () => {
    const movie = createMovie({ id: 1, title: "Face/Off", originalTitle: "Face/Off", year: 1997 });
    const engine = new TemplateEngine({ movieTemplate: "{title} ({year})/{title}" });
    expect(engine.renderMovie(movie, ".mkv")).toBe("FaceOff (1997)/FaceOff.mkv");
  });

  it("removes slashes in render() values too", () => {
    expect(new TemplateEngine().render("{artist}/{title}", { artist: "AC/DC", title: "T.N.T." })).toBe(
      "ACDC/T.N.T.",
    );
  });
});
