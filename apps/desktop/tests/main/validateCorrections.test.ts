import { describe, expect, it } from "vitest";
import {
  IpcValidationError,
  parseFileId,
  parseMatchChoice,
  parseMatchQuery,
  parseNewName,
} from "../../src/main/validate";

describe("correction IPC arguments", () => {
  it("accepts file ids and rejects anything else", () => {
    expect(parseFileId(3)).toBe(3);
    for (const bad of [-1, 1.5, "3", null, Number.NaN]) {
      expect(() => parseFileId(bad)).toThrow(IpcValidationError);
    }
  });

  it("parses each kind of query, dropping absent fields", () => {
    expect(parseMatchQuery({ mediaType: "movie", title: "Inception", year: 2010 })).toEqual({
      mediaType: "movie",
      title: "Inception",
      year: 2010,
    });
    expect(parseMatchQuery({ mediaType: "tv_episode", title: "Lost", season: 1, episode: 2, year: null })).toEqual({
      mediaType: "tv_episode",
      title: "Lost",
      season: 1,
      episode: 2,
    });
    expect(parseMatchQuery({ mediaType: "music", title: "Song", artist: "Band" })).toEqual({
      mediaType: "music",
      title: "Song",
      artist: "Band",
    });
  });

  it("rejects malformed queries", () => {
    const bad: unknown[] = [
      null,
      "Inception",
      { mediaType: "book", title: "x" },
      { mediaType: "movie" },
      { mediaType: "movie", title: 5 },
      { mediaType: "movie", title: "x", year: -1 },
      { mediaType: "movie", title: "x", year: 2.5 },
      { mediaType: "movie", title: "x", season: 1 },
      { mediaType: "tv_episode", title: "x", episode: "2" },
      { mediaType: "music", title: "x", artist: 3 },
      { mediaType: "movie", title: "x".repeat(501) },
      { mediaType: "movie", title: "a\0b" },
    ];
    for (const value of bad) expect(() => parseMatchQuery(value), JSON.stringify(value)).toThrow(IpcValidationError);
  });

  it("parses a choice from a search", () => {
    expect(parseMatchChoice("id-1", 0, { applyToSimilar: true, season: 2, episode: 3 })).toEqual({
      searchId: "id-1",
      index: 0,
      options: { applyToSimilar: true, season: 2, episode: 3 },
    });
    expect(() => parseMatchChoice("id", -1, { applyToSimilar: false })).toThrow(IpcValidationError);
    expect(() => parseMatchChoice("id", 0, { applyToSimilar: "yes" })).toThrow(IpcValidationError);
    expect(() => parseMatchChoice("id", 0, { applyToSimilar: false, path: "/etc" })).toThrow(IpcValidationError);
    expect(() => parseMatchChoice("x".repeat(65), 0, { applyToSimilar: false })).toThrow(IpcValidationError);
  });

  it("accepts a typed name as a string or null (core checks it again)", () => {
    expect(parseNewName("New Name")).toBe("New Name");
    expect(parseNewName(null)).toBeNull();
    expect(() => parseNewName(undefined)).toThrow(IpcValidationError);
    expect(() => parseNewName("a\0")).toThrow(IpcValidationError);
  });
});
