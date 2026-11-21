/**
 * ID3v2.3 and ID3v2.4 tags at the start of an MP3 file.
 *
 * Only the text frames of the fields TidyTitles writes are replaced; every
 * other frame (artwork, comments, lyrics, private frames) is copied byte
 * for byte, in its place. The MPEG audio after the tag, and an ID3v1 tag at
 * the end, are copied verbatim. A file without an ID3v2 tag gets a new
 * ID3v2.3 tag (the version Windows and older players read best).
 *
 * Refused (TagLayoutError), so the file is never guessed at: ID3v2.2,
 * tag-level unsynchronisation, an extended header, a footer, unknown tag
 * flags, malformed frames, and non-zero bytes after the frames.
 */

import {
  TagLayoutError,
  emptyRaw,
  formatNumberPair,
  parseNumberPair,
  parseYear,
  type ByteSource,
  type FieldChanges,
  type ParsedTags,
  type RewritePlan,
  type TagField,
  type TagValues,
} from "./types";

/** Padding added when a tag has to grow: room for later edits without moving the audio again. */
export const ID3_GROWTH_PADDING = 1024;

/** Largest tag size a syncsafe integer can express. */
const MAX_SYNCSAFE = 0x0fffffff;

interface Frame {
  id: string;
  /** Header and body, exactly as in the file. */
  raw: Buffer;
  /** Frame flags (2 bytes). */
  flags: number;
  body: Buffer;
}

/** Frame IDs per field; the first is the one written. */
function frameIds(field: TagField, major: number): string[] {
  switch (field) {
    case "title":
      return ["TIT2"];
    case "artist":
      return ["TPE1"];
    case "album":
      return ["TALB"];
    case "albumArtist":
      return ["TPE2"];
    case "track":
      return ["TRCK"];
    case "disc":
      return ["TPOS"];
    case "year":
      return major === 4 ? ["TDRC", "TYER"] : ["TYER", "TDRC"];
    case "genre":
      return ["TCON"];
  }
}

const FIELDS: readonly TagField[] = ["title", "artist", "album", "albumArtist", "track", "disc", "year", "genre"];

function readSyncsafe(buf: Buffer, offset: number): number | undefined {
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    const b = buf[offset + i]!;
    if (b & 0x80) return undefined;
    value = value * 128 + b;
  }
  return value;
}

function writeSyncsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

/** Frame flags that make the body unreadable as plain text. */
function bodyIsPlain(flags: number, major: number): boolean {
  const format = flags & 0xff;
  return major === 4 ? (format & 0x0f) === 0 && (format & 0x40) === 0 : (format & 0xe0) === 0;
}

function decodeUtf16(bytes: Buffer, bigEndian: boolean): string {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  if (!bigEndian) return even.toString("utf16le");
  const swapped = Buffer.from(even);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/** The values of a text frame body (several in ID3v2.4, separated by NUL). */
export function decodeTextFrame(body: Buffer): string[] {
  if (body.length === 0) return [];
  const encoding = body[0]!;
  const data = body.subarray(1);
  let text: string;
  switch (encoding) {
    case 0:
      text = data.toString("latin1");
      break;
    case 1: {
      // UTF-16 with a byte order mark (each value may carry its own).
      if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) text = decodeUtf16(data.subarray(2), true);
      else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) text = decodeUtf16(data.subarray(2), false);
      else text = decodeUtf16(data, false);
      break;
    }
    case 2:
      text = decodeUtf16(data, true);
      break;
    case 3:
      text = data.toString("utf8");
      break;
    default:
      return [];
  }
  const values = text.split("\u0000").map((v) => v.replace(/^﻿/, ""));
  // A terminating NUL leaves an empty last value.
  while (values.length > 0 && values[values.length - 1] === "") values.pop();
  return values;
}

/** A text frame (header and body) for one value. */
export function encodeTextFrame(id: string, value: string, major: number): Buffer {
  let body: Buffer;
  if (major === 4) {
    body = Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]);
  } else if (/^[\u0001-ÿ]*$/.test(value)) {
    body = Buffer.concat([Buffer.from([0]), Buffer.from(value, "latin1")]);
  } else {
    body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(value, "utf16le")]);
  }
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  if (major === 4) writeSyncsafe(body.length).copy(header, 4);
  else header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Genre text without ID3v1 references: "(17)Rock" → "Rock"; a bare reference → undefined. */
function genreText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const refs = /^(?:\((?:\d+|RX|CR)\))+(.*)$/.exec(value);
  const text = (refs ? refs[1]! : value).trim();
  if (text === "" || /^\d+$/.test(text)) return undefined;
  return text.startsWith("((") ? text.slice(1) : text;
}

function parseFrames(body: Buffer, syncsafeSizes: boolean): Frame[] | undefined {
  const frames: Frame[] = [];
  let pos = 0;
  while (pos + 10 <= body.length) {
    if (body[pos] === 0) break;
    const id = body.toString("latin1", pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) return undefined;
    const size = syncsafeSizes ? readSyncsafe(body, pos + 4) : body.readUInt32BE(pos + 4);
    if (size === undefined || pos + 10 + size > body.length) return undefined;
    const flags = body.readUInt16BE(pos + 8);
    const raw = body.subarray(pos, pos + 10 + size);
    frames.push({ id, raw, flags, body: raw.subarray(10) });
    pos += 10 + size;
  }
  // What follows the frames must be padding.
  for (let i = pos; i < body.length; i += 1) if (body[i] !== 0) return undefined;
  return frames;
}

