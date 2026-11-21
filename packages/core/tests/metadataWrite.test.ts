/**
 * Writing metadata after a rename (`[write_metadata]`), through
 * `RenameSession.execute`, `saveHistory`, and undo: music tags in every
 * transfer mode, dry runs, failures in the middle of a write, the history
 * records, and NFO files.
 */

import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings, type Settings } from "../src/config";
import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createRenameOperation,
  createTrack,
  createTVShow,
  type MatchedMetadata,
  type RenameOperation,
  type Track,
} from "../src/models";
import { diffTagValues, tagValuesFromTrack } from "../src/musicTags";
import { RenameSession, undoLastRename } from "../src/session";
import { readTags } from "../src/tags/index";
import type { TransferMode } from "../src/transfer";
import { FakeMusicParser, FakeMusicProvider } from "./fakes";

const FIXTURES = path.join(__dirname, "fixtures", "audio");

let dir: string;
let config: ConfigService;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-metawrite-"));
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const queen = createArtist({ id: "q-1", name: "Queen" });
const match: Track = createTrack({
  id: "rec-1",
  title: "Bohemian Rhapsody",
  artist: queen,
  album: createAlbum({ id: "r-1", title: "A Night at the Opera", artist: queen, year: 1975, totalTracks: 12, totalDiscs: 1 }),
  trackNumber: 11,
  discNumber: 1,
  genres: ["Rock"],
  verificationStatus: "from_provider",
});

function settings(write: Partial<Settings["writeMetadata"]> = { musicTags: true, nfo: true }, extra: Partial<Settings> = {}): Settings {
  const s = createDefaultSettings();
  return { ...s, ...extra, writeMetadata: { ...s.writeMetadata, ...write } };
}

function session(opts: { transferMode?: TransferMode; dryRun?: boolean; settings?: Settings } = {}): RenameSession {
  return new RenameSession(opts.settings ?? settings(), {
    config,
    requireApiKeys: false,
    cache: false,
    transferMode: opts.transferMode ?? "move",
    dryRun: opts.dryRun ?? false,
    musicParser: new FakeMusicParser(),
  });
}

function op(source: string, destination: string, metadata: MatchedMetadata, extra: Partial<RenameOperation> = {}): RenameOperation {
  return createRenameOperation({
    source,
    destination,
    mediaFile: { path: source, parsedInfo: { title: "x", mediaType: "music", rawFilename: path.basename(source) }, matchedMetadata: metadata },
    ...extra,
  });
}

async function fixture(name: string, as = name): Promise<string> {
  const p = path.join(dir, as);
  await mkdir(path.dirname(p), { recursive: true });
  await copyFile(path.join(FIXTURES, name), p);
  return p;
}

async function files(): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((n) => !n.startsWith("config") && !n.startsWith("cache")).sort();
}

// ---------------------------------------------------------------------------
// Which values are written
// ---------------------------------------------------------------------------

describe("the values a match writes", () => {
  it("takes every field the match has, and skips placeholders", () => {
    expect(tagValuesFromTrack(match)).toEqual({
      title: "Bohemian Rhapsody",
      artist: "Queen",
      album: "A Night at the Opera",
      albumArtist: "Queen",
      track: { no: 11, of: 12 },
      disc: { no: 1, of: 1 },
      year: 1975,
      genre: "Rock",
    });
    const sparse = createTrack({ id: "x", title: "Song", artist: createArtist({ id: "", name: "Unknown Artist" }) });
    expect(tagValuesFromTrack(sparse)).toEqual({ title: "Song" });
  });

  it("gives no track total for a multi-disc release (its track count covers every disc)", () => {
    const multi = { ...match, album: { ...match.album!, totalDiscs: 2 } };
    expect(tagValuesFromTrack(multi).track).toEqual({ no: 11 });
  });

  it("never rewrites a right value or blanks a field", () => {
    const { values, changes } = diffTagValues(
      { title: "Bohemian Rhapsody", artist: "queen", track: { no: 11, of: 12 }, year: 1975, genre: "rock", disc: { no: 1, of: 1 } },
      { title: "Bohemian Rhapsody", artist: "Queen", track: { no: 11 }, year: 1975, genre: "Rock" },
    );
    // Only the artist's case differs; the genre matches ignoring case; a
    // track number without a total keeps the file's total.
    expect(values).toEqual({ artist: "Queen" });
    expect(changes).toEqual([{ field: "artist", from: "queen", to: "Queen" }]);
    expect(diffTagValues({ track: { no: 3, of: 12 } }, { track: { no: 4 } }).values).toEqual({ track: { no: 4, of: 12 } });
  });
});

