/**
 * Writing corrected tags into renamed music files (`[write_metadata]
 * music_tags`).
 *
 * Rules:
 * - Only a match from a metadata service (MusicBrainz) is written; a match
 *   built from the file's own tags carries nothing better.
 * - Only fields the match has are written, and only when the file's value
 *   differs. A tag is never blanked: a track total the match lacks keeps
 *   the file's.
 * - Formats: MP3, FLAC, M4A, Ogg Vorbis, Ogg Opus (see tags/). Anything
 *   else is reported "not written" with reason "unsupported_format".
 * - Never through a hard link (the other name would change too).
 * - The old entries of every changed field are recorded, so undo can put
 *   them back exactly.
 */

import { lstat } from "node:fs/promises";
import type { Track } from "./models";
import {
  RewriteError,
  TagLayoutError,
  applyTagChanges,
  canWriteTags,
  formatNumberPair,
  readTags,
  setMtimeNs,
  type FieldChanges,
  type ParsedTags,
  type RewriteHooks,
  type TagField,
  type TagFormat,
  type TagValues,
} from "./tags/index";
import type { FileFingerprint } from "./transfer";

export type { TagField, TagFormat, TagValues } from "./tags/index";

/**
 * Outcome of writing tags into one file:
 * - "written": the tags were changed (`changes`)
 * - "would_write": dry run; `changes` lists what would change
 * - "unchanged": nothing to write (`reason` "match_from_tags", or the tags
 *   already have the match's values)
 * - "not_written": left alone on purpose (`reason`)
 * - "failed": the write was abandoned; the file is as it was (`reason`, `message`)
 */
export type TagWriteStatus = "written" | "would_write" | "unchanged" | "not_written" | "failed";

/**
 * Why tags were not written, or why writing failed:
 * - "match_from_tags": the match was built from the file's own tags
 * - "unsupported_format": a format TidyTitles cannot write (WAV, AIFF, WMA, AAC, APE, ...)
 * - "unsupported_layout": a supported format, laid out in a way the writer
 *   does not handle (ID3v2.2, unsynchronised or extended ID3 headers,
 *   fragmented MP4, multiplexed Ogg, ...)
 * - "hard_link": the file was hard linked; writing would change the original too
 * - "shared_data": the file has other hard links, which would keep the old data
 * - "read_failed": the file could not be read
 * - "write_failed": the new file could not be written or put in place
 * - "changed_during_write": another program changed the file meanwhile
 * - "verify_failed": the rewritten file did not read back as expected
 */
export type TagWriteReason =
  | "match_from_tags"
  | "unsupported_format"
  | "unsupported_layout"
  | "hard_link"
  | "shared_data"
  | "read_failed"
  | "write_failed"
  | "changed_during_write"
  | "verify_failed";

/** One changed field, as text for display. */
export interface TagChange {
  field: TagField;
  /** Absent: the file had no value. */
  from?: string;
  to: string;
}

export interface TagWriteResult {
  status: TagWriteStatus;
  reason?: TagWriteReason;
  /** Written (or, in a dry run, to be written). */
  changes: TagChange[];
  format?: TagFormat;
  /** Details of a failure, for display only. */
  message?: string;
}

/**
 * What undo needs to put the old tags back (stored in history.json as
 * `tags`): the format, the size of the tag region, the original entries
 * (base64) of each changed field, and the file's modification time before.
 */
export interface TagRestoreRecord {
  format: TagFormat;
  regionSize: number;
  fields: Partial<Record<TagField, string[]>>;
  mtimeNs?: string;
  /** The file right after its tags were written. */
  fingerprint: FileFingerprint;
}

const PLACEHOLDER_ARTISTS = new Set(["", "unknown artist"]);

function text(value: string | undefined): string | undefined {
  const v = value?.normalize("NFC").trim();
  return v ? v : undefined;
}

/** The values a provider match has. Empty for a match built from the file's tags. */
export function tagValuesFromTrack(track: Track): TagValues {
  const values: TagValues = {};
  const title = text(track.title);
  if (title) values.title = title;
  const artist = text(track.artist?.name);
  if (artist && !PLACEHOLDER_ARTISTS.has(artist.toLowerCase())) values.artist = artist;
  const album = track.album;
  const albumTitle = text(album?.title);
  if (albumTitle) values.album = albumTitle;
  const albumArtist = text(album?.artist?.name);
  if (albumArtist && !PLACEHOLDER_ARTISTS.has(albumArtist.toLowerCase())) values.albumArtist = albumArtist;
  if (track.trackNumber && track.trackNumber > 0) {
    // A release's track count covers every disc; it is the track total
    // only for a single-disc release.
    values.track =
      album?.totalTracks && album.totalDiscs === 1 ? { no: track.trackNumber, of: album.totalTracks } : { no: track.trackNumber };
  }
  if (track.discNumber && track.discNumber > 0) {
    values.disc = album?.totalDiscs ? { no: track.discNumber, of: album.totalDiscs } : { no: track.discNumber };
  }
  if (album?.year && album.year > 0) values.year = album.year;
  const genre = text(track.genres?.[0]);
  if (genre) values.genre = genre;
  return values;
}

/** True when the match came from a metadata service, not from the file's tags. */
export function isProviderTrack(track: Track): boolean {
  // Tracks built from tags (trackFromParsedInfo) have the id "local".
  return track.id !== "local";
}

