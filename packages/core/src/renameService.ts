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
import { abortable, Limiter, mapConcurrent, OrderedProgress } from "./concurrency";
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
  type Album,
  type AssociatedFileRename,
  type MediaFile,
  type MediaType,
  type Movie,
  type ParsedMusicInfo,
  type RenameOperation,
  type Track,
  type TVShow,
} from "./models";
import { withTagDetails } from "./trackDetails";
import { createMusicParser, isMusicFile, type MusicParser } from "./musicParser";
import { createParser, type FilenameParser } from "./parser";
import type { MovieProvider, MusicProvider, TVProvider } from "./providers/base";
import {
  BATCH_OVERWRITE_MESSAGE,
  FileRenamer,
  isCaseOnlyRename,
  type ProgressCallback,
} from "./renamer";
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
  /**
   * Set when the search found several results and none was chosen: the
   * selection callback skipped the file, or an earlier skip of the same
   * question was reused.
   */
  selectionSkipped?: true;
}

/**
 * Why an operation was skipped (status "skipped"):
 * - "no_match": no metadata was found (or the user skipped the selection)
 * - "lookup_failed": the provider threw; see `lookupError`
 * - "unknown_metadata": the matched metadata has an unknown kind
 * - "template_error": the template could not be rendered; see `errorMessage`
 * - "duplicate_destination": an earlier file in the batch has the same destination
 * - "same_path": the file already has its target name (set by `executeRename`)
 * - "would_overwrite": the destination exists and overwriting is off, or it is
 *   another file in this batch (set by `executeRename`)
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
  /**
   * Chooses among multiple results. Without one, the first result is used.
   * Within one fetch it is asked each question once: a later file with the
   * same list of options reuses the earlier answer, and music files in the
   * same folder reuse the album already chosen.
   */
  selectionCallback?: SelectionCallback;
  /**
   * Metadata requests in flight at once during `fetchMetadata`. Default
   * `DEFAULT_FETCH_CONCURRENCY` (6).
   */
  fetchConcurrency?: number;
  /** Music files whose tags are read at once in `parseFiles`. Default 8. */
  parseConcurrency?: number;
}

/**
 * Default number of metadata requests in flight at once. Six keeps a batch
 * well under TMDB's limit of about 50 requests per second per IP (six at a
 * time with typical 100-200 ms responses is 30-60 per second at most before
 * the cache and in-flight sharing take most of them), matches the
 * connections a browser opens per host, and already hides most latency.
 * MusicBrainz is unaffected: its client sends one request per second.
 */
export const DEFAULT_FETCH_CONCURRENCY = 6;

/** Default number of music files whose tags are read at once. */
export const DEFAULT_PARSE_CONCURRENCY = 8;