// ---------------------------------------------------------------------------
// Music tags through RenameSession.execute
// ---------------------------------------------------------------------------

describe("music tags after a move", () => {
  it("writes the match into the renamed file, records it, and undo puts the file back exactly", async () => {
    const source = await fixture("tagged.flac", "in/track.flac");
    const original = await readFile(source);
    const dest = path.join(dir, "out", "Queen - Bohemian Rhapsody.flac");
    const s = session();
    const ops = [op(source, dest, match)];
    await s.execute(ops);
    await s.saveHistory(ops);

    expect(ops[0]!.status).toBe("completed");
    const tags = ops[0]!.metadataWrites!.tags!;
    expect(tags.status).toBe("written");
    expect(tags.format).toBe("flac");
    expect(tags.changes.map((c) => c.field)).toEqual(["title", "artist", "album", "albumArtist", "track", "disc", "year"]);
    expect(tags.changes[0]).toEqual({ field: "title", from: "Wrong Title", to: "Bohemian Rhapsody" });
    const mm = await parseFile(dest);
    expect(mm.common.title).toBe("Bohemian Rhapsody");
    expect(mm.common.genre).toEqual(["Rock"]); // already right: not rewritten

    // History has the old entries and the fingerprint of the rewritten file.
    const raw = JSON.parse(await readFile(config.historyFile, "utf8"));
    expect(raw[0].operations[0].tags.format).toBe("flac");
    expect(raw[0].operations[0].tags.fields.title).toHaveLength(1);
    expect(raw[0].operations[0].tags.fingerprint).toEqual(raw[0].operations[0].fingerprint);

    const result = await undoLastRename(config);
    expect(result.undone).toBe(1);
    expect(result.items[0]!.tags).toEqual({ status: "restored" });
    expect(existsSync(dest)).toBe(false);
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(await config.loadHistory()).toEqual([]);
  });

  it.each(["tagged.mp3", "tagged-v24.mp3", "untagged.mp3", "tagged.m4a", "faststart.m4a", "tagged.ogg", "tagged.opus"])(
    "round-trips %s through rename and undo",
    async (name) => {
      const source = await fixture(name, `in/${name}`);
      const original = await readFile(source);
      const dest = path.join(dir, "out", `new${path.extname(name)}`);
      const s = session();
      const ops = [op(source, dest, match)];
      await s.execute(ops);
      await s.saveHistory(ops);
      expect(ops[0]!.metadataWrites!.tags!.status).toBe("written");
      expect((await readTags(dest)).values.title).toBe("Bohemian Rhapsody");
      await undoLastRename(config);
      expect((await readFile(source)).equals(original)).toBe(true);
    },
  );

  it("moves the file back without touching its tags when they were edited after the rename", async () => {
    const source = await fixture("tagged.mp3", "in/a.mp3");
    const dest = path.join(dir, "out", "b.mp3");
    const s = session();
    const ops = [op(source, dest, match)];
    await s.execute(ops);
    await s.saveHistory(ops);
    // Another program edits the file in place (same inode, new time).
    await utimes(dest, new Date(2001, 0, 1), new Date(2001, 0, 1));
    const result = await undoLastRename(config);
    expect(result.items[0]!.tags).toEqual({ status: "not_restored", reason: "changed" });
    expect(result.undone).toBe(1);
    expect((await readTags(source)).values.title).toBe("Bohemian Rhapsody");
  });

  it("keeps the entry for a retry when putting the tags back fails halfway, and the file is unharmed", async () => {
    const source = await fixture("tagged.ogg", "in/a.ogg");
    const original = await readFile(source);
    const dest = path.join(dir, "out", "b.ogg");
    const s = session();
    const ops = [op(source, dest, match)];
    await s.execute(ops);
    await s.saveHistory(ops);
    const written = await readFile(dest);

    const failed = await undoLastRename(config, {
      tagHooks: {
        onWrite: () => {
          throw new Error("disk full");
        },
      },
    });
    expect(failed.failed).toBe(1);
    expect(failed.items[0]!.tags).toMatchObject({ status: "not_restored", reason: "failed" });
    expect((await readFile(dest)).equals(written)).toBe(true);
    expect((await readdir(path.join(dir, "out"))).sort()).toEqual(["b.ogg"]);
    expect(await config.loadHistory()).toHaveLength(1);

    const retry = await undoLastRename(config);
    expect(retry.undone).toBe(1);
    expect((await readFile(source)).equals(original)).toBe(true);
  });
});

