/**
 * Main service orchestrating the rename workflow.
 *
 * Port of `file_renamer/services/rename_service.py`:
 *
 *   parseFiles -> fetchMetadata -> generatePreview -> executeRename
 *
 * (`processFiles` runs the first three). Differences from the Python are
 * called out where they occur; in short:
 * - The selection callback may be async.
 * - A provider error on one file no longer aborts the batch: the file is
 *   kept, unmatched, with `lookupError` set, and its operation is skipped
 *   with `skipReason: "lookup_failed"`.
 * - Every skipped operation carries a typed `skipReason`.
 * - Music files (by extension) are always handled as music, even when a
 *   media type is forced.
 * - Destinations are de-duplicated within a batch, and a file that already
 *   has its target name is not auto-versioned against itself.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  findAssociatedFiles,
  generateAssociatedDestination,
  getExtensionsFromSettings,
  pathStem,
  pathSuffix,
} from "./associatedFiles";
import type { AssociatedFilesSettings } from "./config";
import type { ConflictStrategy } from "./conflictResolution";
import {
  AuthenticationError,
  ProviderError,
  RateLimitError,
  TemplateError,
} from "./errors";
import {
  createRenameOperation,
  mediaFileExtension,
  mediaFileName,
  trackFromParsedInfo,
  isMusicInfoComplete,
  type AssociatedFileRename,
  type MediaFile,
  type MediaType,
  type Movie,
  type ParsedMusicInfo,
  type RenameOperation,
  type Track,
  type TVShow,
} from "./models";
import { createMusicParser, isMusicFile, type MusicParser } from "./musicParser";
import { createParser, type FilenameParser } from "./parser";
import type { MovieProvider, MusicProvider, TVProvider } from "./providers/base";
import { FileRenamer, isCaseOnlyRename, type ProgressCallback } from "./renamer";
import { scanDirectory, type ScanOptions } from "./scan";
import { TemplateEngine, type TemplateContext } from "./template";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An option offered to the selection callback (all options in one call share a kind). */
export type SelectableOption = Movie | TVShow | Track;

/** Index of the chosen option, or undefined/null to skip the file. */
export type SelectionResult = number | undefined | null;

/**
 * Called when a search returns more than one result. Receives the options
 * and the filename; returns (or resolves to) the chosen index, or
 * undefined/null to leave the file unmatched. An out-of-range index also
 * skips. An error thrown (or a rejection) here is not treated as a lookup
 * failure: it aborts `fetchMetadata`, which is how a front end cancels.
 */
export type SelectionCallback = (
  options: SelectableOption[],
  filename: string,
) => SelectionResult | Promise<SelectionResult>;

/** Phase reported by `processFiles` progress. */
export type ProcessPhase = "parse" | "fetch";

/**
 * Progress for `processFiles`: the usual (current, total, message) plus the
 * phase. Any plain `ProgressCallback` can be passed.
 */
export type ProcessProgressCallback = (
  current: number,
  total: number,
  message: string,
  phase: ProcessPhase,
) => void;

/** Broad class of a metadata lookup failure. */
export type LookupErrorKind = "authentication" | "rate_limit" | "provider" | "other";

/** A serializable description of a metadata lookup failure. */
export interface LookupErrorInfo {
  /** "authentication" (bad or missing API key), "rate_limit", "provider" (other API error), or "other". */
  kind: LookupErrorKind;
  /** The error class name, e.g. "AuthenticationError". */
  name: string;
  message: string;
}

/** A media file as returned by `parseFiles` / `fetchMetadata`. */
export interface PlannedMediaFile extends MediaFile {
  /** Set when the provider lookup for this file threw. */
  lookupError?: LookupErrorInfo;
}

/**
 * Why an operation was skipped (status "skipped"):
 * - "no_match": no metadata was found (or the user skipped the selection)
 * - "lookup_failed": the provider threw; see `lookupError`
 * - "unknown_metadata": the matched metadata has an unknown kind
 * - "template_error": the template could not be rendered; see `errorMessage`
 * - "duplicate_destination": an earlier file in the batch has the same destination
 * - "same_path": the file already has its target name (set by `executeRename`)
 * - "would_overwrite": the destination exists and overwriting is off (set by `executeRename`)
 */
export type SkipReason =
  | "no_match"
  | "lookup_failed"
  | "unknown_metadata"
  | "template_error"
  | "duplicate_destination"
  | "same_path"
  | "would_overwrite";

