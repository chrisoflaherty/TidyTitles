/**
 * Data models for TidyTitles.
 *
 * Every model is a plain, JSON-serializable object so it can cross the
 * Electron IPC boundary and be written to disk unchanged. Behavior lives in
 * the helper functions at the bottom of this file, not on the objects.
 *
 * Conventions:
 * - Paths are absolute strings.
 * - Dates are ISO "YYYY-MM-DD" strings.
 * - Absent values are `undefined` (optional properties). Code that reads
 *   models should treat `null` and `undefined` alike (`value == null`).
 * - Metadata objects carry a `kind` discriminant in place of Python's
 *   `isinstance` checks.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Type of media file. */
export type MediaType = "movie" | "tv_episode" | "music" | "unknown";

/** Status of a rename operation. */
export type RenameStatus = "pending" | "completed" | "failed" | "skipped";

/** Verification status for metadata from various sources. */
export type VerificationStatus =
  /** Music: tags verified against MusicBrainz. */
  | "verified"
  /** Music: tags exist but were not found in MusicBrainz. */
  | "unverified"
  /** Music: metadata came directly from a provider search. */
  | "from_provider"
  /** Movie/TV: the system automatically found a match. */
  | "auto_matched"
  /** Movie/TV: the user manually selected this result. */
  | "manual_selection";

/** Information extracted from filename parsing. */
export interface ParsedInfo {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  mediaType: MediaType;
  quality?: string;
  source?: string;
  codec?: string;
  group?: string;
  rawFilename: string;
}

/** Movie metadata from an external provider. */
export interface Movie {
  kind: "movie";
  id: number;
  title: string;
  originalTitle: string;
  year: number;
  releaseDate?: string;
  overview?: string;
  genres: string[];
  posterPath?: string;
  provider: string;
  verificationStatus?: VerificationStatus;
}

/** TV show metadata. */
export interface TVShow {
  kind: "show";
  id: number;
  title: string;
  originalTitle: string;
  year: number;
  network?: string;
  status?: string;
  genres: string[];
  posterPath?: string;
  provider: string;
}

/** TV episode metadata. */
export interface Episode {
  kind: "episode";
  show: TVShow;
  season: number;
  episode: number;
  title: string;
  airDate?: string;
  overview?: string;
  verificationStatus?: VerificationStatus;
}

/** Music artist metadata. */
export interface Artist {
  kind: "artist";
  /** MusicBrainz UUID, or "local" for artists built from file tags. */
  id: string;
  name: string;
  sortName?: string;
  disambiguation?: string;
  provider: string;
}

/** Music album (release) metadata. */
export interface Album {
  kind: "album";
  id: string;
  title: string;
  artist: Artist;
  year?: number;
  releaseDate?: string;
  totalTracks?: number;
  totalDiscs?: number;
  coverArtUrl?: string;
  provider: string;
}

/** Music track (recording) metadata. */
export interface Track {
  kind: "track";
  id: string;
  title: string;
  artist: Artist;
  album?: Album;
  trackNumber?: number;
  discNumber?: number;
  durationMs?: number;
  genres: string[];
  verificationStatus?: VerificationStatus;
}

/** Metadata that a media file can be matched to. */
export type MatchedMetadata = Movie | Episode | Track;

/** Information extracted from music file tags or filename. */
export interface ParsedMusicInfo {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  genre?: string;
  durationMs?: number;
  rawFilename: string;
  /** Where the info came from: "tags", "filename", or "unknown". */
  source: string;
}

/** A media file to be renamed. */
export interface MediaFile {
  path: string;
  parsedInfo: ParsedInfo;
  parsedMusicInfo?: ParsedMusicInfo;
  matchedMetadata?: MatchedMetadata;
}

/** Kind of file that travels with a media file. */
export type AssociatedFileType = "subtitle" | "nfo" | "image" | "other";

/** A rename operation for an associated file. */
export interface AssociatedFileRename {
  source: string;
  destination: string;
  fileType: AssociatedFileType;
}