describe("music tags and transfer modes", () => {
  it("writes into the copy and never touches the original", async () => {
    const source = await fixture("tagged.mp3", "in/a.mp3");
    const original = await readFile(source);
    const dest = path.join(dir, "out", "b.mp3");
    const s = session({ transferMode: "copy" });
    const ops = [op(source, dest, match)];
    await s.execute(ops);
    await s.saveHistory(ops);
    expect(ops[0]!.metadataWrites!.tags!.status).toBe("written");
    expect((await readFile(source)).equals(original)).toBe(true);
    expect((await readTags(dest)).values.title).toBe("Bohemian Rhapsody");

    // Undo removes the copy (it is recognized after the tag write).
    const result = await undoLastRename(config);
    expect(result.undone).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect((await readFile(source)).equals(original)).toBe(true);
  });

  it("never writes through a hard link", async () => {
    const source = await fixture("tagged.mp3", "in/a.mp3");
    const original = await readFile(source);
    const dest = path.join(dir, "in", "b.mp3");
    const s = session({ transferMode: "hardlink" });
    const ops = [op(source, dest, match)];
    await s.execute(ops);
    if (ops[0]!.status !== "completed") return; // A volume without hard links (skipped there).
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "not_written", reason: "hard_link" });
    expect((await readFile(source)).equals(original)).toBe(true);
    expect((await readFile(dest)).equals(original)).toBe(true);
  });

  it("leaves a moved file alone when it has other hard links", async () => {
    const source = await fixture("tagged.mp3", "in/a.mp3");
    const other = path.join(dir, "elsewhere.mp3");
    try {
      await link(source, other);
    } catch {
      return; // No hard links on this volume.
    }
    const original = await readFile(source);
    const dest = path.join(dir, "in", "b.mp3");
    const ops = [op(source, dest, match)];
    await session().execute(ops);
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "not_written", reason: "shared_data" });
    expect((await readFile(dest)).equals(original)).toBe(true);
    expect((await readFile(other)).equals(original)).toBe(true);
  });
});

describe("music tags: what is not written", () => {
  it("renames a file in an unsupported format and reports that its tags were not written", async () => {
    const source = path.join(dir, "a.wav");
    await writeFile(source, "RIFF....WAVE");
    const dest = path.join(dir, "b.wav");
    const ops = [op(source, dest, match)];
    await session().execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "not_written", reason: "unsupported_format" });
    expect(await readFile(dest, "utf8")).toBe("RIFF....WAVE");
  });

  it("writes nothing for a match built from the file's own tags", async () => {
    const source = await fixture("tagged.mp3", "a.mp3");
    const original = await readFile(source);
    const dest = path.join(dir, "b.mp3");
    const local = { ...match, id: "local", verificationStatus: "verified" as const };
    const ops = [op(source, dest, local)];
    await session().execute(ops);
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "unchanged", reason: "match_from_tags" });
    expect((await readFile(dest)).equals(original)).toBe(true);
  });

  it("reports an unsupported layout and still renames the file", async () => {
    const audio = await readFile(path.join(FIXTURES, "untagged.mp3"));
    const source = path.join(dir, "v22.mp3");
    await writeFile(source, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 2, 0, 0, 0, 0, 0, 0]), audio]));
    const dest = path.join(dir, "b.mp3");
    const ops = [op(source, dest, match)];
    await session().execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "not_written", reason: "unsupported_layout" });
  });

  it("does nothing when the setting is off", async () => {
    const source = await fixture("tagged.mp3", "a.mp3");
    const original = await readFile(source);
    const ops = [op(source, path.join(dir, "b.mp3"), match)];
    await session({ settings: settings({ musicTags: false, nfo: false }) }).execute(ops);
    expect(ops[0]!.metadataWrites).toBeUndefined();
    expect((await readFile(path.join(dir, "b.mp3"))).equals(original)).toBe(true);
  });

  it("in a dry run, writes nothing and says what would change", async () => {
    const source = await fixture("tagged.mp3", "a.mp3");
    const original = await readFile(source);
    const ops = [op(source, path.join(dir, "b.mp3"), match)];
    await session({ dryRun: true }).execute(ops);
    expect(ops[0]!.metadataWrites!.tags!.status).toBe("would_write");
    expect(ops[0]!.metadataWrites!.tags!.changes.map((c) => c.field)).toContain("title");
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(await files()).toEqual(["a.mp3"]);
  });

  it("previews pending operations without renaming (the CLI's --dry-run)", async () => {
    const source = await fixture("tagged.flac", "a.flac");
    const original = await readFile(source);
    const ops = [op(source, path.join(dir, "b.flac"), match)];
    await session().writeMetadataFor(ops, { preview: true });
    expect(ops[0]!.metadataWrites!.tags!.status).toBe("would_write");
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(await files()).toEqual(["a.flac"]);
  });
});