function display(field: TagField, values: TagValues): string | undefined {
  switch (field) {
    case "track":
    case "disc":
      return values[field] ? formatNumberPair(values[field]) : undefined;
    case "year":
      return values.year !== undefined ? String(values.year) : undefined;
    default:
      return values[field];
  }
}

/**
 * The fields to write: those the match has whose value differs from the
 * file's. Returns the values to write (a missing track or disc total keeps
 * the file's) and the changes for display.
 */
export function diffTagValues(current: TagValues, desired: TagValues): { values: TagValues; changes: TagChange[] } {
  const values: TagValues = {};
  const changes: TagChange[] = [];
  const note = (field: TagField) => {
    const change: TagChange = { field, to: display(field, values)! };
    const from = display(field, current);
    if (from !== undefined) change.from = from;
    changes.push(change);
  };
  for (const field of ["title", "artist", "album", "albumArtist"] as const) {
    const want = desired[field];
    if (want === undefined) continue;
    if (current[field]?.normalize("NFC").trim() === want) continue;
    values[field] = want;
    note(field);
  }
  for (const field of ["track", "disc"] as const) {
    const want = desired[field];
    if (!want) continue;
    const have = current[field];
    const pair = want.of === undefined && have?.of !== undefined ? { no: want.no, of: have.of } : want;
    if (have && have.no === pair.no && have.of === pair.of) continue;
    values[field] = pair;
    note(field);
  }
  if (desired.year !== undefined && current.year !== desired.year) {
    values.year = desired.year;
    note("year");
  }
  if (desired.genre !== undefined && current.genre?.trim().toLowerCase() !== desired.genre.toLowerCase()) {
    values.genre = desired.genre;
    note("genre");
  }
  return { values, changes };
}

function failure(error: unknown): TagWriteResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TagLayoutError) return { status: "not_written", reason: "unsupported_layout", changes: [], message };
  if (error instanceof RewriteError) return { status: "failed", reason: error.reason, changes: [], message };
  return { status: "failed", reason: "read_failed", changes: [], message };
}

export interface WriteTrackTagsOptions {
  dryRun?: boolean;
  /** "hardlink": never write (the original would change too). */
  transferMode?: "move" | "copy" | "hardlink";
  hooks?: RewriteHooks;
}

/**
 * Write a provider match's values into `file`. Returns the result and, when
 * the file was changed, what undo needs to restore it.
 */
export async function writeTrackTags(
  file: string,
  track: Track,
  options: WriteTrackTagsOptions = {},
): Promise<{ result: TagWriteResult; restore?: TagRestoreRecord }> {
  if (!isProviderTrack(track)) return { result: { status: "unchanged", reason: "match_from_tags", changes: [] } };
  if (!canWriteTags(file)) return { result: { status: "not_written", reason: "unsupported_format", changes: [] } };
  if (options.transferMode === "hardlink") return { result: { status: "not_written", reason: "hard_link", changes: [] } };

  const desired = tagValuesFromTrack(track);
  let current: ParsedTags;
  let nlink: bigint;
  let mtimeNs: string;
  try {
    const s = await lstat(file, { bigint: true });
    nlink = s.nlink;
    mtimeNs = String(s.mtimeNs);
    current = await readTags(file);
  } catch (error) {
    return { result: failure(error) };
  }
  const { values, changes } = diffTagValues(current.values, desired);
  const format = current.format;
  if (changes.length === 0) return { result: { status: "unchanged", changes: [], format } };
  if (options.dryRun) return { result: { status: "would_write", changes, format } };
  if (nlink > 1n) return { result: { status: "not_written", reason: "shared_data", changes: [], format } };

  const fieldChanges: FieldChanges = {};
  for (const c of changes) fieldChanges[c.field] = { kind: "value", values };
  try {
    const { before, fingerprint } = await applyTagChanges(file, () => fieldChanges, { hooks: options.hooks });
    const fields: TagRestoreRecord["fields"] = {};
    for (const c of changes) fields[c.field] = before.raw[c.field].map((b) => b.toString("base64"));
    return {
      result: { status: "written", changes, format },
      restore: { format, regionSize: before.regionSize, fields, mtimeNs, fingerprint },
    };
  } catch (error) {
    return { result: { ...failure(error), format } };
  }
}

/**
 * Put back the tags a write replaced. The file must be the one the write
 * produced (checked by the caller). Afterward the modification time is set
 * back to what it was before the write. Returns the file's new fingerprint.
 * @throws TagLayoutError, RewriteError, or a filesystem error; the file is
 *   then as it was.
 */
export async function restoreTrackTags(
  file: string,
  record: Pick<TagRestoreRecord, "format" | "regionSize" | "fields" | "mtimeNs">,
  hooks?: RewriteHooks,
): Promise<FileFingerprint> {
  const changes: FieldChanges = {};
  for (const [field, entries] of Object.entries(record.fields) as [TagField, string[]][]) {
    changes[field] = { kind: "raw", entries: entries.map((e) => Buffer.from(e, "base64")) };
  }
  let { fingerprint } = await applyTagChanges(
    file,
    (current) => {
      if (current.format !== record.format) throw new TagLayoutError("The file is no longer in the format its tags were written in");
      return changes;
    },
    { targetRegionSize: record.regionSize, ...(hooks ? { hooks } : {}) },
  );
  if (record.mtimeNs) {
    await setMtimeNs(file, record.mtimeNs);
    const s = await lstat(file, { bigint: true });
    fingerprint = { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs) };
  }
  return fingerprint;
}