interface Id3Layout {
  /** 0 when the file has no ID3v2 tag. */
  tagSize: number;
  major: number;
  revision: number;
  flags: number;
  frames: Frame[];
}

async function readLayout(src: ByteSource): Promise<Id3Layout> {
  const head = await src.read(0, Math.min(10, src.size));
  if (head.length < 10 || head.toString("latin1", 0, 3) !== "ID3") {
    return { tagSize: 0, major: 3, revision: 0, flags: 0, frames: [] };
  }
  const major = head[3]!;
  const revision = head[4]!;
  const flags = head[5]!;
  if (major !== 3 && major !== 4) throw new TagLayoutError(`ID3v2.${major} tags are not supported`);
  if (flags & 0x80) throw new TagLayoutError("ID3 tags with unsynchronisation are not supported");
  if (flags & 0x40) throw new TagLayoutError("ID3 tags with an extended header are not supported");
  if (flags & 0x10) throw new TagLayoutError("ID3 tags with a footer are not supported");
  if (flags & 0x0f) throw new TagLayoutError("Unknown ID3 tag flags");
  const size = readSyncsafe(head, 6);
  if (size === undefined) throw new TagLayoutError("Malformed ID3 tag size");
  const tagSize = 10 + size;
  if (tagSize > src.size) throw new TagLayoutError("The ID3 tag is longer than the file");
  const body = await src.read(10, size);
  // ID3v2.4 frame sizes are syncsafe; some writers (old iTunes) used plain
  // integers there. Accept whichever reading accounts for the whole tag.
  const frames =
    parseFrames(body, major === 4) ?? (major === 4 ? parseFrames(body, false) : undefined);
  if (!frames) throw new TagLayoutError("Malformed ID3 frames");
  return { tagSize, major, revision, flags, frames };
}

function valuesOf(layout: Id3Layout): TagValues {
  const first = (field: TagField): string | undefined => {
    for (const id of frameIds(field, layout.major)) {
      const frame = layout.frames.find((f) => f.id === id);
      if (frame) return bodyIsPlain(frame.flags, layout.major) ? decodeTextFrame(frame.body)[0] : undefined;
    }
    return undefined;
  };
  const values: TagValues = {};
  for (const field of ["title", "artist", "album", "albumArtist"] as const) {
    const v = first(field);
    if (v !== undefined && v.trim() !== "") values[field] = v;
  }
  const track = parseNumberPair(first("track"));
  if (track) values.track = track;
  const disc = parseNumberPair(first("disc"));
  if (disc) values.disc = disc;
  const year = parseYear(first("year"));
  if (year !== undefined) values.year = year;
  const genre = genreText(first("genre"));
  if (genre !== undefined) values.genre = genre;
  return values;
}

function fieldOf(id: string, major: number): TagField | undefined {
  return FIELDS.find((f) => frameIds(f, major).includes(id));
}

/** The frames that write a field's value. */
function framesFor(field: TagField, values: TagValues, major: number): Buffer[] {
  const id = frameIds(field, major)[0]!;
  let text: string | undefined;
  switch (field) {
    case "track":
    case "disc":
      text = values[field] ? formatNumberPair(values[field]) : undefined;
      break;
    case "year":
      text = values.year !== undefined ? String(values.year) : undefined;
      break;
    default:
      text = values[field];
  }
  return text === undefined || text === "" ? [] : [encodeTextFrame(id, text, major)];
}

export async function parseMp3(src: ByteSource): Promise<ParsedTags> {
  const layout = await readLayout(src);
  const raw = emptyRaw();
  for (const frame of layout.frames) {
    const field = fieldOf(frame.id, layout.major);
    if (field) raw[field].push(Buffer.from(frame.raw));
  }

  return {
    format: "mp3",
    values: valuesOf(layout),
    raw,
    regionSize: layout.tagSize,
    plan(changes: FieldChanges, options = {}): RewritePlan {
      const target = options.targetRegionSize ?? layout.tagSize;
      const replacement = (field: TagField): Buffer[] => {
        const change = changes[field]!;
        return change.kind === "raw" ? change.entries : framesFor(field, change.values, layout.major);
      };
      const done = new Set<TagField>();
      const out: Buffer[] = [];
      for (const frame of layout.frames) {
        const field = fieldOf(frame.id, layout.major);
        if (!field || !changes[field]) {
          out.push(frame.raw);
          continue;
        }
        if (!done.has(field)) {
          out.push(...replacement(field));
          done.add(field);
        }
      }
      for (const field of FIELDS) {
        if (changes[field] && !done.has(field)) out.push(...replacement(field));
      }
      const content = Buffer.concat(out);

      const rest = { kind: "copy" as const, start: layout.tagSize, end: src.size };
      if (content.length === 0 && target === 0) {
        // Nothing left to store, and the file had no tag: no tag at all.
        return { segments: [rest], size: src.size - layout.tagSize };
      }
      const total = 10 + content.length <= target ? target : 10 + content.length + ID3_GROWTH_PADDING;
      if (total - 10 > MAX_SYNCSAFE) throw new TagLayoutError("The ID3 tag would be too large");
      const header = Buffer.alloc(10);
      header.write("ID3", 0, "latin1");
      header[3] = layout.major;
      header[4] = layout.tagSize > 0 ? layout.revision : 0;
      header[5] = layout.flags;
      writeSyncsafe(total - 10).copy(header, 6);
      const tag = Buffer.concat([header, content, Buffer.alloc(total - 10 - content.length)]);
      return { segments: [{ kind: "bytes", data: tag }, rest], size: tag.length + src.size - layout.tagSize };
    },
  };
}