/** A rename operation produced by `generatePreview`. */
export interface PlannedOperation extends RenameOperation {
  mediaFile: PlannedMediaFile;
  /** Set when status is "skipped". */
  skipReason?: SkipReason;
  /** Copied from the media file when its lookup failed. */
  lookupError?: LookupErrorInfo;
}

export interface RenameServiceOptions {
  /** Filename parser. Default `createParser()`. */
  parser?: FilenameParser;
  /** Movie metadata provider. Default: one that finds nothing. */
  movieProvider?: MovieProvider;
  /** TV metadata provider. Default: one that finds nothing. */
  tvProvider?: TVProvider;
  /**
   * Music metadata provider. When omitted, files with complete tags are
   * matched from their tags as "unverified" and files with incomplete tags
   * are left unmatched (as in the Python).
   */
  musicProvider?: MusicProvider;
  /** Music tag parser. Default `createMusicParser()`. */
  musicParser?: MusicParser;
  /** Template engine. Default: default templates. */
  templateEngine?: TemplateEngine;
  /** File renamer. Default `new FileRenamer()`. */
  fileRenamer?: FileRenamer;
  /** Associated-file handling. Default: enabled, all types. */
  associatedFilesSettings?: AssociatedFilesSettings;
  /** Conflict strategy. Default "skip". */
  conflictStrategy?: ConflictStrategy;
  /** Chooses among multiple results. Without one, the first result is used. */
  selectionCallback?: SelectionCallback;
}

