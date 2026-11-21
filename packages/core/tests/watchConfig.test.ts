import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSettings, settingsToToml } from "../src/config";
import { finalNameOf, hasCompanion, isFinderBusyDate, isInsideOrEqual, isSkippedFolderName, isTemporaryName } from "../src/watchNames";

describe("[watch] settings", () => {
  it("has defaults when the table is missing (existing config.toml files load unchanged)", () => {
    const settings = parseSettings('[templates]\nmovie = "{title}"\n');
    expect(settings.watch).toEqual({ enabled: false, folders: [], recursive: true, mode: "review", settleSeconds: 10 });
    expect(settings.templates.movie).toBe("{title}");
  });

  it("reads the table and writes it back", () => {
    const text = '[watch]\nenabled = true\nfolders = ["/srv/in", " /srv/in ", "", "/srv/other"]\nrecursive = false\nmode = "automatic"\nsettle_seconds = 30\n';
    const settings = parseSettings(text);
    expect(settings.watch).toEqual({
      enabled: true,
      folders: ["/srv/in", "/srv/other"],
      recursive: false,
      mode: "automatic",
      settleSeconds: 30,
    });
    expect(parseSettings(settingsToToml(settings)).watch).toEqual(settings.watch);
    expect(settingsToToml(settings)).toContain('folders = ["/srv/in", "/srv/other"]');
  });

  it("writes folders with quotes and backslashes safely (Windows paths)", () => {
    const settings = parseSettings("");
    settings.watch.folders = ["C:\\Users\\Me\\Downloads", 'D:\\odd "name"'];
    expect(parseSettings(settingsToToml(settings)).watch.folders).toEqual(settings.watch.folders);
  });

  it("rejects an unknown mode and an out-of-range settle period", () => {
    expect(() => parseSettings('[watch]\nmode = "yolo"\n')).toThrow(/watch\.mode/);
    expect(() => parseSettings("[watch]\nsettle_seconds = 1\n")).toThrow(/watch\.settle_seconds/);
  });

  it("takes values from the environment; the file wins", () => {
    const env = {
      FILE_RENAMER_WATCH__FOLDERS: '["/env/a"]',
      FILE_RENAMER_WATCH__ENABLED: "yes",
      FILE_RENAMER_WATCH__SETTLE_SECONDS: "20",
    };
    expect(parseSettings(undefined, env).watch).toMatchObject({ folders: ["/env/a"], enabled: true, settleSeconds: 20 });
    expect(parseSettings(undefined, { FILE_RENAMER_WATCH__FOLDERS: "/env/single" }).watch.folders).toEqual(["/env/single"]);
    expect(parseSettings('[watch]\nfolders = ["/file"]\n', env).watch.folders).toEqual(["/file"]);
  });
});

describe("temporary names", () => {
  it.each([
    "Movie.mkv.part",
    "Movie.mkv.PART",
    "Movie.mkv.crdownload",
    "Movie.mkv.download",
    "Movie.mkv.!qB",
    "Movie.mkv.!ut",
    "Movie.mkv.opdownload",
    "Movie.mkv.tmp",
    "Movie.mkv.filepart",
    ".Movie.mkv.a1B2c3",
    "~$Movie.mkv",
    "Movie.mkv~",
    "Movie.mkv.sb-5a1c3f2e-Ab12Cd",
  ])("%s is temporary", (name) => {
    expect(isTemporaryName(name)).toBe(true);
  });

  it.each(["Movie.mkv", "Movie.2010.1080p.mkv", "track.flac", "Part.One.2010.mkv", "show.ts"])("%s is not", (name) => {
    expect(isTemporaryName(name)).toBe(false);
  });

  it("knows the final name", () => {
    expect(finalNameOf("Movie.2010.mkv.crdownload")).toBe("Movie.2010.mkv");
    expect(finalNameOf("Movie.2010.mkv.!qB")).toBe("Movie.2010.mkv");
    expect(finalNameOf("Movie.2010.mkv")).toBeUndefined();
  });

  it("finds companions without regard to case", () => {
    expect(hasCompanion("Movie.mkv", new Set(["movie.mkv.part"]))).toBe(true);
    expect(hasCompanion("Movie.mkv", new Set(["movie.mkv.!qb"]))).toBe(true);
    expect(hasCompanion("Movie.mkv", new Set(["other.mkv.part"]))).toBe(false);
  });

  it("skips system and temporary folders", () => {
    expect(isSkippedFolderName("@eaDir")).toBe(true);
    expect(isSkippedFolderName("$RECYCLE.BIN")).toBe(true);
    expect(isSkippedFolderName("Movie.mkv.download")).toBe(true);
    expect(isSkippedFolderName("Season 1")).toBe(false);
  });

  it("recognizes Finder's busy date", () => {
    expect(isFinderBusyDate(Date.UTC(1984, 0, 24, 15, 0, 0))).toBe(true);
    expect(isFinderBusyDate(Date.UTC(2026, 0, 24))).toBe(false);
    expect(isFinderBusyDate(undefined)).toBe(false);
  });

  it("compares folders as the platform does", () => {
    const a = path.resolve("/Media/In");
    expect(isInsideOrEqual(path.join(a, "x"), a, "linux")).toBe(true);
    expect(isInsideOrEqual(path.resolve("/Media/Inbox"), a, "linux")).toBe(false);
    expect(isInsideOrEqual(path.join(a.toLowerCase(), "x"), a, "darwin")).toBe(true);
  });
});