export interface FetchOptions {
  /** Treat every non-music file as this media type. */
  forceType?: MediaType;
  /**
   * Called as files finish, in file order: `current` counts 1 to `total`.
   * Never called while the selection callback is waiting for an answer.
   */
  progressCallback?: ProgressCallback;
  /** Aborting stops new requests and rejects with the signal's reason. */
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
  [BATCH_OVERWRITE_MESSAGE]: "would_overwrite",
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

/** What one file's lookup produced; applied to the file when the whole fetch succeeds. */
interface LookupOutcome {
  matchedMetadata?: PlannedMediaFile["matchedMetadata"];
  lookupError?: LookupErrorInfo;
  selectionSkipped?: true;
}

/**
 * Shared state of one `fetchMetadata` run.
 *
 * Network work runs concurrently through `net`. Anything that reads or
 * changes the selection memory (and so may ask the user) runs inside
 * `decide`, which runs files one at a time, in file order: file i decides
 * only after files 0..i-1 have decided or passed the point where they
 * would. So questions are asked one at a time, in file order, and the
 * answers reused exactly as they were when files were fetched one by one.
 */
interface FetchRun {
  memory: SelectionMemory;
  signal: AbortSignal;
  progress: OrderedProgress;
  /** Run a network step when a slot is free (never starts after abort). */
  net<T>(task: () => Promise<T>): Promise<T>;
  /** Run `step` in file order (see above). Every file must call it, or `pass`, exactly once. */
  decide<T>(index: number, step: () => Promise<T>): Promise<T>;
  /** Mark that file `index` will not decide, so later files need not wait for it. */
  pass(index: number): void;
  /** Album verification shared by the files of one album (see `albumGroupKey`). */
  albumChecks: Map<string, Promise<AlbumCheck>>;
  /** How many files with complete tags share each album key. */
  albumSizes: Map<string, number>;
}

/** Tracks of the album found for a group of files, or why there are none. */
type AlbumCheck =
  | { kind: "tracks"; tracks: Track[] }
  | { kind: "not_found" }
  | { kind: "failed" };

/** Album grouping key for complete tags: normalized artist and album. */
function albumGroupKey(parsed: ParsedMusicInfo): string {
  return `${normalizeForMatch(parsed.artist ?? "")}\u0000${normalizeForMatch(parsed.album ?? "")}`;
}

/**
 * True when the album's track list confirms the tags: a track with the same
 * normalized title (exactly, not by containment) whose artist matches as in
 * `verifyTrackMatch`. Stricter than the per-track search on purpose; a
 * track this does not confirm falls back to that search.
 */
function confirmedOnAlbum(parsed: ParsedMusicInfo, tracks: readonly Track[]): boolean {
  const title = normalizeForMatch(parsed.title ?? "");
  if (title === "") return false;
  return verifyTrackMatch(
    parsed,
    tracks.filter((track) => normalizeForMatch(track.title) === title),
  );
}

/**
 * What the user answered during one `fetchMetadata` run, so the same
 * question is asked only once:
 *
 * - **Same candidates, same answer.** When a later file produces exactly
 *   the same list of options (every episode of one show, or two copies of a
 *   movie), the earlier answer is reused, including "skip".
 * - **Same folder, same album.** Tracks of one album each produce a
 *   different list, but the answer is really "which album". Once the user
 *   picks a track, later files in the same folder take the option on that
 *   album without asking.
 */
class SelectionMemory {
  private readonly answers = new Map<string, number | undefined>();
  private readonly albumByDir = new Map<string, { key: string; title: string }>();

  private static optionsKey(options: readonly SelectableOption[]): string {
    return options.map((option) => `${option.kind}:${option.id}`).join("|");
  }

  private static albumKey(album: Album): string {
    return `${normalizeForMatch(album.title)}\u0000${normalizeForMatch(album.artist.name)}`;
  }

  /** The earlier answer to this exact list of options, if it was asked before. */
  recall(options: readonly SelectableOption[]): { answer: number | undefined } | undefined {
    const key = SelectionMemory.optionsKey(options);
    return this.answers.has(key) ? { answer: this.answers.get(key) } : undefined;
  }

  remember(options: readonly SelectableOption[], answer: number | undefined): void {
    this.answers.set(SelectionMemory.optionsKey(options), answer);
  }

  /** Remember the album the user chose for the files in `dir`. */
  rememberAlbum(dir: string, track: Track): void {
    if (!track.album) return;
    this.albumByDir.set(path.normalize(dir), {
      key: SelectionMemory.albumKey(track.album),
      title: normalizeForMatch(track.album.title),
    });
  }

  /**
   * The index of the option on the album already chosen for `dir`, or -1.
   * A file whose own tags name a different album is never matched this way.
   */
  findOnChosenAlbum(dir: string, tracks: readonly Track[], parsedAlbum: string | undefined): number {
    const chosen = this.albumByDir.get(path.normalize(dir));
    if (!chosen) return -1;
    if (parsedAlbum && normalizeForMatch(parsedAlbum) !== chosen.title) return -1;
    return tracks.findIndex(
      (track) => track.album !== undefined && SelectionMemory.albumKey(track.album) === chosen.key,
    );
  }
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
  readonly fetchConcurrency: number;
  readonly parseConcurrency: number;

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
    this.fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
    this.parseConcurrency = options.parseConcurrency ?? DEFAULT_PARSE_CONCURRENCY;
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
    const progress = new OrderedProgress(paths.length, progressCallback);
    // Tags are read concurrently; the result and the progress keep input order.
    return mapConcurrent(paths, this.parseConcurrency, async (filePath, i) => {
      const name = path.basename(filePath);
      let parsedInfo = this.parser.parse(name);
      let parsedMusicInfo: ParsedMusicInfo | undefined;
      if (isMusicFile(filePath)) {
        parsedMusicInfo = await this.musicParser.parse(filePath);
        parsedInfo = { ...parsedInfo, mediaType: "music" };
      }

      const file: PlannedMediaFile = { path: filePath, parsedInfo };
      if (parsedMusicInfo) file.parsedMusicInfo = parsedMusicInfo;
      progress.complete(i, `Parsing: ${name}`);
      return file;
    });
  }

