/** Tests for the music file parser (port of tests/test_music_parser.py, plus tag tests). */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MUSIC_EXTENSIONS,
  MusicFilenameParser,
  MusicMetadataParser,
  createMusicParser,
  isMusicFile,
} from "../src/musicParser";

// Wrap the real parseFile so individual tests can stub a result while the
// real-file tests still read actual audio.
vi.mock("music-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  return { ...actual, parseFile: vi.fn(actual.parseFile) };
});

const mockedParseFile = vi.mocked(parseFile);

describe("MusicFilenameParser", () => {
  const parser = new MusicFilenameParser();

  it("parses 'Artist - Album - 01 - Title'", async () => {
    const result = await parser.parse("Pink Floyd - The Wall - 06 - Comfortably Numb.mp3");

    expect(result.artist).toBe("Pink Floyd");
    expect(result.album).toBe("The Wall");
    expect(result.trackNumber).toBe(6);
    expect(result.title).toBe("Comfortably Numb");
    expect(result.source).toBe("filename");
  });

  it("parses '01 - Artist - Title'", async () => {
    const result = await parser.parse("06 - Pink Floyd - Comfortably Numb.flac");

    expect(result.trackNumber).toBe(6);
    expect(result.artist).toBe("Pink Floyd");
    expect(result.title).toBe("Comfortably Numb");
    expect(result.source).toBe("filename");
  });

  it("parses 'Artist - Title'", async () => {
    const result = await parser.parse("Pink Floyd - Comfortably Numb.mp3");

    expect(result.artist).toBe("Pink Floyd");
    expect(result.title).toBe("Comfortably Numb");
    expect(result.trackNumber).toBeUndefined();
    expect(result.source).toBe("filename");
  });

  it("parses '01. Title'", async () => {
    const result = await parser.parse("06. Comfortably Numb.mp3");

    expect(result.trackNumber).toBe(6);
    expect(result.title).toBe("Comfortably Numb");
    expect(result.artist).toBeUndefined();
    expect(result.source).toBe("filename");
  });

  it("parses '01 Title'", async () => {
    const result = await parser.parse("06 Comfortably Numb.mp3");

    expect(result.trackNumber).toBe(6);
    expect(result.title).toBe("Comfortably Numb");
    expect(result.artist).toBeUndefined();
    expect(result.source).toBe("filename");
  });

  it("falls back to the stem as title for unrecognized names", async () => {
    const result = await parser.parse("random_track.mp3");

    expect(result.title).toBe("random_track");
    expect(result.artist).toBeUndefined();
    expect(result.trackNumber).toBeUndefined();
    expect(result.source).toBe("filename");
  });

  it("reads music extensions", () => {
    expect(parser.canRead("song.mp3")).toBe(true);
    expect(parser.canRead("song.flac")).toBe(true);
    expect(parser.canRead("song.m4a")).toBe(true);
    expect(parser.canRead("song.ogg")).toBe(true);
  });

  it("does not read non-music files", () => {
    expect(parser.canRead("video.mkv")).toBe(false);
    expect(parser.canRead("video.mp4")).toBe(false);
    expect(parser.canRead("document.txt")).toBe(false);
  });

  // Additional coverage beyond the Python suite.
  it("returns the complete record, using only the file name of a full path", () => {
    expect(parser.parseSync("/music/Pink Floyd/The Wall/06 - Pink Floyd - Comfortably Numb.flac")).toEqual({
      title: "Comfortably Numb",
      artist: "Pink Floyd",
      trackNumber: 6,
      rawFilename: "06 - Pink Floyd - Comfortably Numb.flac",
      source: "filename",
    });
  });

  it("trims spaces around dashes", () => {
    expect(parser.parseSync("Queen  -  Bohemian Rhapsody .mp3")).toMatchObject({
      artist: "Queen",
      title: "Bohemian Rhapsody",
    });
  });

  it("splits at the first dash for 'Artist - Title - Extra'", () => {
    expect(parser.parseSync("AC-DC - Back in Black - Live.mp3")).toMatchObject({
      artist: "AC",
      title: "DC - Back in Black - Live",
    });
  });

  it("keeps dots inside a stem", () => {
    expect(parser.parseSync("Mr. Brightside.mp3")).toMatchObject({ title: "Mr. Brightside" });
  });

  it("handles a name with no extension", () => {
    expect(parser.parseSync("05 Untitled")).toMatchObject({ trackNumber: 5, title: "Untitled", rawFilename: "05 Untitled" });
  });

  it("never reads the file", async () => {
    mockedParseFile.mockClear();
    await parser.parse("/does/not/exist/01 - Title.mp3");
    expect(mockedParseFile).not.toHaveBeenCalled();
  });
});