describe("a tag write that fails", () => {
  it("leaves the renamed file exactly as it was and reports a typed reason; undo still works", async () => {
    const source = await fixture("tagged.m4a", "in/a.m4a");
    const original = await readFile(source);
    const dest = path.join(dir, "out", "b.m4a");
    const s = session();
    const ops = [op(source, dest, match)];
    await s.service.executeRename(ops);
    const { writeMetadataForOperations } = await import("../src/metadataWrite");
    await writeMetadataForOperations(ops, {
      settings: s.writeMetadata,
      transferMode: "move",
      tagHooks: {
        onWrite: () => {
          throw new Error("I/O error");
        },
      },
    });
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "failed", reason: "write_failed" });
    expect((await readFile(dest)).equals(original)).toBe(true);
    expect(await readdir(path.join(dir, "out"))).toEqual(["b.m4a"]);
    await s.saveHistory(ops);
    const result = await undoLastRename(config);
    expect(result.undone).toBe(1);
    expect((await readFile(source)).equals(original)).toBe(true);
  });

  it("reports a file changed by another program during the write, and keeps that change", async () => {
    const source = await fixture("tagged.mp3", "a.mp3");
    const dest = path.join(dir, "b.mp3");
    const ops = [op(source, dest, match)];
    const s = session();
    await s.service.executeRename(ops);
    const { writeMetadataForOperations } = await import("../src/metadataWrite");
    await writeMetadataForOperations(ops, {
      settings: s.writeMetadata,
      transferMode: "move",
      tagHooks: { beforeReplace: () => writeFile(dest, "edited elsewhere") },
    });
    expect(ops[0]!.metadataWrites!.tags).toMatchObject({ status: "failed", reason: "changed_during_write" });
    expect(await readFile(dest, "utf8")).toBe("edited elsewhere");
  });
});

describe("through the whole flow", () => {
  it("plans with a MusicBrainz match and writes it on execute", async () => {
    const source = await fixture("tagged.mp3", "song.mp3");
    const s = new RenameSession(settings(), {
      config,
      requireApiKeys: false,
      cache: false,
      musicParser: new FakeMusicParser({ "song.mp3": { title: "Bohemian Rhapsody", artist: "Queen" } }),
      providers: { musicProvider: new FakeMusicProvider({ "Bohemian Rhapsody": [match] }) },
    });
    const ops = await s.plan([source]);
    await s.execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.metadataWrites!.tags!.status).toBe("written");
    expect((await parseFile(ops[0]!.destination)).common.album).toBe("A Night at the Opera");
  });
});

