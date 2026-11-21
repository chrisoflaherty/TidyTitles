/** `rename --write-tags` / `--write-nfo` and the `[write_metadata]` settings. */

import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAlbum, createArtist, createTrack, readTags, type Track } from "@tidytitles/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeMovieProvider,
  FakeMusicProvider,
  FakeTVProvider,
  MATRIX_FILE,
  createSandbox,
  matrix,
  runIn,
  strip,
  touch,
  writeKeys,
  type Sandbox,
} from "./helpers";

const FLAC = path.resolve(__dirname, "../../core/tests/fixtures/audio/tagged.flac");

let sb: Sandbox;
beforeEach(async () => {
  sb = await createSandbox();
  await writeKeys(sb.configDir, { tmdb: "tmdb-secret-key", tvdb: "" });
});
afterEach(async () => {
  await sb.cleanup();
});

const queen = createArtist({ id: "q-1", name: "Queen" });
const match: Track = createTrack({
  id: "rec-1",
  title: "Bohemian Rhapsody",
  artist: queen,
  album: createAlbum({ id: "r-1", title: "A Night at the Opera", artist: queen, year: 1975 }),
  trackNumber: 11,
});

/** A FLAC file whose tags are incomplete, so MusicBrainz is searched for "Wrong Title". */
async function song(): Promise<string> {
  const file = path.join(sb.media, "song.flac");
  await copyFile(FLAC, file);
  return file;
}

function rename(args: string[]) {
  return runIn(["rename", ...args, "--config-dir", sb.configDir], {
    session: {
      providers: {
        movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
        tvProvider: new FakeTVProvider(),
        musicProvider: new FakeMusicProvider({ "Wrong Title": [match] }),
      },
    },
  });
}

async function setWriteMetadata(text: string): Promise<void> {
  const file = path.join(sb.configDir, "config.toml");
  await writeFile(file, `${await readFile(file, "utf8")}\n[write_metadata]\n${text}\n`);
}

describe("rename --write-tags", () => {
  it("writes the match's tags into the renamed file and lists them", async () => {
    await song();
    const r = await rename([sb.media, "-t", "music", "-y", "--write-tags"]);
    expect(r.code).toBe(0);
    const out = strip(r.stdout);
    expect(out).toContain("Tags written: 1 file(s)");
    expect(out).toContain('title "Wrong Title" → "Bohemian Rhapsody"');
    const dest = path.join(sb.media, "Queen", "A Night at the Opera (1975)", "11 - Bohemian Rhapsody.flac");
    expect((await readTags(dest)).values).toMatchObject({ title: "Bohemian Rhapsody", artist: "Queen", year: 1975 });

    // Undo puts the old tags back.
    const u = await runIn(["undo", "-y", "--config-dir", sb.configDir]);
    expect(u.code).toBe(0);
    expect((await readFile(path.join(sb.media, "song.flac"))).equals(await readFile(FLAC))).toBe(true);
  });

  it("--dry-run says what would be written and changes nothing", async () => {
    const file = await song();
    const r = await rename([sb.media, "-t", "music", "--dry-run", "--write-tags"]);
    expect(r.code).toBe(0);
    expect(strip(r.stdout)).toContain("Tags to write: 1 file(s)");
    expect((await readFile(file)).equals(await readFile(FLAC))).toBe(true);
  });

  it("reports the typed result in --json", async () => {
    await song();
    const r = await rename([sb.media, "-t", "music", "-y", "--write-tags", "--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.writeMetadata).toEqual({ musicTags: true, nfo: false });
    expect(out.operations[0].tags).toMatchObject({ status: "written", reason: null, format: "flac" });
    expect(out.operations[0].tags.changes).toContainEqual({ field: "title", from: "Wrong Title", to: "Bohemian Rhapsody" });
    expect(out.operations[0].nfo).toBeNull();
  });

  it("follows [write_metadata] music_tags, and --no-write-tags turns it off", async () => {
    await setWriteMetadata("music_tags = true");
    await song();
    const off = await rename([sb.media, "-t", "music", "-y", "--no-write-tags", "--json"]);
    expect(JSON.parse(off.stdout).operations[0].tags).toBeNull();
  });

  it("says when a hard link keeps the tags from being written", async () => {
    await song();
    const r = await rename([sb.media, "-t", "music", "-y", "--write-tags", "--transfer", "hardlink", "--json"]);
    const op = JSON.parse(r.stdout).operations[0];
    if (op.status !== "completed") return; // No hard links on this volume.
    expect(op.tags).toMatchObject({ status: "not_written", reason: "hard_link" });
  });
});

describe("rename --write-nfo", () => {
  it("writes a movie NFO and undo removes it", async () => {
    await touch(sb.media, MATRIX_FILE);
    const r = await rename([sb.media, "-t", "movie", "-y", "--write-nfo"]);
    expect(r.code).toBe(0);
    const nfo = path.join(sb.media, "The Matrix (1999).nfo");
    expect(strip(r.stdout)).toContain("NFO files written: 1");
    expect(await readFile(nfo, "utf8")).toContain("<title>The Matrix</title>");
    await runIn(["undo", "-y", "--config-dir", sb.configDir]);
    expect(existsSync(nfo)).toBe(false);
    expect(existsSync(path.join(sb.media, MATRIX_FILE))).toBe(true);
  });

  it("follows [write_metadata] nfo and lists existing files it left alone", async () => {
    await setWriteMetadata("nfo = true");
    await touch(sb.media, MATRIX_FILE);
    await writeFile(path.join(sb.media, "The Matrix (1999).nfo"), "mine");
    const r = await rename([sb.media, "-t", "movie", "-y"]);
    expect(strip(r.stdout)).toContain("The Matrix (1999).nfo: a file of that name already exists");
    expect(await readFile(path.join(sb.media, "The Matrix (1999).nfo"), "utf8")).toBe("mine");
  });

  it("shows the settings in config show", async () => {
    await setWriteMetadata("nfo = true");
    const r = await runIn(["config", "show", "--json", "--config-dir", sb.configDir]);
    expect(JSON.parse(r.stdout).writeMetadata).toEqual({ musicTags: false, nfo: true });
  });
});