describe("MUSIC_EXTENSIONS", () => {
  it("includes common music extensions", () => {
    for (const ext of [".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav"]) {
      expect(MUSIC_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("excludes video extensions", () => {
    for (const ext of [".mkv", ".mp4", ".avi"]) {
      expect(MUSIC_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  it("matches the Python set exactly", () => {
    expect([...MUSIC_EXTENSIONS].sort()).toEqual(
      [".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".wma", ".aac", ".ape"].sort(),
    );
  });
});

describe("isMusicFile", () => {
  it("is true for music files, case-insensitively", () => {
    expect(isMusicFile("song.mp3")).toBe(true);
    expect(isMusicFile("song.FLAC")).toBe(true);
    expect(isMusicFile("song.M4A")).toBe(true);
    expect(isMusicFile("/a/b/c/song.Opus")).toBe(true);
  });

  it("is false for non-music files", () => {
    expect(isMusicFile("video.mkv")).toBe(false);
    expect(isMusicFile("video.mp4")).toBe(false);
    expect(isMusicFile("mp3")).toBe(false);
    expect(isMusicFile(".mp3")).toBe(false);
  });
});

describe("createMusicParser", () => {
  it("creates a tag-reading parser by default", () => {
    const parser = createMusicParser();
    expect(parser).toBeInstanceOf(MusicMetadataParser);
    expect(typeof parser.parse).toBe("function");
    expect(typeof parser.canRead).toBe("function");
  });

  it("creates a filename parser when tag reading is disabled", () => {
    expect(createMusicParser(false)).toBeInstanceOf(MusicFilenameParser);
  });
});

/** Minimal music-metadata result for stubbing. */
function metadata(
  common: Partial<IAudioMetadata["common"]>,
  duration?: number,
): IAudioMetadata {
  return {
    common: {
      track: { no: null, of: null },
      disk: { no: null, of: null },
      movementIndex: { no: null, of: null },
      ...common,
    },
    format: { duration, tagTypes: [], trackInfo: [], hasAudio: true, hasVideo: false },
    native: {},
    quality: { warnings: [] },
  } as unknown as IAudioMetadata;
}

describe("MusicMetadataParser (mocked music-metadata)", () => {
  const parser = new MusicMetadataParser();

  beforeEach(() => {
    mockedParseFile.mockClear();
  });

  it("maps every tag", async () => {
    mockedParseFile.mockResolvedValueOnce(
      metadata(
        {
          title: "Comfortably Numb",
          artist: "Pink Floyd",
          artists: ["Pink Floyd"],
          album: "The Wall",
          albumartist: "Pink Floyd",
          date: "1979-11-30",
          year: 1979,
          track: { no: 6, of: 13 },
          disk: { no: 2, of: 2 },
          genre: ["Progressive Rock", "Rock"],
        },
        382.4567,
      ),
    );

    const result = await parser.parse("/music/whatever.flac");

    expect(mockedParseFile).toHaveBeenCalledWith("/music/whatever.flac", expect.anything());
    expect(result).toEqual({
      title: "Comfortably Numb",
      artist: "Pink Floyd",
      album: "The Wall",
      albumArtist: "Pink Floyd",
      year: 1979,
      trackNumber: 6,
      discNumber: 2,
      genre: "Progressive Rock",
      durationMs: 382456,
      totalTracks: 13,
      totalDiscs: 2,
      rawFilename: "whatever.flac",
      source: "tags",
    });
  });

  it("uses the first of several artists", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ title: "T", artist: "A & B", artists: ["A", "B"] }));
    expect((await parser.parse("x.mp3")).artist).toBe("A");
  });

  it("takes the year from the first four characters of the date", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ title: "T", date: "2023-01-15" }));
    expect((await parser.parse("x.mp3")).year).toBe(2023);
  });

  it("falls back to the numeric year when the date is unusable", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ title: "T", date: "unknown", year: 1999 }));
    expect((await parser.parse("x.mp3")).year).toBe(1999);
    mockedParseFile.mockResolvedValueOnce(metadata({ title: "T", date: "unknown" }));
    expect((await parser.parse("x.mp3")).year).toBeUndefined();
  });

  it("keeps a title-only file on tags", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ title: "Only Title" }));
    expect(await parser.parse("01 - Someone - Something.mp3")).toEqual({
      title: "Only Title",
      rawFilename: "01 - Someone - Something.mp3",
      source: "tags",
    });
  });

  it("keeps an artist-only file on tags", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ artist: "Only Artist", artists: ["Only Artist"] }));
    expect(await parser.parse("x.mp3")).toMatchObject({ artist: "Only Artist", source: "tags" });
  });

  it("falls back to the filename when there is no title or artist", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ album: "Album Only", title: "", artist: "" }));
    expect(await parser.parse("/x/06 - Pink Floyd - Comfortably Numb.mp3")).toEqual({
      title: "Comfortably Numb",
      artist: "Pink Floyd",
      trackNumber: 6,
      rawFilename: "06 - Pink Floyd - Comfortably Numb.mp3",
      source: "filename",
    });
  });

  it("falls back to the filename when reading fails", async () => {
    mockedParseFile.mockRejectedValueOnce(new Error("corrupt file"));
    expect(await parser.parse("Pink Floyd - Comfortably Numb.mp3")).toMatchObject({
      artist: "Pink Floyd",
      title: "Comfortably Numb",
      source: "filename",
    });
  });

  it("omits the duration when it is unknown", async () => {
    mockedParseFile.mockResolvedValueOnce(metadata({ title: "T" }));
    expect(await parser.parse("x.mp3")).not.toHaveProperty("durationMs");
  });

  it("can read only music extensions", () => {
    expect(parser.canRead("a.MP3")).toBe(true);
    expect(parser.canRead("a.mkv")).toBe(false);
  });
});