export interface FetchOptions {
  /** Treat every non-music file as this media type. */
  forceType?: MediaType;
  progressCallback?: ProgressCallback;
  /** Checked before each file; aborting rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface ProcessOptions {
  /** Treat every non-music file as this media type. */
  forceType?: MediaType;
  /** Put renamed files here instead of next to the originals. */
  destinationDir?: string;
  progressCallback?: ProcessProgressCallback;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Null providers (Python CLI/GUI "Dummy" providers)
// ---------------------------------------------------------------------------

/** A movie provider that finds nothing (used when no movie provider is configured). */
export class NullMovieProvider implements MovieProvider {
  async searchMovie(): Promise<Movie[]> {
    return [];
  }
  async getMovie(): Promise<undefined> {
    return undefined;
  }
}

/** A TV provider that finds nothing (used when no TV provider is configured). */
export class NullTVProvider implements TVProvider {
  async searchShow(): Promise<TVShow[]> {
    return [];
  }
  async getShow(): Promise<undefined> {
    return undefined;
  }
  async getEpisode(): Promise<undefined> {
    return undefined;
  }
}

/** A music provider that finds nothing (used when MusicBrainz is not selected). */
export class NullMusicProvider implements MusicProvider {
  async searchRecording(): Promise<Track[]> {
    return [];
  }
  async searchRelease(): Promise<never[]> {
    return [];
  }
  async getRecording(): Promise<undefined> {
    return undefined;
  }
  async getRelease(): Promise<undefined> {
    return undefined;
  }
}

/** True for the providers above. */
export function isNullProvider(provider: unknown): boolean {
  return (
    provider instanceof NullMovieProvider ||
    provider instanceof NullTVProvider ||
    provider instanceof NullMusicProvider
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Error messages set by `FileRenamer.execute` for skipped operations. */
const RENAMER_SKIP_REASONS: Record<string, SkipReason> = {
  "Source and destination are the same": "same_path",
  "Would overwrite existing file": "would_overwrite",
};

export const NO_MATCH_MESSAGE = "No metadata match found";
export const UNKNOWN_METADATA_MESSAGE = "Unknown metadata type";
export const DUPLICATE_DESTINATION_MESSAGE =
  "Another file in this batch has the same destination";

/** Describe an error thrown by a metadata provider. */
export function describeLookupError(error: unknown): LookupErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  let kind: LookupErrorKind = "other";
  if (error instanceof AuthenticationError) kind = "authentication";
  else if (error instanceof RateLimitError) kind = "rate_limit";
  else if (error instanceof ProviderError) kind = "provider";
  return { kind, name, message };
}

const FEATURED_PATTERN = /\s*\((?:feat\.?|ft\.?|with|featuring)\s+[^)]+\)/giu;

/** Remove featured-artist suffixes such as "(feat. X)" from a title, for searching. */
export function cleanTitleForSearch(title: string): string {
  return title.replace(FEATURED_PATTERN, "").trim();
}

/** Normalize text for fuzzy track comparison (Python `_verify_track_match.normalize`). */
function normalizeForMatch(text: string): string {
  let t = text.toLowerCase().trim();
  t = t.replace(FEATURED_PATTERN, "");
  t = t.replace(/^the\s+/u, "");
  t = t.replace(/[^\p{L}\p{N}\p{M}_\s]/gu, "");
  t = t.replace(/\s+/gu, " ");
  return t.trim();
}

/**
 * True when any provider result matches the parsed tags: same artist and
 * same title (or one title contains the other), after normalizing case,
 * punctuation, a leading "The", and featured-artist suffixes.
 */
export function verifyTrackMatch(parsed: ParsedMusicInfo, tracks: readonly Track[]): boolean {
  if (tracks.length === 0) return false;
  const parsedTitle = normalizeForMatch(parsed.title ?? "");
  const parsedArtist = normalizeForMatch(parsed.artist ?? "");

  return tracks.some((track) => {
    const trackTitle = normalizeForMatch(track.title);
    const trackArtist = normalizeForMatch(track.artist ? track.artist.name : "");
    const artistMatch = parsedArtist === trackArtist;
    const titleMatch =
      parsedTitle === trackTitle ||
      (parsedTitle !== "" &&
        trackTitle !== "" &&
        (trackTitle.includes(parsedTitle) || parsedTitle.includes(trackTitle)));
    return titleMatch && artistMatch;
  });
}

/** Wraps an error thrown by the selection callback so it is not mistaken for a lookup failure. */
class SelectionCallbackFailure {
  constructor(readonly cause: unknown) {}
}

function isValidIndex(index: SelectionResult, length: number): index is number {
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < length;
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

// ---------------------------------------------------------------------------
// RenameService
// ---------------------------------------------------------------------------

/** Main service orchestrating the rename workflow. */
export class RenameService {
  readonly parser: FilenameParser;
  readonly movieProvider: MovieProvider;
  readonly tvProvider: TVProvider;
  readonly musicProvider: MusicProvider | undefined;
  readonly musicParser: MusicParser;
  readonly templateEngine: TemplateEngine;
  readonly fileRenamer: FileRenamer;
  readonly associatedFilesSettings: AssociatedFilesSettings;
  readonly conflictStrategy: ConflictStrategy;
  /** May be replaced between runs. */
  selectionCallback: SelectionCallback | undefined;

  constructor(options: RenameServiceOptions = {}) {
    this.parser = options.parser ?? createParser();
    this.movieProvider = options.movieProvider ?? new NullMovieProvider();
    this.tvProvider = options.tvProvider ?? new NullTVProvider();
    this.musicProvider = options.musicProvider;
    this.musicParser = options.musicParser ?? createMusicParser();
    this.templateEngine = options.templateEngine ?? new TemplateEngine();
    this.fileRenamer = options.fileRenamer ?? new FileRenamer();
    this.associatedFilesSettings = options.associatedFilesSettings ?? {
      enabled: true,
      subtitles: true,
      nfo: true,
      images: true,
    };
    this.conflictStrategy = options.conflictStrategy ?? "skip";
    this.selectionCallback = options.selectionCallback;
  }

  /** Scan a directory for media files (see `scanDirectory`). */
  scanDirectory(directory: string, options: ScanOptions = {}): Promise<string[]> {
    return scanDirectory(directory, options);
  }

  /**
   * Parse filenames (and, for music files, tags). Music files by extension
   * are always given media type "music", whatever the filename parser says
   * (it often reads "01 - Title" as a TV episode).
   */
  async parseFiles(
    paths: readonly string[],
    progressCallback?: ProgressCallback,
  ): Promise<PlannedMediaFile[]> {
    const mediaFiles: PlannedMediaFile[] = [];
    const total = paths.length;

    for (const [i, filePath] of paths.entries()) {
      const name = path.basename(filePath);
      progressCallback?.(i + 1, total, `Parsing: ${name}`);

      let parsedInfo = this.parser.parse(name);
      let parsedMusicInfo: ParsedMusicInfo | undefined;
      if (isMusicFile(filePath)) {
        parsedMusicInfo = await this.musicParser.parse(filePath);
        parsedInfo = { ...parsedInfo, mediaType: "music" };
      }

      const file: PlannedMediaFile = { path: filePath, parsedInfo };
      if (parsedMusicInfo) file.parsedMusicInfo = parsedMusicInfo;
      mediaFiles.push(file);
    }

    return mediaFiles;
  }

  /**
   * Fetch metadata for media files from the providers. Files are updated in
   * place (`matchedMetadata`, or `lookupError` when a provider throws) and
   * the same array is returned. A provider error affects only its own file.
   *
   * The media type is the file's parsed type, or `forceType` when given;
   * music files (by extension) always use the music flow.
   */
  async fetchMetadata<T extends PlannedMediaFile>(
    mediaFiles: T[],
    options: FetchOptions = {},
  ): Promise<T[]> {
    const { forceType, progressCallback, signal } = options;
    const total = mediaFiles.length;

    for (const [i, mediaFile] of mediaFiles.entries()) {
      signal?.throwIfAborted();
      progressCallback?.(i + 1, total, `Fetching: ${mediaFile.parsedInfo.title}`);

      const mediaType: MediaType = isMusicFile(mediaFile.path)
        ? "music"
        : (forceType ?? mediaFile.parsedInfo.mediaType);

      delete mediaFile.lookupError;
      try {
        if (mediaType === "movie") await this.fetchMovieMetadata(mediaFile);
        else if (mediaType === "tv_episode") await this.fetchTVMetadata(mediaFile);
        else if (mediaType === "music") await this.fetchMusicMetadata(mediaFile);
      } catch (error) {
        if (error instanceof SelectionCallbackFailure) throw error.cause;
        mediaFile.lookupError = describeLookupError(error);
      }
    }

    return mediaFiles;
  }

  /** Ask the selection callback, keeping its errors apart from provider errors. */
  private async select(options: SelectableOption[], filename: string): Promise<SelectionResult> {
    try {
      return await this.selectionCallback!(options, filename);
    } catch (error) {
      throw new SelectionCallbackFailure(error);
    }
  }

  private async fetchMovieMetadata(mediaFile: PlannedMediaFile): Promise<void> {
    const parsed = mediaFile.parsedInfo;
    const movies = await this.movieProvider.searchMovie(parsed.title, parsed.year);
    if (movies.length === 0) return;

    if (movies.length === 1 || !this.selectionCallback) {
      mediaFile.matchedMetadata = { ...movies[0]!, verificationStatus: "auto_matched" };
      return;
    }

    const index = await this.select(movies, mediaFileName(mediaFile));
    if (isValidIndex(index, movies.length)) {
      mediaFile.matchedMetadata = { ...movies[index]!, verificationStatus: "manual_selection" };
    }
  }

  private async fetchTVMetadata(mediaFile: PlannedMediaFile): Promise<void> {
    const parsed = mediaFile.parsedInfo;
    // The Python searched first and then gave up; checking first saves a request.
    if (parsed.season == null || parsed.episode == null) return;

    const shows = await this.tvProvider.searchShow(parsed.title, parsed.year);
    if (shows.length === 0) return;

    let selected: TVShow | undefined;
    let userSelected = false;
    if (shows.length === 1 || !this.selectionCallback) {
      selected = shows[0];
    } else {
      const index = await this.select(shows, mediaFileName(mediaFile));
      if (isValidIndex(index, shows.length)) {
        selected = shows[index];
        userSelected = true;
      }
    }
    if (!selected) return;

    const episode = await this.tvProvider.getEpisode(selected.id, parsed.season, parsed.episode);
    if (episode) {
      mediaFile.matchedMetadata = {
        ...episode,
        verificationStatus: userSelected ? "manual_selection" : "auto_matched",
      };
    }
  }

  /**
   * Tag-first music flow:
   * 1. Complete tags: search MusicBrainz to verify them; the track is built
   *    from the tags as "verified" or "unverified" (also "unverified" when
   *    the search fails or there is no provider).
   * 2. Incomplete tags: search MusicBrainz and use the result
   *    ("from_provider"), falling back to the partial tags ("unverified").
   */
  private async fetchMusicMetadata(mediaFile: PlannedMediaFile): Promise<void> {
    const parsed = mediaFile.parsedMusicInfo;
    if (!parsed) return;

    if (!isMusicInfoComplete(parsed)) {
      await this.fetchMusicMetadataFromProvider(mediaFile, parsed);
      return;
    }

    let status: "verified" | "unverified" = "unverified";
    if (this.musicProvider) {
      try {
        const tracks = await this.musicProvider.searchRecording(
          cleanTitleForSearch(parsed.title ?? ""),
          parsed.artist,
          parsed.album,
        );
        if (verifyTrackMatch(parsed, tracks)) status = "verified";
      } catch {
        // Network or API problem: keep the tags, unverified.
      }
    }
    mediaFile.matchedMetadata = trackFromParsedInfo(parsed, status);
  }

  private async fetchMusicMetadataFromProvider(
    mediaFile: PlannedMediaFile,
    parsed: ParsedMusicInfo,
  ): Promise<void> {
    if (!this.musicProvider) return;
    const title = parsed.title ?? "";
    if (!title) return;

    let tracks: Track[];
    try {
      tracks = await this.musicProvider.searchRecording(title, parsed.artist, parsed.album);
    } catch {
      mediaFile.matchedMetadata = trackFromParsedInfo(parsed, "unverified");
      return;
    }

    if (tracks.length === 0) {
      mediaFile.matchedMetadata = trackFromParsedInfo(parsed, "unverified");
      return;
    }

    if (tracks.length === 1 || !this.selectionCallback) {
      mediaFile.matchedMetadata = { ...tracks[0]!, verificationStatus: "from_provider" };
      return;
    }

    const index = await this.select(tracks, mediaFileName(mediaFile));
    if (isValidIndex(index, tracks.length)) {
      mediaFile.matchedMetadata = { ...tracks[index]!, verificationStatus: "from_provider" };
    }
  }

  /**
   * Pick the destination for `source`, applying the conflict strategy
   * against both the disk and destinations already planned in this batch.
   * Returns undefined when the destination duplicates an earlier one and
   * the strategy cannot version it.
   */
  private resolveDestination(
    source: string,
    desired: string,
    reserved: Set<string>,
  ): string | undefined {
    const taken = (p: string) => reserved.has(path.normalize(p));
    let result = desired;

    // A file that already has its target name (exactly, or differing only in
    // case on a case-insensitive volume) is not a conflict with itself.
    const isItself = samePath(source, desired) || isCaseOnlyRename(source, desired);

    if (this.conflictStrategy === "auto_version") {
      if (taken(desired) || (!isItself && existsSync(desired))) {
        const parent = path.dirname(desired);
        const stem = pathStem(desired);
        const suffix = pathSuffix(desired);
        for (let version = 1; ; version++) {
          if (version > 1000) {
            throw new Error(`Could not find available path after 1000 attempts: ${desired}`);
          }
          const candidate = path.join(parent, `${stem} (${version})${suffix}`);
          if (!taken(candidate) && !existsSync(candidate)) {
            result = candidate;
            break;
          }
        }
      }
    } else if (taken(desired)) {
      return undefined;
    }

    reserved.add(path.normalize(result));
    return result;
  }

  /**
   * Plan rename operations. Files without a match (or whose lookup failed,
   * or whose template fails to render) become "skipped" operations whose
   * destination is the source, so they stay visible.
   *
   * @param destinationDir Put renamed files here; default: next to the original.
   */
  async generatePreview(
    mediaFiles: readonly PlannedMediaFile[],
    destinationDir?: string,
  ): Promise<PlannedOperation[]> {
    const operations: PlannedOperation[] = [];
    const reserved = new Set<string>();

    const skipped = (
      mediaFile: PlannedMediaFile,
      skipReason: SkipReason,
      errorMessage: string,
    ): PlannedOperation => {
      const op: PlannedOperation = {
        ...createRenameOperation({
          source: mediaFile.path,
          destination: mediaFile.path,
          mediaFile,
          status: "skipped",
          errorMessage,
        }),
        skipReason,
      };
      if (mediaFile.lookupError) op.lookupError = mediaFile.lookupError;
      return op;
    };

    for (const mediaFile of mediaFiles) {
      const metadata = mediaFile.matchedMetadata;
      if (!metadata) {
        operations.push(
          mediaFile.lookupError
            ? skipped(mediaFile, "lookup_failed", mediaFile.lookupError.message)
            : skipped(mediaFile, "no_match", NO_MATCH_MESSAGE),
        );
        continue;
      }

      const parsed = mediaFile.parsedInfo;
      const extraContext: TemplateContext = {
        quality: parsed.quality,
        source: parsed.source,
        codec: parsed.codec,
        group: parsed.group,
      };
      const extension = mediaFileExtension(mediaFile);

      let newName: string;
      try {
        switch (metadata.kind) {
          case "movie":
            newName = this.templateEngine.renderMovie(metadata, extension, extraContext);
            break;
          case "episode":
            newName = this.templateEngine.renderEpisode(metadata, extension, extraContext);
            break;
          case "track": {
            // Fill in track/disc numbers from the tags when the provider had none.
            const tags = mediaFile.parsedMusicInfo;
            let track = metadata;
            if (tags) {
              if (track.trackNumber == null && tags.trackNumber) {
                track = { ...track, trackNumber: tags.trackNumber };
              }
              if (track.discNumber == null && tags.discNumber) {
                track = { ...track, discNumber: tags.discNumber };
              }
              mediaFile.matchedMetadata = track;
            }
            newName = this.templateEngine.renderTrack(track, extension, extraContext);
            break;
          }
          default:
            operations.push(skipped(mediaFile, "unknown_metadata", UNKNOWN_METADATA_MESSAGE));
            continue;
        }
      } catch (error) {
        if (!(error instanceof TemplateError)) throw error;
        operations.push(skipped(mediaFile, "template_error", error.message));
        continue;
      }

      const destDir = destinationDir ?? path.dirname(mediaFile.path);
      const newPath = this.resolveDestination(
        mediaFile.path,
        path.join(destDir, newName),
        reserved,
      );
      if (newPath === undefined) {
        operations.push(
          skipped(mediaFile, "duplicate_destination", DUPLICATE_DESTINATION_MESSAGE),
        );
        continue;
      }

      const associatedFiles: AssociatedFileRename[] = [];
      const settings = this.associatedFilesSettings;
      if (settings.enabled) {
        const extensions = getExtensionsFromSettings({
          includeSubtitles: settings.subtitles,
          includeNfo: settings.nfo,
          includeImages: settings.images,
        });
        if (extensions.size > 0) {
          const found = await findAssociatedFiles(mediaFile.path, extensions);
          const newBaseName = pathStem(newPath);
          const originalStem = pathStem(mediaFile.path);
          for (const assoc of found) {
            const generated = generateAssociatedDestination(
              assoc.path,
              newBaseName,
              originalStem,
            );
            // Associated files always go next to the main file's destination.
            const assocDest = this.resolveDestination(
              assoc.path,
              path.join(path.dirname(newPath), path.basename(generated)),
              reserved,
            );
            if (assocDest === undefined) continue;
            associatedFiles.push({
              source: assoc.path,
              destination: assocDest,
              fileType: assoc.fileType,
            });
          }
        }
      }

      operations.push(
        createRenameOperation({
          source: mediaFile.path,
          destination: newPath,
          mediaFile,
          associatedFiles,
        }),
      );
    }

    return operations;
  }

  /**
   * Execute rename operations (see `FileRenamer.execute`); operations are
   * updated in place. Operations the renamer skips get a `skipReason`.
   */
  async executeRename<T extends RenameOperation>(
    operations: T[],
    progressCallback?: ProgressCallback,
  ): Promise<T[]> {
    await this.fileRenamer.execute(operations, progressCallback);
    for (const op of operations as (T & { skipReason?: SkipReason })[]) {
      if (op.status === "skipped" && !op.skipReason && op.errorMessage) {
        const reason = RENAMER_SKIP_REASONS[op.errorMessage];
        if (reason) op.skipReason = reason;
      }
    }
    return operations;
  }

  /** Undo completed operations (see `FileRenamer.undo`). */
  async undoRename<T extends RenameOperation>(
    operations: T[],
    progressCallback?: ProgressCallback,
  ): Promise<T[]> {
    await this.fileRenamer.undo(operations, progressCallback);
    return operations;
  }

  /** Parse, fetch metadata, and plan operations in one call. */
  async processFiles(
    paths: readonly string[],
    options: ProcessOptions = {},
  ): Promise<PlannedOperation[]> {
    const { progressCallback, signal } = options;
    const phase =
      (p: ProcessPhase): ProgressCallback =>
      (current, total, message) =>
        progressCallback?.(current, total, message, p);

    signal?.throwIfAborted();
    const mediaFiles = await this.parseFiles(paths, phase("parse"));
    await this.fetchMetadata(mediaFiles, {
      forceType: options.forceType,
      progressCallback: phase("fetch"),
      signal,
    });
    signal?.throwIfAborted();
    return this.generatePreview(mediaFiles, options.destinationDir);
  }
}
