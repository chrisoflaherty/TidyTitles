/**
 * Vorbis comments ("KEY=value" lists), the tag format of FLAC, Ogg Vorbis,
 * and Ogg Opus. Comments of the fields being changed are replaced at the
 * position of the first one; every other comment (including
 * METADATA_BLOCK_PICTURE artwork in Ogg) and the vendor string stay byte
 * for byte.
 */

import {
  TagLayoutError,
  emptyRaw,
  parseNumberPair,
  parseYear,
  type FieldChanges,
  type TagField,
  type TagValues,
} from "./types";

export interface VorbisComments {
  /** The vendor string's bytes. */
  vendor: Buffer;
  /** Each comment's bytes ("KEY=value", UTF-8). */
  comments: Buffer[];
  /** Bytes after the comment list (the framing bit in Ogg Vorbis, extra data in Opus). */
  trailer: Buffer;
}

/** Keys per field, upper case; the first is written. */
const KEYS: Record<TagField, string[]> = {
  title: ["TITLE"],
  artist: ["ARTIST"],
  album: ["ALBUM"],
  albumArtist: ["ALBUMARTIST", "ALBUM ARTIST"],
  track: ["TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS"],
  disc: ["DISCNUMBER", "DISCTOTAL", "TOTALDISCS"],
  year: ["DATE", "YEAR"],
  genre: ["GENRE"],
};

const FIELDS = Object.keys(KEYS) as TagField[];

/** Parse a comment list starting at `offset`; whatever follows is the trailer. */
export function parseVorbisComments(buf: Buffer, offset = 0): VorbisComments {
  let pos = offset;
  const need = (n: number) => {
    if (pos + n > buf.length) throw new TagLayoutError("Malformed Vorbis comments");
  };
  need(4);
  const vendorLength = buf.readUInt32LE(pos);
  pos += 4;
  need(vendorLength);
  const vendor = buf.subarray(pos, pos + vendorLength);
  pos += vendorLength;
  need(4);
  const count = buf.readUInt32LE(pos);
  pos += 4;
  const comments: Buffer[] = [];
  for (let i = 0; i < count; i += 1) {
    need(4);
    const length = buf.readUInt32LE(pos);
    pos += 4;
    need(length);
    comments.push(buf.subarray(pos, pos + length));
    pos += length;
  }
  return { vendor, comments, trailer: buf.subarray(pos) };
}

export function serializeVorbisComments(vc: VorbisComments): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  parts.push(u32(vc.vendor.length), vc.vendor, u32(vc.comments.length));
  for (const c of vc.comments) parts.push(u32(c.length), c);
  parts.push(vc.trailer);
  return Buffer.concat(parts);
}

function keyOf(comment: Buffer): string {
  const eq = comment.indexOf(0x3d);
  return (eq < 0 ? comment.toString("latin1") : comment.toString("latin1", 0, eq)).toUpperCase();
}

function valueOf(comment: Buffer): string {
  const eq = comment.indexOf(0x3d);
  return eq < 0 ? "" : comment.subarray(eq + 1).toString("utf8");
}

function fieldOf(comment: Buffer): TagField | undefined {
  const key = keyOf(comment);
  return FIELDS.find((f) => KEYS[f].includes(key));
}

/** The values of the fields TidyTitles writes. */
export function vorbisValues(vc: VorbisComments): TagValues {
  const first = (key: string): string | undefined => {
    const c = vc.comments.find((x) => keyOf(x) === key);
    return c ? valueOf(c) : undefined;
  };
  const firstOf = (keys: string[]) => keys.map(first).find((v) => v !== undefined);
  const values: TagValues = {};
  for (const field of ["title", "artist", "album", "albumArtist", "genre"] as const) {
    const v = firstOf(KEYS[field]);
    if (v !== undefined && v.trim() !== "") values[field] = v;
  }
  for (const [field, totals] of [
    ["track", ["TRACKTOTAL", "TOTALTRACKS"]],
    ["disc", ["DISCTOTAL", "TOTALDISCS"]],
  ] as const) {
    const pair = parseNumberPair(first(KEYS[field][0]!));
    if (!pair) continue;
    if (pair.of === undefined) {
      const total = Number(firstOf([...totals])?.trim());
      if (Number.isInteger(total) && total > 0) pair.of = total;
    }
    values[field] = pair;
  }
  const year = parseYear(firstOf(KEYS.year));
  if (year !== undefined) values.year = year;
  return values;
}

/** The raw comments behind each field. */
export function vorbisRaw(vc: VorbisComments) {
  const raw = emptyRaw();
  for (const c of vc.comments) {
    const field = fieldOf(c);
    if (field) raw[field].push(Buffer.from(c));
  }
  return raw;
}

function comment(key: string, value: string): Buffer {
  return Buffer.from(`${key}=${value}`, "utf8");
}

function commentsFor(field: TagField, values: TagValues): Buffer[] {
  switch (field) {
    case "track":
    case "disc": {
      const pair = values[field];
      if (!pair) return [];
      const out = [comment(KEYS[field][0]!, String(pair.no))];
      if (pair.of !== undefined) out.push(comment(KEYS[field][1]!, String(pair.of)));
      return out;
    }
    case "year":
      return values.year !== undefined ? [comment("DATE", String(values.year))] : [];
    default: {
      const v = values[field];
      return v ? [comment(KEYS[field][0]!, v)] : [];
    }
  }
}

/** The comment list with the changes applied. */
export function applyVorbisChanges(vc: VorbisComments, changes: FieldChanges): VorbisComments {
  const replacement = (field: TagField): Buffer[] => {
    const change = changes[field]!;
    return change.kind === "raw" ? change.entries : commentsFor(field, change.values);
  };
  const done = new Set<TagField>();
  const out: Buffer[] = [];
  for (const c of vc.comments) {
    const field = fieldOf(c);
    if (!field || !changes[field]) {
      out.push(c);
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
  return { vendor: vc.vendor, comments: out, trailer: vc.trailer };
}
