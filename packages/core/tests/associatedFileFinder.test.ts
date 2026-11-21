import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssociatedFileFinder } from "../src/associatedFileFinder";
import { findAssociatedFiles, getExtensionsFromSettings } from "../src/associatedFiles";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-finder-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NAMES = [
  "Movie.mkv", "Movie.srt", "Movie.en.srt", "Movie.forced.en.srt", "Movie.EN.SUB", "Movie.nfo", "Movie.jpg",
  "Movie.en.txt", "Movie 2.mkv", "Movie 2.srt", "Movie..srt", "Movie.", "Movie.2001.mkv", "Movie.2001.en.srt",
  "Movie.2001.1080p.mkv", ".hidden.srt", "Amélie.mkv", "Amélie.fr.srt", "a.mkv", "a.b.srt", "a-b.srt", "Z.mkv",
  "Movie-poster.jpg", "Movie.mkv.srt",
];

describe("AssociatedFileFinder", () => {
  it("finds exactly what findAssociatedFiles finds, in the same order", async () => {
    for (const name of NAMES) await writeFile(path.join(dir, name), "");
    const finder = new AssociatedFileFinder();
    for (const settings of [
      { includeSubtitles: true, includeNfo: true, includeImages: true },
      { includeSubtitles: true, includeNfo: false, includeImages: false },
    ]) {
      const extensions = getExtensionsFromSettings(settings);
      for (const name of NAMES.filter((n) => n.endsWith(".mkv"))) {
        const media = path.join(dir, name);
        expect(await finder.find(media, extensions), name).toEqual(await findAssociatedFiles(media, extensions));
      }
    }
  });

  it("returns nothing for a folder that does not exist", async () => {
    const extensions = getExtensionsFromSettings({ includeSubtitles: true, includeNfo: true, includeImages: true });
    await expect(new AssociatedFileFinder().find(path.join(dir, "missing", "x.mkv"), extensions)).resolves.toEqual([]);
  });
});