/** A planned rename operation. */
export interface RenameOperation {
  source: string;
  destination: string;
  mediaFile: MediaFile;
  status: RenameStatus;
  errorMessage?: string;
  associatedFiles: AssociatedFileRename[];
}

// ---------------------------------------------------------------------------
// Factories: fill in the defaults the Python dataclasses provided.
// ---------------------------------------------------------------------------

export function createParsedInfo(
  fields: Pick<ParsedInfo, "title"> & Partial<ParsedInfo>,
): ParsedInfo {
  return { mediaType: "unknown", rawFilename: "", ...fields };
}

export function createMovie(
  fields: Pick<Movie, "id" | "title" | "originalTitle" | "year"> &
    Partial<Omit<Movie, "kind">>,
): Movie {
  return { genres: [], provider: "tmdb", ...fields, kind: "movie" };
}

export function createTVShow(
  fields: Pick<TVShow, "id" | "title" | "originalTitle" | "year"> &
    Partial<Omit<TVShow, "kind">>,
): TVShow {
  return { genres: [], provider: "tvdb", ...fields, kind: "show" };
}

export function createEpisode(
  fields: Pick<Episode, "show" | "season" | "episode" | "title"> &
    Partial<Omit<Episode, "kind">>,
): Episode {
  return { ...fields, kind: "episode" };
}

export function createArtist(
  fields: Pick<Artist, "id" | "name"> & Partial<Omit<Artist, "kind">>,
): Artist {
  return { provider: "musicbrainz", ...fields, kind: "artist" };
}

export function createAlbum(
  fields: Pick<Album, "id" | "title" | "artist"> & Partial<Omit<Album, "kind">>,
): Album {
  return { provider: "musicbrainz", ...fields, kind: "album" };
}

export function createTrack(
  fields: Pick<Track, "id" | "title" | "artist"> & Partial<Omit<Track, "kind">>,
): Track {
  return { genres: [], ...fields, kind: "track" };
}

export function createParsedMusicInfo(
  fields: Partial<ParsedMusicInfo> = {},
): ParsedMusicInfo {
  return { rawFilename: "", source: "unknown", ...fields };
}

export function createRenameOperation(
  fields: Pick<RenameOperation, "source" | "destination" | "mediaFile"> &
    Partial<RenameOperation>,
): RenameOperation {
  return { status: "pending", associatedFiles: [], ...fields };
}

// ---------------------------------------------------------------------------
// Helpers: the methods and properties the Python dataclasses carried.
// ---------------------------------------------------------------------------

/** True when all fields required for renaming a music file are present. */
export function isMusicInfoComplete(info: ParsedMusicInfo): boolean {
  return Boolean(
    info.title &&
      info.artist &&
      info.album &&
      info.trackNumber != null &&
      info.year != null,
  );
}

/** The filename without its directory. */
export function mediaFileName(file: MediaFile): string {
  return path.basename(file.path);
}

/** The file extension, including the leading dot (e.g. ".mkv"). */
export function mediaFileExtension(file: MediaFile): string {
  return path.extname(file.path);
}

/** True when this rename would overwrite an existing, different file. */
export function willOverwrite(operation: RenameOperation): boolean {
  return (
    operation.source !== operation.destination &&
    existsSync(operation.destination)
  );
}

/** Total number of files that will be renamed (main + associated). */
export function totalFiles(operation: RenameOperation): number {
  return 1 + operation.associatedFiles.length;
}

/** Create a Track from ParsedMusicInfo (file tags). */
export function trackFromParsedInfo(
  parsed: ParsedMusicInfo,
  verificationStatus: VerificationStatus,
): Track {
  const artist = createArtist({
    id: "local",
    name: parsed.artist || "Unknown Artist",
    provider: "local",
  });

  const album = parsed.album
    ? createAlbum({
        id: "local",
        title: parsed.album,
        artist,
        year: parsed.year,
        provider: "local",
      })
    : undefined;

  return createTrack({
    id: "local",
    title: parsed.title || "",
    artist,
    album,
    trackNumber: parsed.trackNumber,
    discNumber: parsed.discNumber,
    durationMs: parsed.durationMs,
    verificationStatus,
  });
}