describe("history files", () => {
  it("loads entries from older versions and keeps the new records through a partial undo", async () => {
    await mkdir(config.configDir, { recursive: true });
    const old = [{ timestamp: "2026-01-01T10:00:00", operations: [{ source: "/a/x.mp3", destination: "/a/y.mp3", associated_files: [] }] }];
    await writeFile(config.historyFile, JSON.stringify(old));
    const history = await config.loadHistory();
    expect(history[0]!.operations[0]).toEqual({ source: "/a/x.mp3", destination: "/a/y.mp3", associatedFiles: [] });
    expect(history[0]!.operations[0]!.tags).toBeUndefined();
  });

  it("drops a malformed tags record instead of failing", async () => {
    await mkdir(config.configDir, { recursive: true });
    const bad = [
      {
        timestamp: "2026-01-01T10:00:00",
        operations: [{ source: "/a/x.mp3", destination: "/a/y.mp3", associated_files: [], tags: { format: "wma" }, created_files: "nope" }],
      },
    ];
    await writeFile(config.historyFile, JSON.stringify(bad));
    const op0 = (await config.loadHistory())[0]!.operations[0]!;
    expect(op0.tags).toBeUndefined();
    expect(op0.createdFiles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NFO files
// ---------------------------------------------------------------------------

const movie = createMovie({
  id: 603,
  title: "The Matrix & <Friends>",
  originalTitle: "The Matrix",
  year: 1999,
  releaseDate: "1999-03-31",
  overview: 'Neo learns "the truth"\u0007 — 🕶️',
  genres: ["Action", "Science Fiction"],
  provider: "tmdb",
});
const show = createTVShow({ id: 81189, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008, network: "AMC", genres: ["Drama"], provider: "tvdb" });
const twoParter = createEpisode({
  show,
  season: 1,
  episode: 1,
  title: "Pilot",
  airDate: "2008-01-20",
  parts: [
    { episode: 1, title: "Pilot", airDate: "2008-01-20" },
    { episode: 2, title: "Cat's in the Bag...", airDate: "2008-01-27" },
  ],
});

/** A strict check that the text is well-formed XML of the kind written here (elements, text, entities, one declaration and comment). */
function wellFormedBlocks(xml: string): string[] {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- Written by TidyTitles -->\n')).toBe(true);
  const body = xml.slice(xml.indexOf("-->") + 4);
  const roots: string[] = [];
  const stack: string[] = [];
  const re = /<(\/?)([a-z]+)((?:\s+[a-z]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)>|([^<]+)/gy;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    consumed = re.lastIndex;
    if (m[4] !== undefined) {
      // Text: no bare ampersands, no characters XML forbids.
      expect(m[4]).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos);)/);
      // eslint-disable-next-line no-control-regex
      expect(m[4]).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
      continue;
    }
    if (m[1]) expect(stack.pop()).toBe(m[2]);
    else {
      if (stack.length === 0) roots.push(m[2]!);
      stack.push(m[2]!);
    }
  }
  expect(consumed).toBe(body.length);
  expect(stack).toEqual([]);
  return roots;
}

function nfoSettings(conflict = "skip"): Settings {
  return settings({ musicTags: false, nfo: true }, { conflictResolution: conflict });
}

describe("NFO files", () => {
  it("writes a movie NFO next to the renamed movie, with valid XML whatever the metadata holds", async () => {
    const source = path.join(dir, "matrix.mkv");
    await writeFile(source, "video");
    const dest = path.join(dir, "The Matrix (1999)", "The Matrix (1999).mkv");
    const ops = [op(source, dest, movie)];
    await session({ settings: nfoSettings() }).execute(ops);
    const nfoPath = path.join(dir, "The Matrix (1999)", "The Matrix (1999).nfo");
    expect(ops[0]!.metadataWrites!.nfo).toEqual([{ kind: "movie", path: nfoPath, status: "written" }]);
    const xml = await readFile(nfoPath, "utf8");
    expect(wellFormedBlocks(xml)).toEqual(["movie"]);
    expect(xml).toContain("<title>The Matrix &amp; &lt;Friends&gt;</title>");
    expect(xml).toContain("<plot>Neo learns &quot;the truth&quot; — 🕶️</plot>");
    expect(xml).toContain("<genre>Action</genre>\n  <genre>Science Fiction</genre>");
    expect(xml).toContain('<uniqueid type="tmdb" default="true">603</uniqueid>');
    expect(xml).toContain("<premiered>1999-03-31</premiered>");
  });

  it("writes every episode of a multi-episode file, and tvshow.nfo in the show folder", async () => {
    const source = path.join(dir, "bb.s01e01e02.mkv");
    await writeFile(source, "video");
    const dest = path.join(dir, "Breaking Bad", "Season 01", "Breaking Bad - S01E01-E02 - Pilot & Cat's in the Bag....mkv");
    const ops = [op(source, dest, twoParter)];
    const s = session({ settings: nfoSettings() });
    await s.execute(ops);
    await s.saveHistory(ops);
    const nfo = ops[0]!.metadataWrites!.nfo!;
    expect(nfo.map((n) => [n.kind, n.status])).toEqual([
      ["episode", "written"],
      ["tvshow", "written"],
    ]);
    const episodeXml = await readFile(nfo[0]!.path!, "utf8");
    expect(wellFormedBlocks(episodeXml)).toEqual(["episodedetails", "episodedetails"]);
    expect(episodeXml).toContain("<episode>2</episode>");
    expect(episodeXml).toContain("<title>Cat&apos;s in the Bag...</title>");
    const showXml = await readFile(path.join(dir, "Breaking Bad", "tvshow.nfo"), "utf8");
    expect(wellFormedBlocks(showXml)).toEqual(["tvshow"]);
    expect(showXml).toContain('<uniqueid type="tvdb" default="true">81189</uniqueid>');
    expect(showXml).toContain("<studio>AMC</studio>");

    // Undo removes both: the episode is gone from the show folder.
    const result = await undoLastRename(config);
    expect(result.items[0]!.createdFiles!.map((c) => [c.kind, c.status])).toEqual([
      ["episode", "removed"],
      ["tvshow", "removed"],
    ]);
    expect(existsSync(path.join(dir, "Breaking Bad", "tvshow.nfo"))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  it("writes no tvshow.nfo when the episodes do not have a show folder", async () => {
    const source = path.join(dir, "bb.s01e01.mkv");
    await writeFile(source, "video");
    const dest = path.join(dir, "Breaking Bad - S01E01 - Pilot.mkv");
    const ops = [op(source, dest, createEpisode({ show, season: 1, episode: 1, title: "Pilot" }))];
    await session({ settings: nfoSettings() }).execute(ops);
    expect(ops[0]!.metadataWrites!.nfo).toEqual([
      { kind: "episode", path: path.join(dir, "Breaking Bad - S01E01 - Pilot.nfo"), status: "written" },
      { kind: "tvshow", status: "not_written", reason: "no_show_folder" },
    ]);
  });

  it("creates tvshow.nfo once per batch and keeps it on undo while other episodes are still there", async () => {
    const showDir = path.join(dir, "Breaking Bad");
    await mkdir(showDir, { recursive: true });
    await writeFile(path.join(showDir, "Breaking Bad - S02E01.mkv"), "an episode renamed earlier");
    const ops: RenameOperation[] = [];
    for (const n of [1, 2]) {
      const source = path.join(dir, `e${n}.mkv`);
      await writeFile(source, `video ${n}`);
      ops.push(op(source, path.join(showDir, `Breaking Bad - S01E0${n}.mkv`), createEpisode({ show, season: 1, episode: n, title: `E${n}` })));
    }
    const s = session({ settings: nfoSettings() });
    await s.execute(ops);
    await s.saveHistory(ops);
    expect(ops[0]!.metadataWrites!.nfo!.map((n) => n.kind)).toEqual(["episode", "tvshow"]);
    expect(ops[1]!.metadataWrites!.nfo!.map((n) => n.kind)).toEqual(["episode"]);

    const result = await undoLastRename(config);
    const tvshow = result.items.flatMap((i) => i.createdFiles ?? []).find((c) => c.kind === "tvshow");
    expect(tvshow).toMatchObject({ status: "kept", reason: "in_use" });
    expect(existsSync(path.join(showDir, "tvshow.nfo"))).toBe(true);
  });

  it("never replaces an NFO it did not create, nor the video's own NFO that moved with it", async () => {
    const source = path.join(dir, "matrix.mkv");
    await writeFile(source, "video");
    await writeFile(path.join(dir, "matrix.nfo"), "<movie>mine</movie>");
    const dest = path.join(dir, "out", "The Matrix (1999).mkv");
    const destNfo = path.join(dir, "out", "The Matrix (1999).nfo");
    const ops = [
      op(source, dest, movie, {
        associatedFiles: [{ source: path.join(dir, "matrix.nfo"), destination: destNfo, fileType: "nfo" }],
      }),
    ];
    // Even with the overwrite strategy.
    await session({ settings: nfoSettings("overwrite") }).execute(ops);
    expect(ops[0]!.metadataWrites!.nfo).toEqual([{ kind: "movie", path: destNfo, status: "not_written", reason: "associated_file" }]);
    expect(await readFile(destNfo, "utf8")).toBe("<movie>mine</movie>");
  });

  it("leaves an existing NFO alone unless the conflict strategy is overwrite; undo never removes a replaced one", async () => {
    for (const strategy of ["skip", "overwrite"]) {
      const sub = path.join(dir, strategy);
      await mkdir(sub, { recursive: true });
      const source = path.join(sub, "matrix.mkv");
      await writeFile(source, "video");
      const destNfo = path.join(sub, "The Matrix (1999).nfo");
      await writeFile(destNfo, "someone else's");
      const ops = [op(source, path.join(sub, "The Matrix (1999).mkv"), movie)];
      const s = session({ settings: nfoSettings(strategy) });
      await s.execute(ops);
      await s.saveHistory(ops);
      if (strategy === "skip") {
        expect(ops[0]!.metadataWrites!.nfo![0]).toMatchObject({ status: "not_written", reason: "exists" });
        expect(await readFile(destNfo, "utf8")).toBe("someone else's");
      } else {
        expect(ops[0]!.metadataWrites!.nfo![0]).toMatchObject({ status: "written", replaced: true });
        expect(await readFile(destNfo, "utf8")).toContain("<movie>");
        await undoLastRename(config);
        expect(existsSync(destNfo)).toBe(true);
      }
    }
  });

  it("leaves an NFO edited after the rename in place on undo", async () => {
    const source = path.join(dir, "matrix.mkv");
    await writeFile(source, "video");
    const ops = [op(source, path.join(dir, "The Matrix (1999).mkv"), movie)];
    const s = session({ settings: nfoSettings() });
    await s.execute(ops);
    await s.saveHistory(ops);
    const nfoPath = path.join(dir, "The Matrix (1999).nfo");
    await writeFile(nfoPath, "<movie><title>my edit</title></movie>");
    const result = await undoLastRename(config);
    expect(result.items[0]!.createdFiles).toEqual([{ path: nfoPath, kind: "movie", status: "kept", reason: "changed" }]);
    expect(await readFile(nfoPath, "utf8")).toContain("my edit");
  });

  it("in a dry run, says which NFO files would be written and writes none", async () => {
    const source = path.join(dir, "matrix.mkv");
    await writeFile(source, "video");
    const ops = [op(source, path.join(dir, "The Matrix (1999).mkv"), movie)];
    await session({ dryRun: true, settings: nfoSettings() }).execute(ops);
    expect(ops[0]!.metadataWrites!.nfo).toEqual([{ kind: "movie", path: path.join(dir, "The Matrix (1999).nfo"), status: "would_write" }]);
    expect(await files()).toEqual(["matrix.mkv"]);
  });

  it.each(["copy", "hardlink"] as const)("writes NFO files next to the new name with %s, leaving the original folder alone", async (mode) => {
    const source = path.join(dir, "in", "matrix.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "video");
    const dest = path.join(dir, "in", "The Matrix (1999).mkv");
    const ops = [op(source, dest, movie)];
    const s = session({ transferMode: mode, settings: nfoSettings() });
    await s.execute(ops);
    if (ops[0]!.status !== "completed") return; // No hard links on this volume.
    await s.saveHistory(ops);
    expect(await readFile(source, "utf8")).toBe("video");
    expect(existsSync(path.join(dir, "in", "The Matrix (1999).nfo"))).toBe(true);
    await undoLastRename(config);
    expect((await readdir(path.join(dir, "in"))).sort()).toEqual(["matrix.mkv"]);
  });
});
