/**
 * Shared types of the tag writers in this folder.
 *
 * Each supported container format has a handler that parses only the tag
 * region of a file (the ID3v2 tag of an MP3, the metadata blocks of a FLAC
 * file, the header pages of an Ogg stream, the `moov` atom of an MP4) and
 * plans a rewrite as a list of segments: new bytes for the tag region, and
 * byte ranges of the original file for everything else. Bytes outside the
 * fields being changed are copied verbatim: other tags, embedded artwork,
 * and the audio itself. A handler refuses (TagLayoutError) any layout it
 * does not fully understand rather than guess.
 */

/** The tag fields TidyTitles writes. */
export type TagField = "title" | "artist" | "album" | "albumArtist" | "track" | "disc" | "year" | "genre";

export const TAG_FIELDS: readonly TagField[] = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "track",
  "disc",
  "year",
  "genre",
];

/** A track or disc number with its optional total ("3/12"). */
export interface NumberPair {
  no: number;
  of?: number;
}

/** Tag values, as read from a file or as they should be written. Absent: no value. */
export interface TagValues {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: NumberPair;
  disc?: NumberPair;
  year?: number;
  genre?: string;
}

/** Container formats with a tag writer. */
export type TagFormat = "mp3" | "flac" | "mp4" | "ogg_vorbis" | "ogg_opus";

/** What to do with one field: write a value, or put back raw entries saved earlier (undo). */
export type FieldChange =
  | { kind: "value"; values: TagValues }
  | { kind: "raw"; entries: Buffer[] };

export type FieldChanges = Partial<Record<TagField, FieldChange>>;

/**
 * One piece of the rewritten file: new bytes, or a range of the original
 * copied verbatim. `ogg_pages` copies a range of Ogg pages, adding
 * `seqDelta` to each page's sequence number (and recomputing its checksum)
 * when the number of header pages changed; the packets are not touched.
 */
export type Segment =
  | { kind: "bytes"; data: Buffer }
  | { kind: "copy"; start: number; end: number }
  | { kind: "ogg_pages"; start: number; end: number; serial: number; seqDelta: number };

/** The planned rewrite of a file. */
export interface RewritePlan {
  segments: Segment[];
  /** Size of the rewritten file in bytes. */
  size: number;
}

/** A parsed file, ready to plan a rewrite. */
export interface ParsedTags {
  format: TagFormat;
  /** The values currently in the file (the fields TidyTitles writes only). */
  values: TagValues;
  /** The raw entries (frames, comments, atoms) behind each field, for undo. */
  raw: Record<TagField, Buffer[]>;
  /**
   * Size of the tag region in bytes. A rewrite tries to keep it (padding
   * absorbs the change), so the audio does not move; undo asks for the
   * original size back.
   */
  regionSize: number;
  /** Plan a rewrite with these changes; `targetRegionSize` defaults to `regionSize`. */
  plan(changes: FieldChanges, options?: { targetRegionSize?: number }): RewritePlan;
}

/** Random access to the original file. */
export interface ByteSource {
  readonly size: number;
  read(position: number, length: number): Promise<Buffer>;
}

/** A layout the writer does not support; the file is left alone. */
export class TagLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagLayoutError";
  }
}

/** Empty raw-entry record. */
export function emptyRaw(): Record<TagField, Buffer[]> {
  return { title: [], artist: [], album: [], albumArtist: [], track: [], disc: [], year: [], genre: [] };
}

/** "3/12" or "3"; undefined when the text holds no number. */
export function parseNumberPair(text: string | undefined): NumberPair | undefined {
  if (text === undefined) return undefined;
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(text);
  if (!m) return undefined;
  const pair: NumberPair = { no: Number(m[1]) };
  if (m[2] !== undefined && Number(m[2]) > 0) pair.of = Number(m[2]);
  return pair;
}

/** "3/12" or "3". */
export function formatNumberPair(pair: NumberPair): string {
  return pair.of !== undefined ? `${pair.no}/${pair.of}` : String(pair.no);
}

/** The year at the start of a date tag ("2020", "2020-05-01"). */
export function parseYear(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^\s*(\d{4})/.exec(text);
  return m ? Number(m[1]) : undefined;
}
