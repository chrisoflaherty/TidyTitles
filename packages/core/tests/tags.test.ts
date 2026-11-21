/**
 * Tag writers (src/tags): for every supported format, the audio is byte for
 * byte the same after writing tags and after putting the old ones back, the
 * file still reads correctly (music-metadata, and ffmpeg when installed),
 * artwork and other tags survive, and undo restores the original bytes.
 *
 * Fixtures in tests/fixtures/audio are tiny files made with ffmpeg:
 * tagged.mp3 (ID3v2.3 with a cover), tagged-v24.mp3 (ID3v2.4), untagged.mp3
 * (no tag), tagged.flac (with a cover and padding), tagged.m4a (moov after
 * mdat, with a cover), faststart.m4a (moov before mdat), tagged.ogg
 * (Vorbis), tagged.opus. Each carries title "Wrong Title", artist
 * "Somebody", album "Some Album", genre "Rock", track 3, and a comment
 * "keep me".
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTagChanges, readTags, RewriteError, TagLayoutError, type FieldChanges, type TagValues } from "../src/tags/index";
import { parsePage } from "../src/tags/ogg";

const FIXTURES = path.join(__dirname, "fixtures", "audio");
const ALL = ["tagged.mp3", "tagged-v24.mp3", "untagged.mp3", "tagged.flac", "tagged.m4a", "faststart.m4a", "tagged.ogg", "tagged.opus"];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-tags-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string): Promise<string> {
  const p = path.join(dir, name);
  await copyFile(path.join(FIXTURES, name), p);
  return p;
}

const NEW: TagValues = {
  title: "Right Title – “quoted” ✓",
  artist: "Ärtist 日本",
  album: "The Album",
  albumArtist: "Various Artists",
  track: { no: 4, of: 12 },
  disc: { no: 1, of: 2 },
  year: 1999,
  genre: "Jazz",
};

function allFields(values: TagValues): FieldChanges {
  const changes: FieldChanges = {};
  for (const k of Object.keys(values) as (keyof TagValues)[]) changes[k] = { kind: "value", values };
  return changes;
}

// ---------------------------------------------------------------------------
// The audio itself, per format
// ---------------------------------------------------------------------------

function syncsafe(b: Buffer, o: number) {
  return ((b[o]! & 0x7f) << 21) | ((b[o + 1]! & 0x7f) << 14) | ((b[o + 2]! & 0x7f) << 7) | (b[o + 3]! & 0x7f);
}

/** MP3: everything after the ID3v2 tag. */
function mp3Audio(buf: Buffer): Buffer {
  return buf.toString("latin1", 0, 3) === "ID3" ? buf.subarray(10 + syncsafe(buf, 6)) : buf;
}

/** FLAC: everything after the metadata blocks. */
function flacAudio(buf: Buffer): Buffer {
  let pos = 4;
  for (;;) {
    const last = buf[pos]! & 0x80;
    const len = (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!;
    pos += 4 + len;
    if (last) return buf.subarray(pos);
  }
}

/** MP4: the samples, read through the chunk offsets and sizes of the sample table. */
function mp4Samples(buf: Buffer): Buffer {
  const find = (start: number, end: number, type: string): [number, number] | undefined => {
    let p = start;
    while (p + 8 <= end) {
      const size = buf.readUInt32BE(p);
      if (buf.toString("latin1", p + 4, p + 8) === type) return [p, p + size];
      p += size;
    }
    return undefined;
  };
  const moov = find(0, buf.length, "moov")!;
  const trak = find(moov[0] + 8, moov[1], "trak")!;
  const mdia = find(trak[0] + 8, trak[1], "mdia")!;
  const minf = find(mdia[0] + 8, mdia[1], "minf")!;
  const stbl = find(minf[0] + 8, minf[1], "stbl")!;
  const stco = find(stbl[0] + 8, stbl[1], "stco")!;
  const stsz = find(stbl[0] + 8, stbl[1], "stsz")!;
  const stsc = find(stbl[0] + 8, stbl[1], "stsc")!;
  const offsets = Array.from({ length: buf.readUInt32BE(stco[0] + 12) }, (_, i) => buf.readUInt32BE(stco[0] + 16 + i * 4));
  const fixed = buf.readUInt32BE(stsz[0] + 12);
  const count = buf.readUInt32BE(stsz[0] + 16);
  const sizes = Array.from({ length: count }, (_, i) => (fixed ? fixed : buf.readUInt32BE(stsz[0] + 20 + i * 4)));
  const runs = Array.from({ length: buf.readUInt32BE(stsc[0] + 12) }, (_, i) => ({
    first: buf.readUInt32BE(stsc[0] + 16 + i * 12),
    perChunk: buf.readUInt32BE(stsc[0] + 20 + i * 12),
  }));
  const out: Buffer[] = [];
  let sample = 0;
  offsets.forEach((offset, c) => {
    const run = [...runs].reverse().find((r) => r.first <= c + 1)!;
    let at = offset;
    for (let k = 0; k < run.perChunk && sample < sizes.length; k += 1) {
      out.push(buf.subarray(at, at + sizes[sample]!));
      at += sizes[sample]!;
      sample += 1;
    }
  });
  return Buffer.concat(out);
}

/** Ogg: the packets after the header packets, joined. */
function oggAudio(buf: Buffer, headerPackets: number): Buffer {
  const packets: Buffer[] = [];
  let current: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const page = parsePage(buf, offset, offset);
    if (!page) break;
    let at = 0;
    for (const size of page.lacing) {
      current.push(page.data.subarray(at, at + size));
      at += size;
      if (size < 255) {
        packets.push(Buffer.concat(current));
        current = [];
      }
    }
    offset += page.length;
  }
  return Buffer.concat(packets.slice(headerPackets + 1));
}

