import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IpcValidationError,
  isSafeExternalUrl,
  parseDialogKind,
  parseEditableSettings,
  parsePaused,
  parseFileIds,
  parsePaths,
  parseRunOptions,
  parseOptionalFolder,
  parseSelectionAnswer,
  parseTemplates,
  parseTimestamp,
} from "../../src/main/validate";

const MOVIES = path.resolve(os.tmpdir(), "Movies");

const validSettings = () => ({
  templates: { movie: "{title}", tv: "{title}", music: "{title}" },
  api: { tmdbApiKey: "a", tvdbApiKey: "", tvdbPin: "" },
  associatedFiles: { enabled: true, subtitles: true, nfo: false, images: true },
  coverArt: { enabled: false, filename: "poster.jpg", musicFilename: "cover.jpg", overwrite: false, size: "w500" },
  conflictResolution: "skip",
  tvProvider: "tvdb",
  output: { movie: MOVIES, tv: "", music: "", transferMode: "move" },
  history: { maxEntries: 200 },
  tv: { episodeOrder: "aired" },
  metadata: { language: "en-US" },
  writeMetadata: { musicTags: false, nfo: false },
  watch: { enabled: true, folders: ["/srv/in"], recursive: true, mode: "review", settleSeconds: 10 },
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
    expect(() => parseEditableSettings({ ...validSettings(), tv: { episodeOrder: "production" } })).toThrow();
    expect(() => parseEditableSettings({ ...validSettings(), metadata: { language: "German" } })).toThrow(
      /language code/,
    );
    expect(() => parseEditableSettings({ ...validSettings(), tv: undefined })).toThrow();
    expect(() => parseEditableSettings({ ...validSettings(), writeMetadata: { musicTags: "yes", nfo: false } })).toThrow(
      /writeMetadata\.musicTags/,
    );
    expect(() => parseEditableSettings({ ...validSettings(), writeMetadata: undefined })).toThrow();
    expect(
      parseEditableSettings({ ...validSettings(), writeMetadata: { musicTags: true, nfo: false, extra: 1 } }).writeMetadata,
    ).toEqual({ musicTags: true, nfo: false });
    expect(parseEditableSettings({ ...validSettings(), metadata: { language: "pt-BR" } }).metadata.language).toBe(
      "pt-BR",
    );
    // Extra properties are dropped, not passed through.
    const extra = { ...validSettings(), dryRun: true } as Record<string, unknown>;
    expect(parseEditableSettings(extra)).not.toHaveProperty("dryRun");
  });

  it("checks output folders, the transfer mode, and the history limit", () => {
    const relative = validSettings();
    relative.output.movie = "Movies";
    expect(() => parseEditableSettings(relative)).toThrow(/absolute/);
    const mode = validSettings() as Record<string, unknown> & ReturnType<typeof validSettings>;
    (mode.output as Record<string, unknown>).transferMode = "teleport";
    expect(() => parseEditableSettings(mode)).toThrow(/transferMode/);
    for (const maxEntries of [0, 10_001, 2.5, Number.NaN, "200"]) {
      const bad = validSettings() as Record<string, unknown>;
      bad.history = { maxEntries };
      expect(() => parseEditableSettings(bad), String(maxEntries)).toThrow(/maxEntries/);
    }
    const spaced = validSettings();
    spaced.output.tv = `  ${MOVIES}  `;
    expect(parseEditableSettings(spaced).output.tv).toBe(MOVIES);
    expect(() => parseEditableSettings({ ...validSettings(), output: undefined })).toThrow(/output/);
    expect(parseRunOptions({ transferMode: "hardlink" })).toEqual({ transferMode: "hardlink" });
    expect(() => parseRunOptions({ transferMode: "symlink" })).toThrow();
    expect(parseTimestamp("2026-11-14T19:05:42.123000")).toBe("2026-11-14T19:05:42.123000");
    expect(() => parseTimestamp(42)).toThrow();
    expect(() => parseTimestamp("x".repeat(65))).toThrow(/too long/);
    expect(parseOptionalFolder(undefined)).toBeUndefined();
    expect(parseOptionalFolder(MOVIES)).toBe(MOVIES);
    expect(() => parseOptionalFolder("relative")).toThrow(/absolute/);
  });

  it("allows only https URLs out", () => {
    expect(isSafeExternalUrl("https://www.themoviedb.org/settings/api")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("https://user:pw@example.com")).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
  });

  it("checks the watch settings", () => {
    const withWatch = (watch: Record<string, unknown>) => ({ ...validSettings(), watch: { ...validSettings().watch, ...watch } });
    expect(parseEditableSettings(withWatch({ folders: [" /a ", "/a", "/b"] })).watch.folders).toEqual(["/a", "/b"]);
    expect(() => parseEditableSettings(withWatch({ folders: ["relative/path"] }))).toThrow(/absolute/);
    expect(() => parseEditableSettings(withWatch({ folders: "/a" }))).toThrow(/array/);
    expect(() => parseEditableSettings(withWatch({ folders: Array.from({ length: 51 }, (_, i) => `/f${i}`) }))).toThrow(/more than 50/);
    expect(() => parseEditableSettings(withWatch({ mode: "yolo" }))).toThrow(/watch\.mode/);
    expect(() => parseEditableSettings(withWatch({ settleSeconds: 1 }))).toThrow(/settleSeconds/);
    expect(() => parseEditableSettings(withWatch({ settleSeconds: 2.5 }))).toThrow(/settleSeconds/);
    expect(() => parseEditableSettings(withWatch({ enabled: "yes" }))).toThrow(/watch\.enabled/);
    expect(() => parseEditableSettings({ ...validSettings(), watch: undefined })).toThrow();
    expect(parsePaused(true)).toBe(true);
    expect(() => parsePaused("no")).toThrow();
  });
});