  /**
   * Fetch metadata for media files from the providers. Files are updated in
   * place (`matchedMetadata`, or `lookupError` when a provider throws) and
   * the same array is returned. A provider error affects only its own file.
   *
   * The media type is the file's parsed type, or `forceType` when given;
   * music files (by extension) always use the music flow.
   *
   * Lookups run concurrently (`fetchConcurrency` requests at a time), but
   * the result does not depend on which response arrives first: questions
   * go to the selection callback one at a time, in file order, and progress
   * is reported in file order. Files are updated only when the whole fetch
   * succeeds; on abort or a selection callback error they are left as they
   * were.
   */
  async fetchMetadata<T extends PlannedMediaFile>(
    mediaFiles: T[],
    options: FetchOptions = {},
  ): Promise<T[]> {
    const { forceType, progressCallback, signal } = options;
    signal?.throwIfAborted();

    // Aborted by the caller's signal, or by a selection callback error.
    const stop = new AbortController();
    const onAbort = (): void => stop.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    const run = this.createFetchRun(mediaFiles, stop.signal, progressCallback);
    const outcomes = new Array<LookupOutcome>(mediaFiles.length);

    const lookup = async (mediaFile: T, index: number): Promise<void> => {
      const mediaType: MediaType = isMusicFile(mediaFile.path)
        ? "music"
        : (forceType ?? mediaFile.parsedInfo.mediaType);
      const out: LookupOutcome = {};
      try {
        if (mediaType === "movie") await this.fetchMovieMetadata(mediaFile, out, index, run);
        else if (mediaType === "tv_episode") await this.fetchTVMetadata(mediaFile, out, index, run);
        else if (mediaType === "music") await this.fetchMusicMetadata(mediaFile, out, index, run);
      } catch (error) {
        if (error instanceof SelectionCallbackFailure) {
          stop.abort(error.cause);
          throw error.cause;
        }
        if (stop.signal.aborted) throw stop.signal.reason;
        out.lookupError = describeLookupError(error);
      } finally {
        // Files that never reached a decision must not hold up later files.
        run.pass(index);
      }
      outcomes[index] = out;
      run.progress.complete(index, `Fetching: ${mediaFile.parsedInfo.title}`);
    };

    try {
      await abortable(Promise.all(mediaFiles.map(lookup)), stop.signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    for (const [i, mediaFile] of mediaFiles.entries()) {
      const out = outcomes[i]!;
      delete mediaFile.lookupError;
      delete mediaFile.selectionSkipped;
      if (out.matchedMetadata) mediaFile.matchedMetadata = out.matchedMetadata;
      if (out.lookupError) mediaFile.lookupError = out.lookupError;
      if (out.selectionSkipped) mediaFile.selectionSkipped = true;
    }
    return mediaFiles;
  }

  private createFetchRun(
    mediaFiles: readonly PlannedMediaFile[],
    signal: AbortSignal,
    progressCallback: ProgressCallback | undefined,
  ): FetchRun {
    const limiter = new Limiter(this.fetchConcurrency);

    // turnDone[i] resolves once files 0..i have each decided or passed;
    // file i decides after turnDone[i - 1]. release[i] marks file i's part.
    const release: Array<() => void> = [];
    const turnDone: Promise<void>[] = [];
    let previous: Promise<void> = Promise.resolve();
    for (let i = 0; i < mediaFiles.length; i++) {
      const own = new Promise<void>((resolve) => release.push(resolve));
      previous = Promise.all([previous, own]).then(() => undefined);
      turnDone.push(previous);
    }

    const albumSizes = new Map<string, number>();
    if (this.musicProvider?.getReleaseTracks) {
      for (const file of mediaFiles) {
        const parsed = file.parsedMusicInfo;
        if (!isMusicFile(file.path) || !parsed || !isMusicInfoComplete(parsed)) continue;
        const key = albumGroupKey(parsed);
        albumSizes.set(key, (albumSizes.get(key) ?? 0) + 1);
      }
    }

    return {
      memory: new SelectionMemory(),
      signal,
      progress: new OrderedProgress(mediaFiles.length, progressCallback),
      net: (task) => limiter.run(task, signal),
      decide: async (index, step) => {
        try {
          if (index > 0) await abortable(turnDone[index - 1]!, signal);
          signal.throwIfAborted();
          return await step();
        } finally {
          release[index]!();
        }
      },
      pass: (index) => release[index]!(),
      albumChecks: new Map(),
      albumSizes,
    };
  }

  /**
   * Ask the selection callback, keeping its errors apart from provider
   * errors. A question already answered in this run (the same list of
   * options) is not asked again: the earlier answer, or skip, is reused.
   * Must run inside `run.decide`. Progress is held while the callback waits,
   * so a front end's prompt is never drawn over.
   */
  private async select(
    options: SelectableOption[],
    filename: string,
    run: FetchRun,
  ): Promise<SelectionResult> {
    const earlier = run.memory.recall(options);
    if (earlier) return earlier.answer;

    let answer: SelectionResult;
    run.progress.hold();
    try {
      answer = await this.selectionCallback!(options, filename);
    } catch (error) {
      throw new SelectionCallbackFailure(error);
    } finally {
      run.progress.release();
    }
    run.memory.remember(options, isValidIndex(answer, options.length) ? answer : undefined);
    return answer;
  }

  private async fetchMovieMetadata(
    mediaFile: PlannedMediaFile,
    out: LookupOutcome,
    index: number,
    run: FetchRun,
  ): Promise<void> {
    const parsed = mediaFile.parsedInfo;
    const movies = await run.net(() => this.movieProvider.searchMovie(parsed.title, parsed.year));
    if (movies.length === 0) return;

    if (movies.length === 1 || !this.selectionCallback) {
      out.matchedMetadata = { ...movies[0]!, verificationStatus: "auto_matched" };
      return;
    }

    const choice = await run.decide(index, () => this.select(movies, mediaFileName(mediaFile), run));
    if (isValidIndex(choice, movies.length)) {
      out.matchedMetadata = { ...movies[choice]!, verificationStatus: "manual_selection" };
    } else {
      out.selectionSkipped = true;
    }
  }

  private async fetchTVMetadata(
    mediaFile: PlannedMediaFile,
    out: LookupOutcome,
    index: number,
    run: FetchRun,
  ): Promise<void> {
    const parsed = mediaFile.parsedInfo;
    // The Python searched first and then gave up; checking first saves a request.
    if (parsed.season == null || parsed.episode == null) return;
    const { season, episode: episodeNumber } = parsed;

    const shows = await run.net(() => this.tvProvider.searchShow(parsed.title, parsed.year));
    if (shows.length === 0) return;

    let selected: TVShow | undefined;
    let userSelected = false;
    if (shows.length === 1 || !this.selectionCallback) {
      selected = shows[0];
      run.pass(index);
    } else {
      const choice = await run.decide(index, () => this.select(shows, mediaFileName(mediaFile), run));
      if (isValidIndex(choice, shows.length)) {
        selected = shows[choice];
        userSelected = true;
      } else {
        out.selectionSkipped = true;
      }
    }
    if (!selected) return;

    const showId = selected.id;
    const episode = await run.net(() => this.tvProvider.getEpisode(showId, season, episodeNumber));
    if (episode) {
      out.matchedMetadata = {
        ...episode,
        verificationStatus: userSelected ? "manual_selection" : "auto_matched",
      };
    }
  }

  /**
   * Tag-first music flow:
   * 1. Complete tags: check them against MusicBrainz; the track is built
   *    from the tags as "verified" or "unverified" (also "unverified" when
   *    the lookup fails or there is no provider). When several files share
   *    an album (same artist and album tags), the album is looked up once
   *    (a release search and one release lookup with its tracks) and each
   *    file is checked against its track list; a file the list does not
   *    confirm falls back to its own recording search.
   * 2. Incomplete tags: search MusicBrainz and use the result
   *    ("from_provider"), falling back to the partial tags ("unverified").
   */
  private async fetchMusicMetadata(
    mediaFile: PlannedMediaFile,
    out: LookupOutcome,
    index: number,
    run: FetchRun,
  ): Promise<void> {
    const parsed = mediaFile.parsedMusicInfo;
    if (!parsed) return;

    if (!isMusicInfoComplete(parsed)) {
      await this.fetchMusicMetadataFromProvider(mediaFile, parsed, out, index, run);
      return;
    }

    out.matchedMetadata = trackFromParsedInfo(parsed, await this.verifyTags(parsed, run));
  }

  /** "verified" when MusicBrainz confirms complete tags, else "unverified". */
  private async verifyTags(
    parsed: ParsedMusicInfo,
    run: FetchRun,
  ): Promise<"verified" | "unverified"> {
    const provider = this.musicProvider;
    if (!provider) return "unverified";

    const key = albumGroupKey(parsed);
    if ((run.albumSizes.get(key) ?? 0) >= 2) {
      const album = await this.checkAlbum(key, parsed, run);
      if (album.kind === "failed") return "unverified";
      if (album.kind === "tracks" && confirmedOnAlbum(parsed, album.tracks)) return "verified";
    }

    try {
      const tracks = await run.net(() =>
        provider.searchRecording(cleanTitleForSearch(parsed.title ?? ""), parsed.artist, parsed.album),
      );
      return verifyTrackMatch(parsed, tracks) ? "verified" : "unverified";
    } catch (error) {
      if (run.signal.aborted) throw error;
      // Network or API problem: keep the tags, unverified.
      return "unverified";
    }
  }

  /**
   * Look up the album named by complete tags, once per album per run: a
   * release search, then the track list of the first release whose title
   * and artist match the tags.
   */
  private checkAlbum(key: string, parsed: ParsedMusicInfo, run: FetchRun): Promise<AlbumCheck> {
    const existing = run.albumChecks.get(key);
    if (existing) return existing;

    const provider = this.musicProvider!;
    const albumTitle = normalizeForMatch(parsed.album ?? "");
    const artist = normalizeForMatch(parsed.artist ?? "");
    const check = run
      .net(async (): Promise<AlbumCheck> => {
        const releases = await provider.searchRelease(parsed.album ?? "", parsed.artist);
        const release = releases.find(
          (r) => normalizeForMatch(r.title) === albumTitle && normalizeForMatch(r.artist.name) === artist,
        );
        if (!release) return { kind: "not_found" };
        const tracks = await provider.getReleaseTracks!(release.id);
        return { kind: "tracks", tracks };
      })
      .catch((error: unknown): AlbumCheck => {
        if (run.signal.aborted) throw error;
        return { kind: "failed" };
      });
    run.albumChecks.set(key, check);
    return check;
  }

  private async fetchMusicMetadataFromProvider(
    mediaFile: PlannedMediaFile,
    parsed: ParsedMusicInfo,
    out: LookupOutcome,
    index: number,
    run: FetchRun,
  ): Promise<void> {
    const provider = this.musicProvider;
    if (!provider) return;
    const title = parsed.title ?? "";
    if (!title) return;

    let tracks: Track[];
    try {
      tracks = await run.net(() => provider.searchRecording(title, parsed.artist, parsed.album));
    } catch (error) {
      if (run.signal.aborted) throw error;
      out.matchedMetadata = trackFromParsedInfo(parsed, "unverified");
      return;
    }

    if (tracks.length === 0) {
      out.matchedMetadata = trackFromParsedInfo(parsed, "unverified");
      return;
    }

    if (tracks.length === 1 || !this.selectionCallback) {
      out.matchedMetadata = { ...tracks[0]!, verificationStatus: "from_provider" };
      return;
    }

    await run.decide(index, async () => {
      // Tracks of one album each return a different list, but the question
      // is the same ("which album?"): reuse the album chosen for this folder.
      const dir = path.dirname(mediaFile.path);
      const onChosenAlbum = run.memory.findOnChosenAlbum(dir, tracks, parsed.album);
      if (onChosenAlbum >= 0) {
        out.matchedMetadata = { ...tracks[onChosenAlbum]!, verificationStatus: "from_provider" };
        return;
      }

      const choice = await this.select(tracks, mediaFileName(mediaFile), run);
      if (isValidIndex(choice, tracks.length)) {
        out.matchedMetadata = { ...tracks[choice]!, verificationStatus: "from_provider" };
        run.memory.rememberAlbum(dir, tracks[choice]!);
      } else {
        out.selectionSkipped = true;
      }
    });
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
        edition: parsed.edition,
        audio_codec: parsed.audioCodec,
        audio_channels: parsed.audioChannels,
        hdr: parsed.hdr,
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
              track = withTagDetails(track, tags);
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