function audioOf(name: string, buf: Buffer): Buffer {
  if (name.endsWith(".mp3")) return mp3Audio(buf);
  if (name.endsWith(".flac")) return flacAudio(buf);
  if (name.endsWith(".m4a")) return mp4Samples(buf);
  if (name.endsWith(".ogg")) return oggAudio(buf, 2);
  return oggAudio(buf, 1);
}

// ---------------------------------------------------------------------------

describe.each(ALL)("%s", (name) => {
  it("writes every field, keeping the audio, the artwork, and the other tags", async () => {
    const file = await fixture(name);
    const before = await readFile(file);
    const mmBefore = await parseFile(file);

    await applyTagChanges(file, () => allFields(NEW));

    const after = await readFile(file);
    expect(audioOf(name, after).equals(audioOf(name, before))).toBe(true);
    expect(audioOf(name, after).length).toBeGreaterThan(0);

    const tags = await readTags(file);
    expect(tags.values).toEqual(NEW);

    const mm = await parseFile(file);
    expect(mm.common.title).toBe(NEW.title);
    expect(mm.common.artist).toBe(NEW.artist);
    expect(mm.common.album).toBe(NEW.album);
    expect(mm.common.albumartist).toBe(NEW.albumArtist);
    expect(mm.common.track).toEqual({ no: 4, of: 12 });
    expect(mm.common.disk).toEqual({ no: 1, of: 2 });
    expect(mm.common.year).toBe(1999);
    expect(mm.common.genre).toEqual(["Jazz"]);
    // Duration and stream properties read the same.
    expect(mm.format.codec).toBe(mmBefore.format.codec);
    expect(mm.format.sampleRate).toBe(mmBefore.format.sampleRate);
    expect(mm.format.numberOfChannels).toBe(mmBefore.format.numberOfChannels);
    // Artwork is untouched.
    expect(mm.common.picture?.map((p) => Buffer.from(p.data).toString("hex"))).toEqual(
      mmBefore.common.picture?.map((p) => Buffer.from(p.data).toString("hex")),
    );
    // The comment tag that is not ours survives.
    if (name !== "untagged.mp3") expect(JSON.stringify(mm.native)).toContain("keep me");
  });

  it("puts the old tags back exactly", async () => {
    const file = await fixture(name);
    const original = await readFile(file);
    const { before } = await applyTagChanges(file, () => allFields(NEW));
    const restore: FieldChanges = {};
    for (const [field, entries] of Object.entries(before.raw)) restore[field as keyof FieldChanges] = { kind: "raw", entries };
    await applyTagChanges(file, () => restore, { targetRegionSize: before.regionSize });

    const restored = await readFile(file);
    expect((await readTags(file)).values).toEqual(before.values);
    expect(audioOf(name, restored).equals(audioOf(name, original))).toBe(true);
    expect(restored.equals(original)).toBe(true);
  });

  it("changes only the fields asked for", async () => {
    const file = await fixture(name);
    const { before } = await applyTagChanges(file, () => ({ title: { kind: "value", values: { title: "Only This" } } }));
    const after = await readTags(file);
    expect(after.values).toEqual({ ...before.values, title: "Only This" });
    for (const field of ["artist", "album", "albumArtist", "track", "disc", "year", "genre"] as const) {
      expect(after.raw[field].map((b) => b.toString("hex"))).toEqual(before.raw[field].map((b) => b.toString("hex")));
    }
  });

  it("leaves no temporary file behind", async () => {
    const file = await fixture(name);
    await applyTagChanges(file, () => allFields(NEW));
    expect(await readdir(dir)).toEqual([name]);
  });
});

describe("safe writing", () => {
  it.each(ALL)("leaves %s untouched when the write fails halfway", async (name) => {
    const file = await fixture(name);
    const original = await readFile(file);
    await expect(
      applyTagChanges(file, () => allFields(NEW), {
        hooks: {
          onWrite: () => {
            throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
          },
        },
      }),
    ).rejects.toMatchObject({ reason: "write_failed" });
    expect((await readFile(file)).equals(original)).toBe(true);
    expect(await readdir(dir)).toEqual([name]);
  });

  it("refuses to replace a file that changed while it was rewritten", async () => {
    const file = await fixture("tagged.flac");
    await expect(
      applyTagChanges(file, () => allFields(NEW), {
        hooks: { beforeReplace: () => writeFile(file, "someone else's data") },
      }),
    ).rejects.toBeInstanceOf(RewriteError);
    expect(await readFile(file, "utf8")).toBe("someone else's data");
    expect(await readdir(dir)).toEqual(["tagged.flac"]);
  });

  it("keeps the file's permissions", async () => {
    if (process.platform === "win32") return; // No POSIX permission bits on Windows.
    const file = await fixture("tagged.mp3");
    const { chmod, stat } = await import("node:fs/promises");
    await chmod(file, 0o640);
    await applyTagChanges(file, () => allFields(NEW));
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });
});

