import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  associatedFileExtension,
  associatedFileName,
  findAssociatedFiles,
  generateAssociatedDestination,
  getExtensionsFromSettings,
  getFileType,
  pathStem,
  pathSuffix,
} from "../src/associatedFiles";

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-assoc-"));
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

async function touch(...names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const p = path.join(tmpdir, name);
      await writeFile(p, "");
      return p;
    }),
  );
}

describe("getFileType", () => {
  it("detects subtitle extensions", () => {
    expect(getFileType("movie.srt")).toBe("subtitle");
    expect(getFileType("movie.vtt")).toBe("subtitle");
    expect(getFileType("movie.ass")).toBe("subtitle");
  });

  it("detects NFO extensions", () => {
    expect(getFileType("movie.nfo")).toBe("nfo");
  });

  it("detects image extensions", () => {
    expect(getFileType("movie.jpg")).toBe("image");
    expect(getFileType("movie.png")).toBe("image");
  });

  it("returns other for unknown extensions", () => {
    expect(getFileType("movie.txt")).toBe("other");
  });

  it("ignores extension case", () => {
    expect(getFileType("movie.SRT")).toBe("subtitle");
  });
});

describe("getExtensionsFromSettings", () => {
  it("includes everything when all are enabled", () => {
    const exts = getExtensionsFromSettings({
      includeSubtitles: true,
      includeNfo: true,
      includeImages: true,
    });
    expect(exts.has(".srt")).toBe(true);
    expect(exts.has(".nfo")).toBe(true);
    expect(exts.has(".jpg")).toBe(true);
  });

  it("includes only subtitles", () => {
    const exts = getExtensionsFromSettings({
      includeSubtitles: true,
      includeNfo: false,
      includeImages: false,
    });
    expect(exts.has(".srt")).toBe(true);
    expect(exts.has(".nfo")).toBe(false);
    expect(exts.has(".jpg")).toBe(false);
  });

  it("is empty when all are disabled", () => {
    const exts = getExtensionsFromSettings({
      includeSubtitles: false,
      includeNfo: false,
      includeImages: false,
    });
    expect(exts.size).toBe(0);
  });

  it("defaults every option to true", () => {
    expect(getExtensionsFromSettings().size).toBe(11);
  });
});

describe("findAssociatedFiles", () => {
  it("finds a subtitle file", async () => {
    const [video, subtitle] = await touch("movie.mkv", "movie.srt");

    const associated = await findAssociatedFiles(video!);

    expect(associated).toHaveLength(1);
    expect(associated[0]!.path).toBe(subtitle);
    expect(associated[0]!.fileType).toBe("subtitle");
    expect(associatedFileName(associated[0]!)).toBe("movie.srt");
    expect(associatedFileExtension(associated[0]!)).toBe(".srt");
  });

  it("finds multiple associated files", async () => {
    const [video] = await touch("movie.mkv", "movie.srt", "movie.nfo", "movie.jpg");

    const associated = await findAssociatedFiles(video!);

    expect(associated).toHaveLength(3);
    const types = new Set(associated.map((a) => a.fileType));
    expect(types).toEqual(new Set(["subtitle", "nfo", "image"]));
  });

  it("finds language-specific subtitles", async () => {
    const [video] = await touch("movie.mkv", "movie.en.srt", "movie.es.srt");

    const associated = await findAssociatedFiles(video!);

    expect(associated).toHaveLength(2);
    const names = new Set(associated.map((a) => path.basename(a.path)));
    expect(names).toEqual(new Set(["movie.en.srt", "movie.es.srt"]));
  });

  it("returns nothing when no associated files exist", async () => {
    const [video] = await touch("movie.mkv");
    expect(await findAssociatedFiles(video!)).toHaveLength(0);
  });

  it("honors a custom extension set", async () => {
    const [video] = await touch("movie.mkv", "movie.srt", "movie.nfo");

    const associated = await findAssociatedFiles(video!, new Set([".srt"]));

    expect(associated).toHaveLength(1);
    expect(associated[0]!.fileType).toBe("subtitle");
  });

  it("ignores files with a different base name and unknown extensions", async () => {
    const [video] = await touch("movie.mkv", "other.srt", "movie.txt", "movie2.srt");
    expect(await findAssociatedFiles(video!)).toHaveLength(0);
  });

  it("does not list a file twice", async () => {
    const [video] = await touch("movie.mkv", "movie.srt", "movie.en.srt");
    const associated = await findAssociatedFiles(video!);
    const paths = associated.map((a) => a.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(2);
  });
});

describe("generateAssociatedDestination", () => {
  const movies = path.join(path.sep, "movies");

  it("renames a simple subtitle", () => {
    const dest = generateAssociatedDestination(
      path.join(movies, "old_name.srt"),
      "New Movie (2024)",
    );
    expect(path.basename(dest)).toBe("New Movie (2024).srt");
    expect(path.dirname(dest)).toBe(movies);
  });

  it("keeps a language code", () => {
    const dest = generateAssociatedDestination(
      path.join(movies, "old_name.en.srt"),
      "New Movie (2024)",
    );
    expect(path.basename(dest)).toBe("New Movie (2024).en.srt");
    expect(path.dirname(dest)).toBe(movies);
  });

  it("renames an NFO file", () => {
    const dest = generateAssociatedDestination(
      path.join(movies, "old_name.nfo"),
      "New Movie (2024)",
    );
    expect(path.basename(dest)).toBe("New Movie (2024).nfo");
  });

  it("renames an image file", () => {
    const dest = generateAssociatedDestination(
      path.join(movies, "old_name.jpg"),
      "New Movie (2024)",
    );
    expect(path.basename(dest)).toBe("New Movie (2024).jpg");
  });

  it("uses the original media stem to find the suffix", () => {
    const dest = generateAssociatedDestination(
      path.join(movies, "Movie.Name.2024.forced.en.srt"),
      "Movie Name (2024)",
      "Movie.Name.2024",
    );
    expect(path.basename(dest)).toBe("Movie Name (2024).forced.en.srt");
  });

  it("does not mistake a dotted media name for a language code when the stem is known", () => {
    const dest = generateAssociatedDestination(
      path.join(movies, "Movie.Name.srt"),
      "Movie Name (2024)",
      "Movie.Name",
    );
    expect(path.basename(dest)).toBe("Movie Name (2024).srt");
  });

  it("only treats short alphabetic segments as language codes", () => {
    expect(
      path.basename(
        generateAssociatedDestination(path.join(movies, "Movie.2024.srt"), "New"),
      ),
    ).toBe("New.srt");
    expect(
      path.basename(
        generateAssociatedDestination(path.join(movies, "Movie.english.srt"), "New"),
      ),
    ).toBe("New.srt");
    expect(
      path.basename(generateAssociatedDestination(path.join(movies, "Movie.fra.srt"), "New")),
    ).toBe("New.fra.srt");
  });
});

describe("pathSuffix and pathStem", () => {
  it("follow Python pathlib rules", () => {
    expect(pathSuffix("/a/movie.en.srt")).toBe(".srt");
    expect(pathStem("/a/movie.en.srt")).toBe("movie.en");
    expect(pathSuffix("/a/.hidden")).toBe("");
    expect(pathStem("/a/.hidden")).toBe(".hidden");
    expect(pathSuffix("/a/noext")).toBe("");
    expect(pathSuffix("/a/trailing.")).toBe("");
    expect(pathStem("/a/trailing.")).toBe("trailing.");
  });
});
