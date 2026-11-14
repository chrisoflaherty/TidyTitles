import { describe, expect, it } from "vitest";
import {
  IpcValidationError,
  isSafeExternalUrl,
  parseDialogKind,
  parseEditableSettings,
  parseFileIds,
  parsePaths,
  parseRunOptions,
  parseSelectionAnswer,
  parseTemplates,
} from "../../src/main/validate";

const validSettings = () => ({
  templates: { movie: "{title}", tv: "{title}", music: "{title}" },
  api: { tmdbApiKey: "a", tvdbApiKey: "", tvdbPin: "" },
  associatedFiles: { enabled: true, subtitles: true, nfo: false, images: true },
  coverArt: { enabled: false, filename: "poster.jpg", musicFilename: "cover.jpg", overwrite: false, size: "w500" },
  conflictResolution: "skip",
  tvProvider: "tvdb",
});

describe("IPC validation", () => {
  it("accepts absolute paths only", () => {
    expect(parsePaths(["/a/b.mkv", "/c"])).toEqual(["/a/b.mkv", "/c"]);
    expect(() => parsePaths(["relative.mkv"])).toThrow(IpcValidationError);
    expect(() => parsePaths("/a")).toThrow(/array/);
    expect(() => parsePaths([42])).toThrow(/string/);
    expect(() => parsePaths(["/a\0b"])).toThrow(/NUL/);
  });

  it("accepts non-negative integer ids", () => {
    expect(parseFileIds([1, 2])).toEqual([1, 2]);
    expect(() => parseFileIds([1.5])).toThrow();
    expect(() => parseFileIds([-1])).toThrow();
    expect(() => parseFileIds(["1"])).toThrow();
  });

  it("checks dialog kinds and run options", () => {
    expect(parseDialogKind("folder")).toBe("folder");
    expect(() => parseDialogKind("anything")).toThrow();
    expect(parseRunOptions({ mediaType: "tv", recursive: false })).toEqual({ mediaType: "tv", recursive: false });
    expect(() => parseRunOptions({ provider: "imdb" })).toThrow();
    expect(() => parseRunOptions({ coverArt: "yes" })).toThrow();
    expect(() => parseRunOptions({ evil: 1 })).toThrow(/unknown option/);
  });

  it("checks selection answers", () => {
    expect(parseSelectionAnswer("abc", 2)).toEqual({ id: "abc", index: 2 });
    expect(parseSelectionAnswer("abc", null)).toEqual({ id: "abc", index: null });
    expect(() => parseSelectionAnswer("abc", -1)).toThrow();
    expect(() => parseSelectionAnswer("abc", "1")).toThrow();
    expect(() => parseSelectionAnswer(5, 1)).toThrow();
  });

  it("checks templates and settings", () => {
    expect(parseTemplates({ movie: "a", tv: "b", music: "c" })).toEqual({ movie: "a", tv: "b", music: "c" });
    expect(() => parseTemplates({ movie: "a", tv: "b" })).toThrow();
    expect(parseEditableSettings(validSettings())).toEqual(validSettings());
    expect(() => parseEditableSettings({ ...validSettings(), conflictResolution: "merge" })).toThrow();
    expect(() => parseEditableSettings({ ...validSettings(), tvProvider: "imdb" })).toThrow();
    const badCover = validSettings();
    badCover.coverArt.filename = "../poster.jpg";
    expect(() => parseEditableSettings(badCover)).toThrow(/without folders/);
    const badSize = validSettings();
    badSize.coverArt.size = "w9999";
    expect(() => parseEditableSettings(badSize)).toThrow();
    // Extra properties are dropped, not passed through.
    const extra = { ...validSettings(), dryRun: true } as Record<string, unknown>;
    expect(parseEditableSettings(extra)).not.toHaveProperty("dryRun");
  });

  it("allows only https URLs out", () => {
    expect(isSafeExternalUrl("https://www.themoviedb.org/settings/api")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("https://user:pw@example.com")).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
  });
});