describe("layouts that are refused", () => {
  it("refuses ID3v2.2 and unsynchronised ID3 tags", async () => {
    const audio = (await readFile(path.join(FIXTURES, "untagged.mp3")));
    for (const [version, flags] of [
      [2, 0],
      [3, 0x80],
      [3, 0x40],
    ]) {
      const file = path.join(dir, `odd-${version}-${flags}.mp3`);
      const header = Buffer.from([0x49, 0x44, 0x33, version!, 0, flags!, 0, 0, 0, 0]);
      await writeFile(file, Buffer.concat([header, audio]));
      const before = await readFile(file);
      await expect(applyTagChanges(file, () => allFields(NEW))).rejects.toBeInstanceOf(TagLayoutError);
      expect((await readFile(file)).equals(before)).toBe(true);
    }
  });

  it("refuses an ID3 tag with garbage after its frames", async () => {
    const audio = await readFile(path.join(FIXTURES, "untagged.mp3"));
    const body = Buffer.alloc(20);
    body.write("junk", 12, "latin1");
    const file = path.join(dir, "junk.mp3");
    await writeFile(file, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]), body, audio]));
    await expect(readTags(file)).rejects.toBeInstanceOf(TagLayoutError);
  });

  it("refuses a fragmented MP4", async () => {
    const atom = (type: string, body = Buffer.alloc(0)) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(8 + body.length);
      h.write(type, 4, "latin1");
      return Buffer.concat([h, body]);
    };
    const file = path.join(dir, "fragmented.m4a");
    await writeFile(file, Buffer.concat([atom("ftyp", Buffer.from("M4A \0\0\0\0")), atom("moov"), atom("moof"), atom("mdat")]));
    await expect(readTags(file)).rejects.toBeInstanceOf(TagLayoutError);
  });

  it("refuses Ogg FLAC", async () => {
    const page = Buffer.alloc(28 + 9);
    page.write("OggS", 0, "latin1");
    page[5] = 0x02;
    page[26] = 1;
    page[27] = 9;
    page.write("\x7fFLAC\x01\x00\x00\x01", 28, "latin1");
    const file = path.join(dir, "flac.ogg");
    await writeFile(file, page);
    await expect(readTags(file)).rejects.toBeInstanceOf(TagLayoutError);
  });
});

describe("Ogg header pages that grow", () => {
  it.each(["tagged.ogg", "tagged.opus"])("renumbers the later pages of %s and keeps every audio packet", async (name) => {
    const file = await fixture(name);
    const before = await readFile(file);
    // A title long enough that the comment header needs more pages.
    const long = "x".repeat(200_000);
    await applyTagChanges(file, () => ({ title: { kind: "value", values: { title: long } } }));
    const after = await readFile(file);
    expect(audioOf(name, after).equals(audioOf(name, before))).toBe(true);
    // Every page checksum and sequence number is valid.
    let offset = 0;
    let seq = 0;
    for (;;) {
      const page = parsePage(after, offset, offset);
      if (!page) break;
      expect(page.seq).toBe(seq);
      const copy = Buffer.from(after.subarray(offset, offset + page.length));
      const crc = copy.readUInt32LE(22);
      const { sealPage } = await import("../src/tags/ogg");
      expect(sealPage(copy).readUInt32LE(22)).toBe(crc);
      seq += 1;
      offset += page.length;
    }
    expect(offset).toBe(after.length);
    expect((await parseFile(file)).common.title).toBe(long);
  });
});

describe("MP4 with the metadata before the audio", () => {
  it("shifts the chunk offsets so they still point at the same samples", async () => {
    const file = await fixture("faststart.m4a");
    const before = await readFile(file);
    await applyTagChanges(file, () => ({ title: { kind: "value", values: { title: "A much longer title than before, to grow the item list" } } }));
    const after = await readFile(file);
    expect(after.length).toBeGreaterThan(before.length);
    expect(mp4Samples(after).equals(mp4Samples(before))).toBe(true);
  });
});

// ffmpeg decodes the audio before and after: the decoded samples must be identical.
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("decoded audio (ffmpeg)", () => {
  const md5 = (file: string) =>
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "md5", "-"]).toString().trim();

  it.each(ALL)("decodes %s to the same samples after writing tags", async (name) => {
    const file = await fixture(name);
    const before = md5(file);
    await applyTagChanges(file, () => allFields(NEW));
    expect(md5(file)).toBe(before);
  });
});