// Real audio files, generated with ffmpeg when it is available.
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("MusicMetadataParser (real files)", () => {
  let dir = "";
  const made: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tidytitles-music-"));
    for (const ext of ["flac", "mp3", "m4a"]) {
      const file = path.join(dir, `tone.${ext}`);
      try {
        execFileSync(
          "ffmpeg",
          [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
            "-metadata", "title=Hells Bells",
            "-metadata", "artist=AC/DC",
            "-metadata", "album=Back in Black",
            "-metadata", "album_artist=AC/DC",
            "-metadata", "date=1980-07-25",
            "-metadata", "track=1/10",
            "-metadata", "disc=1/1",
            "-metadata", "genre=Rock",
            file,
          ],
          { stdio: "ignore" },
        );
        made.push(ext);
      } catch {
        // This ffmpeg build lacks the encoder; the test below skips it.
      }
    }
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.2",
        path.join(dir, "07 - Untagged Artist - Untagged Song.flac")],
      { stdio: "ignore" },
    );
    writeFileSync(path.join(dir, "03 - Not Really Audio.mp3"), "this is not an mp3");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(["flac", "mp3", "m4a"])("reads tags from a real .%s file", async (ext) => {
    if (!made.includes(ext)) return;
    const result = await new MusicMetadataParser().parse(path.join(dir, `tone.${ext}`));

    expect(result).toMatchObject({
      title: "Hells Bells",
      artist: "AC/DC",
      album: "Back in Black",
      albumArtist: "AC/DC",
      year: 1980,
      trackNumber: 1,
      discNumber: 1,
      genre: "Rock",
      rawFilename: `tone.${ext}`,
      source: "tags",
    });
    // About 0.5 seconds; encoders add a little padding.
    expect(result.durationMs).toBeGreaterThanOrEqual(450);
    expect(result.durationMs).toBeLessThan(700);
  });

  it("falls back to the filename for an untagged real file", async () => {
    const result = await new MusicMetadataParser().parse(path.join(dir, "07 - Untagged Artist - Untagged Song.flac"));
    expect(result).toEqual({
      title: "Untagged Song",
      artist: "Untagged Artist",
      trackNumber: 7,
      rawFilename: "07 - Untagged Artist - Untagged Song.flac",
      source: "filename",
    });
  });

  it("falls back to the filename for a file that is not audio", async () => {
    const result = await new MusicMetadataParser().parse(path.join(dir, "03 - Not Really Audio.mp3"));
    // As in Python, "Artist - Title" is tried before the track-number patterns.
    expect(result).toEqual({
      title: "Not Really Audio",
      artist: "03",
      rawFilename: "03 - Not Really Audio.mp3",
      source: "filename",
    });
  });

  it("falls back to the filename for a missing file", async () => {
    const result = await new MusicMetadataParser().parse(path.join(dir, "missing", "01. Ghost.flac"));
    expect(result).toMatchObject({ trackNumber: 1, title: "Ghost", source: "filename" });
  });
});
