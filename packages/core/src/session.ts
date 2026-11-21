/**
 * Front-end wiring: one implementation of what the Python CLI
 * (`cli/main.py`) and GUI (`gui/app.py`) each built for themselves.
 *
 * Typical flow:
 *
 *   const config = new ConfigService();
 *   const session = await createSession(config, { selectionCallback });
 *   const files = await session.collectFiles([folder], { recursive: true });
 *   const ops = await session.plan(files, { progressCallback });
 *   await session.execute(ops, progressCallback);   // also writes tags and NFO files when [write_metadata] is on
 *   if (session.coverArtEnabled) await session.downloadCoverArt(ops);
 *   await session.saveHistory(ops);
 *   // later
 *   await undoLastRename(config);
 *
 * Every builder below is exported on its own, so a front end can assemble
 * a `RenameService` differently when it needs to.
 */

import path from "node:path";
import {
  toHistoryOperation,
  type ConfigService,
  type HistoryEntry,
  type HistoryOperation,
  type Settings,
} from "./config";
import { isConflictStrategy, type ConflictStrategy } from "./conflictResolution";
import { CoverArtDownloader } from "./coverArt";
import type { EpisodeOrder } from "./episodeOrder";
import { ConfigError, HistoryChangedError, RenameError } from "./errors";
import { PlanCorrector } from "./matchCorrection";
import type { MediaType, RenameOperation } from "./models";
import {
  restoreTagsForUndo,
  undoCreatedFiles,
  writeMetadataForOperations,
  type CreatedFileRecord,
  type CreatedFileUndoOutcome,
  type TagUndoOutcome,
  type WriteMetadataSettings,
} from "./metadataWrite";
import type { MusicParser } from "./musicParser";
import type { FilenameParser } from "./parser";
import type { FetchFn, MovieProvider, MusicProvider, TVProvider } from "./providers/base";
import { APICache } from "./providers/cache";
import { MusicBrainzClient } from "./providers/musicbrainz";
import { TMDBClient } from "./providers/tmdb";
import { TVDBClient } from "./providers/tvdb";
import type { ResponseCache } from "./providers/util";
import type { RewriteHooks } from "./tags/index";
import {
  NullMovieProvider,
  NullMusicProvider,
  NullTVProvider,
  RenameService,
  type PlannedOperation,
  type ProcessProgressCallback,
  type SelectionCallback,
} from "./renameService";
import { FileRenamer, type ProgressCallback } from "./renamer";
import { collectMediaFiles, extensionsForMediaType, type CollectOptions } from "./scan";
import { TemplateEngine } from "./template";
import {
  applyTransferChecks,
  checkOutputFolders,
  outputDirFor,
  outputKindFor,
  outputPlanFromSettings,
  type OutputPlan,
} from "./output";
import {
  historyPathKey,
  undoTransferredFile,
  type TransferMode,
  type UndoKeptFile,
} from "./transfer";

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

/**
 * Which metadata services to use (CLI `--provider`, GUI provider menu):
 * - "auto": the best available service for each media type
 * - "tmdb": TMDB for movies and TV; no music lookups
 * - "tvdb": TVDB for TV; no movie or music lookups
 * - "musicbrainz": MusicBrainz for music; no movie or TV lookups
 */
export type ProviderChoice = "auto" | "tmdb" | "tvdb" | "musicbrainz";
export const PROVIDER_CHOICES: readonly ProviderChoice[] = ["auto", "tmdb", "tvdb", "musicbrainz"];

/** Media type selection (CLI `--type`, GUI type menu). "auto" detects per file. */
export type MediaTypeChoice = "auto" | "movie" | "tv" | "music";
export const MEDIA_TYPE_CHOICES: readonly MediaTypeChoice[] = ["auto", "movie", "tv", "music"];

/** The forced media type for a choice (undefined for "auto"). */
export function forceTypeForChoice(choice: MediaTypeChoice = "auto"): MediaType | undefined {
  switch (choice) {
    case "movie":
      return "movie";
    case "tv":
      return "tv_episode";
    case "music":
      return "music";
    default:
      return undefined;
  }
}

/** Services that need an API key. */
export type ApiKeyProvider = "tmdb" | "tvdb";

/** Names of the metadata services. */
export type ProviderName = "tmdb" | "tvdb" | "musicbrainz";

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Required API keys are missing. Front ends detect this with `instanceof`
 * and read `reason` / `providers` instead of matching the message.
 * - reason "provider_key_missing": the chosen provider ("tmdb" or "tvdb")
 *   has no key; `providers` is that one provider. (Python CLI: "TMDB API
 *   key not configured.")
 * - reason "no_keys": movie/TV lookups were requested but neither key is
 *   set; `providers` is ["tmdb", "tvdb"]. (Python CLI: "No API keys
 *   configured.")
 */
export class MissingApiKeyError extends ConfigError {
  readonly reason: "provider_key_missing" | "no_keys";
  readonly providers: ApiKeyProvider[];

  constructor(reason: "provider_key_missing" | "no_keys", providers: ApiKeyProvider[]) {
    super(
      reason === "no_keys"
        ? "No API keys configured"
        : `${providers.map((p) => p.toUpperCase()).join(", ")} API key not configured`,
    );
    this.reason = reason;
    this.providers = providers;
  }
}

/** Which API keys are configured. */
export interface ApiKeyStatus {
  tmdb: boolean;
  tvdb: boolean;
}

export function getApiKeyStatus(settings: Settings): ApiKeyStatus {
  return {
    tmdb: settings.api.tmdbApiKey.trim() !== "",
    tvdb: settings.api.tvdbApiKey.trim() !== "",
  };
}

export interface ApiKeyCheckOptions {
  provider?: ProviderChoice;
  mediaType?: MediaTypeChoice;
}

/**
 * The Python CLI's API key checks, returned instead of thrown. Undefined
 * when the run can proceed. Music-only runs (media type "music" or provider
 * "musicbrainz") need no keys.
 */
export function checkApiKeys(
  settings: Settings,
  { provider = "auto", mediaType = "auto" }: ApiKeyCheckOptions = {},
): MissingApiKeyError | undefined {
  const keys = getApiKeyStatus(settings);
  if (provider === "tmdb" && !keys.tmdb) return new MissingApiKeyError("provider_key_missing", ["tmdb"]);
  if (provider === "tvdb" && !keys.tvdb) return new MissingApiKeyError("provider_key_missing", ["tvdb"]);
  if (
    provider === "auto" &&
    mediaType !== "music" &&
    !keys.tmdb &&
    !keys.tvdb
  ) {
    return new MissingApiKeyError("no_keys", ["tmdb", "tvdb"]);
  }
  return undefined;
}

/**
 * Provider choices that make sense for the configured keys, in menu order
 * (the GUI provider menu): "auto" when at least one key is set, each keyed
 * provider that has a key, and always "musicbrainz".
 */
export function availableProviderChoices(settings: Settings): ProviderChoice[] {
  const keys = getApiKeyStatus(settings);
  const choices: ProviderChoice[] = [];
  if (keys.tmdb || keys.tvdb) choices.push("auto");
  if (keys.tmdb) choices.push("tmdb");
  if (keys.tvdb) choices.push("tvdb");
  choices.push("musicbrainz");
  return choices;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** The providers a RenameService uses, and the clients behind them. */
export interface ProviderSet {
  movieProvider: MovieProvider;
  tvProvider: TVProvider;
  musicProvider: MusicProvider;
  /** The service behind each role; undefined means a null provider (finds nothing). */
  sources: {
    movie?: "tmdb";
    tv?: "tmdb" | "tvdb";
    music?: "musicbrainz";
  };
  /** The real clients that were created. */
  clients: {
    tmdb?: TMDBClient;
    tvdb?: TVDBClient;
    musicbrainz?: MusicBrainzClient;
  };
}

export interface BuildProvidersOptions {
  /** Default "auto". */
  provider?: ProviderChoice;
  /** Response cache shared by all clients. Default: none. */
  cache?: ResponseCache;
  /** Fetch implementation for all clients. Default `globalThis.fetch`. */
  fetch?: FetchFn;
}

/**
 * Build providers from settings. Never throws for missing keys: a role
 * whose service has no key gets a null provider (see `checkApiKeys` for the
 * strict check).
 *
 * In "auto" mode, movies use TMDB; TV uses the `[providers] tv` setting
 * ("tvdb" or "tmdb") when its key is set and otherwise whichever of the two
 * has a key; music uses MusicBrainz. (TVDB has no movie search, so it is
 * never used for movies.)
 */
export function buildProviders(
  settings: Settings,
  options: BuildProvidersOptions = {},
): ProviderSet {
  const provider = options.provider ?? "auto";
  const keys = getApiKeyStatus(settings);
  const { cache } = options;
  const fetchOpt = options.fetch ? { fetch: options.fetch } : {};

  const wantTmdb = (provider === "auto" || provider === "tmdb") && keys.tmdb;
  const wantTvdb = (provider === "auto" || provider === "tvdb") && keys.tvdb;
  const wantMusicBrainz = provider === "auto" || provider === "musicbrainz";

  const clients: ProviderSet["clients"] = {};
  if (wantTmdb) {
    clients.tmdb = new TMDBClient({
      apiKey: settings.api.tmdbApiKey.trim(),
      cache,
      language: settings.metadata.language,
      episodeOrder: settings.tv.episodeOrder,
      ...fetchOpt,
    });
  }
  if (wantTvdb) {
    const pin = settings.api.tvdbPin.trim();
    clients.tvdb = new TVDBClient({
      apiKey: settings.api.tvdbApiKey.trim(),
      ...(pin ? { pin } : {}),
      cache,
      language: settings.metadata.language,
      episodeOrder: settings.tv.episodeOrder,
      ...fetchOpt,
    });
  }
  if (wantMusicBrainz) {
    clients.musicbrainz = new MusicBrainzClient({ cache, ...fetchOpt });
  }

  const set: ProviderSet = {
    movieProvider: new NullMovieProvider(),
    tvProvider: new NullTVProvider(),
    musicProvider: new NullMusicProvider(),
    sources: {},
    clients,
  };

  if (clients.tmdb) {
    set.movieProvider = clients.tmdb;
    set.sources.movie = "tmdb";
  }

  const preferTmdbForTv =
    provider === "tmdb" || (provider === "auto" && settings.tvProvider === "tmdb");
  if (clients.tmdb && (preferTmdbForTv || !clients.tvdb)) {
    set.tvProvider = clients.tmdb;
    set.sources.tv = "tmdb";
  } else if (clients.tvdb) {
    set.tvProvider = clients.tvdb;
    set.sources.tv = "tvdb";
  }

  if (clients.musicbrainz) {
    set.musicProvider = clients.musicbrainz;
    set.sources.music = "musicbrainz";
  }

  return set;
}

/** The template engine for the configured templates. */
export function buildTemplateEngine(settings: Settings): TemplateEngine {
  return new TemplateEngine({
    movieTemplate: settings.templates.movie,
    tvTemplate: settings.templates.tv,
    musicTemplate: settings.templates.music,
  });
}

/** The configured conflict strategy, or "skip" when the setting is not valid. */
export function resolveConflictStrategy(settings: Settings): ConflictStrategy {
  return isConflictStrategy(settings.conflictResolution) ? settings.conflictResolution : "skip";
}

export interface BuildFileRenamerOptions {
  /** Validate without renaming. Default false. */
  dryRun?: boolean;
  /** Default: `[output] transfer_mode`. */
  transferMode?: TransferMode;
}

/**
 * A FileRenamer for the settings. Overwriting is on exactly when the
 * conflict strategy is "overwrite"; the transfer mode is `[output]
 * transfer_mode` unless given.
 */
export function buildFileRenamer(
  settings: Settings,
  { dryRun = false, transferMode }: BuildFileRenamerOptions = {},
): FileRenamer {
  return new FileRenamer({
    dryRun,
    overwrite: resolveConflictStrategy(settings) === "overwrite",
    transferMode: transferMode ?? settings.output.transferMode,
  });
}

/** A CoverArtDownloader for the `[cover_art]` settings. */
export function buildCoverArtDownloader(
  settings: Settings,
  options: { fetch?: FetchFn } = {},
): CoverArtDownloader {
  return new CoverArtDownloader({
    filename: settings.coverArt.filename,
    musicFilename: settings.coverArt.musicFilename,
    overwrite: settings.coverArt.overwrite,
    size: settings.coverArt.size,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export interface BuildRenameServiceOptions {
  /** Providers to use. Default `buildProviders(settings)`. */
  providers?: Pick<ProviderSet, "movieProvider" | "tvProvider" | "musicProvider">;
  selectionCallback?: SelectionCallback;
  /** Renamer to use. Default `buildFileRenamer(settings, { dryRun })`. */
  fileRenamer?: FileRenamer;
  dryRun?: boolean;
  /** Default: `[output] transfer_mode`. */
  transferMode?: TransferMode;
  parser?: FilenameParser;
  musicParser?: MusicParser;
}

/** A RenameService configured from settings. */
export function buildRenameService(
  settings: Settings,
  options: BuildRenameServiceOptions = {},
): RenameService {
  const providers = options.providers ?? buildProviders(settings);
  return new RenameService({
    parser: options.parser,
    musicParser: options.musicParser,
    movieProvider: providers.movieProvider,
    tvProvider: providers.tvProvider,
    musicProvider: providers.musicProvider,
    templateEngine: buildTemplateEngine(settings),
    fileRenamer:
      options.fileRenamer ??
      buildFileRenamer(settings, { dryRun: options.dryRun, transferMode: options.transferMode }),
    associatedFilesSettings: { ...settings.associatedFiles },
    conflictStrategy: resolveConflictStrategy(settings),
    selectionCallback: options.selectionCallback,
  });
}

// ---------------------------------------------------------------------------
// Results and history
// ---------------------------------------------------------------------------

/** Counts for a batch of operations. */
export interface OperationSummary {
  /** Number of operations (main files). */
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  pending: number;
  /** Associated files across all operations. */
  associatedFiles: number;
  /** Main plus associated files. */
  totalFiles: number;
}

export function summarizeOperations(operations: readonly RenameOperation[]): OperationSummary {
  const summary: OperationSummary = {
    total: operations.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    associatedFiles: 0,
    totalFiles: 0,
  };
  for (const op of operations) {
    summary[op.status] += 1;
    summary.associatedFiles += op.associatedFiles.length;
    summary.totalFiles += 1 + op.associatedFiles.length;
  }
  return summary;
}

/** History records for the completed operations (others are left out). */
export function completedHistoryOperations(
  operations: readonly RenameOperation[],
): HistoryOperation[] {
  return operations.filter((op) => op.status === "completed").map(toHistoryOperation);
}

/**
 * Save the completed operations as one history entry. Nothing is saved when
 * none completed. Returns the number of operations recorded.
 */
export async function recordHistory(
  config: ConfigService,
  operations: readonly RenameOperation[],
): Promise<number> {
  const records = completedHistoryOperations(operations);
  if (records.length > 0) await config.saveHistory(records);
  return records.length;
}

/**
 * Outcome of undoing one history operation:
 * - "undone": the file (and any associated files found) were moved back,
 *   or the copies and links made were removed
 * - "missing": nothing was found at the renamed paths, so nothing moved
 * - "kept": at least one file was left in place on purpose (see `kept`):
 *   it is not the file the rename produced, or removing a copy could lose
 *   the only copy
 * - "failed": at least one move failed; see `errors`
 */
export type UndoItemStatus = "undone" | "missing" | "kept" | "failed";

export interface UndoItemResult {
  operation: HistoryOperation;
  status: UndoItemStatus;
  /** "name: reason" for each move that failed. */
  errors: string[];
  /** Files left in place on purpose, with the reason. */
  kept: UndoKeptFile[];
  /** Tags written by the rename: put back, or why not. Absent when none were written. */
  tags?: TagUndoOutcome;
  /** NFO files the rename created: removed, or why not. Absent when none were created. */
  createdFiles?: CreatedFileUndoOutcome[];
}

export interface UndoResult {
  /** False when there was no history to undo (Python CLI: "No rename history found."). */
  historyFound: boolean;
  /** One result per operation, in the order they were undone (last renamed first). */
  items: UndoItemResult[];
  undone: number;
  missing: number;
  /** Operations with a file left in place on purpose (status "kept"). */
  kept: number;
  failed: number;
}

export interface UndoOptions {
  progressCallback?: ProgressCallback;
  /** Renamer used to move files back. Default: a new FileRenamer (no overwrite). */
  renamer?: FileRenamer;
  /**
   * `undoLastRename` only: the timestamp of the history entry the user
   * confirmed. When the most recent entry has a different timestamp (another
   * process recorded a rename since), nothing is moved and
   * HistoryChangedError is thrown.
   */
  expectedTimestamp?: string;
  /**
   * Paths that more recent history entries touched (see
   * `undoTransferredFile`). Set by `undoHistoryEntry`.
   */
  touchedLater?: ReadonlySet<string>;
  /** Tests: fail in the middle of restoring tags. */
  tagHooks?: RewriteHooks;
}

interface UndoItemInternal extends UndoItemResult {
  /** What is still to undo after the attempt (for rewriting history). */
  remaining?: HistoryOperation;
  moved: boolean;
}

/** Undo one history operation's files: associated files first, then the main file. */
async function undoItems(
  operations: readonly HistoryOperation[],
  options: UndoOptions,
): Promise<UndoItemInternal[]> {
  const renamer = options.renamer ?? new FileRenamer();
  const ordered = [...operations].reverse();
  const results: UndoItemInternal[] = [];

  for (const [i, op] of ordered.entries()) {
    options.progressCallback?.(i + 1, ordered.length, `Undoing: ${path.basename(op.destination)}`);
    const errors: string[] = [];
    const kept: UndoKeptFile[] = [];
    let moved = false;

    /** Undo one file; true when it needs no further undo (done, missing, or changed since). */
    const undoOne = async (record: HistoryOperation | HistoryOperation["associatedFiles"][number]) => {
      let outcome;
      try {
        outcome = await undoTransferredFile(record, {
          moveBack: (from, to) => renamer.rename(from, to),
          touchedLater: options.touchedLater,
        });
      } catch (error) {
        if (!(error instanceof RenameError)) throw error;
        outcome = { kind: "failed" as const, message: error.message };
      }
      switch (outcome.kind) {
        case "restored":
          moved = true;
          return true;
        case "missing":
          return true;
        case "kept":
          kept.push({ path: record.destination, reason: outcome.reason });
          // A changed file will never be ours again; the others may be
          // undone later (original back online, later rename undone).
          return outcome.reason === "changed";
        case "failed":
          errors.push(`${path.basename(record.destination)}: ${outcome.message}`);
          return false;
      }
    };

    const remainingAssoc: HistoryOperation["associatedFiles"] = [];
    for (const assoc of [...op.associatedFiles].reverse()) {
      if (!(await undoOne(assoc))) remainingAssoc.unshift(assoc);
    }
    // Tags written by the rename go back before the file does (moves only).
    const tagUndo = await restoreTagsForUndo(op, options.tagHooks);
    let mainRecord: HistoryOperation = op;
    if (tagUndo.outcome && tagUndo.outcome.status === "restored" && tagUndo.fingerprint) {
      mainRecord = { ...op, fingerprint: tagUndo.fingerprint };
      delete mainRecord.tags;
    } else if (tagUndo.outcome?.reason === "failed") {
      errors.push(`${path.basename(op.destination)}: tags not restored: ${tagUndo.outcome.message ?? "unknown error"}`);
    }
    const mainDone = tagUndo.outcome?.reason === "failed" ? false : await undoOne(mainRecord);

    const status: UndoItemStatus =
      errors.length > 0 ? "failed" : kept.length > 0 ? "kept" : moved ? "undone" : "missing";
    const item: UndoItemInternal = { operation: op, status, errors, kept, moved };
    if (tagUndo.outcome) item.tags = tagUndo.outcome;
    if (!mainDone || remainingAssoc.length > 0) {
      const remaining: HistoryOperation = { ...mainRecord, associatedFiles: remainingAssoc };
      // Created files are handled once, below; never retried.
      delete remaining.createdFiles;
      item.remaining = remaining;
    }
    results.push(item);
  }

  // NFO files the renames created: after every file of the entry is back,
  // so a tvshow.nfo whose folder is now empty of videos can go too.
  for (const [i, op] of ordered.entries()) {
    const created: CreatedFileRecord[] = op.createdFiles ?? [];
    if (created.length === 0) continue;
    const episodesFirst = [...created.filter((c) => c.kind !== "tvshow"), ...created.filter((c) => c.kind === "tvshow")];
    results[i]!.createdFiles = await undoCreatedFiles(episodesFirst);
  }
  return results;
}

function toUndoResult(items: UndoItemInternal[]): UndoResult {
  return {
    historyFound: true,
    items: items.map(({ operation, status, errors, kept, tags, createdFiles }) => ({
      operation,
      status,
      errors,
      kept,
      ...(tags ? { tags } : {}),
      ...(createdFiles ? { createdFiles } : {}),
    })),
    undone: items.filter((i) => i.status === "undone").length,
    missing: items.filter((i) => i.status === "missing").length,
    kept: items.filter((i) => i.status === "kept").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}

/**
 * Move files from history operations back to their original names (and
 * remove copies and links), last renamed first. Does not touch the history
 * file.
 */
export async function undoHistoryOperations(
  operations: readonly HistoryOperation[],
  options: UndoOptions = {},
): Promise<UndoResult> {
  return toUndoResult(await undoItems(operations, options));
}

const NO_HISTORY: UndoResult = { historyFound: false, items: [], undone: 0, missing: 0, kept: 0, failed: 0 };

/**
 * Undo one entry and update it in the history: removed when nothing is left
 * to undo; otherwise replaced by what is left (failed moves, and files kept
 * for a reason that may pass), so undo can be retried; left as it was when
 * nothing could be done at all. Only that entry is changed.
 */
async function undoEntry(
  config: ConfigService,
  entry: HistoryEntry,
  options: UndoOptions,
): Promise<UndoResult> {
  const items = await undoItems(entry.operations, options);
  const left = items.filter((i) => i.remaining);
  if (left.length === 0) {
    await config.replaceHistoryEntry(entry, []);
  } else if (items.some((i) => i.moved || i.kept.some((k) => k.reason === "changed"))) {
    // History is undone last-first; store the remainder in the original order.
    const remaining = left.map((i) => i.remaining!).reverse();
    await config.replaceHistoryEntry(entry, remaining);
  }
  return toUndoResult(items);
}

/**
 * Undo the most recent history entry and update the history: the entry is
 * removed when everything was undone; when some moves failed, it is
 * replaced by an entry holding only what is still renamed, so undo can be
 * retried; when nothing could be moved at all, it is left as it was. Only
 * that entry is changed, even if another process records a rename while
 * the undo runs.
 * @throws HistoryChangedError when `expectedTimestamp` is given and the most
 *   recent entry is a different one.
 */
export async function undoLastRename(
  config: ConfigService,
  options: UndoOptions = {},
): Promise<UndoResult> {
  const entry = (await config.loadHistory())[0];
  if (
    options.expectedTimestamp !== undefined &&
    (!entry || entry.timestamp !== options.expectedTimestamp)
  ) {
    throw new HistoryChangedError(
      "The rename history changed since it was shown (another rename was recorded or undone). Review the last rename and try again.",
    );
  }
  if (!entry || entry.operations.length === 0) return { ...NO_HISTORY };
  return undoEntry(config, entry, options);
}

/** Every path a history entry names (sources and destinations, associated files included). */
function entryPaths(entry: HistoryEntry): string[] {
  return entry.operations.flatMap((op) => [
    op.source,
    op.destination,
    ...op.associatedFiles.flatMap((a) => [a.source, a.destination]),
  ]);
}

/**
 * Undo any history entry, found by its timestamp, not only the most
 * recent. Safe after later renames touched the same files: a file that is
 * not where the entry expects it, or is no longer the file the entry
 * recorded, is left in place and reported (`kept`), never guessed at.
 * Entries from older versions carry no fingerprints; their files are left
 * alone when a more recent entry touched the same path.
 * @throws HistoryChangedError when no entry has that timestamp (it was
 *   undone or dropped since it was listed).
 */
export async function undoHistoryEntry(
  config: ConfigService,
  timestamp: string,
  options: Omit<UndoOptions, "expectedTimestamp" | "touchedLater"> = {},
): Promise<UndoResult> {
  const history = await config.loadHistory();
  const index = history.findIndex((e) => e.timestamp === timestamp);
  if (index < 0) {
    throw new HistoryChangedError(
      "That rename is no longer in the history (it was undone, or dropped as older entries were added). Review the history and try again.",
    );
  }
  const entry = history[index]!;
  if (entry.operations.length === 0) return { ...NO_HISTORY };
  const touchedLater = new Set(history.slice(0, index).flatMap(entryPaths).map(historyPathKey));
  return undoEntry(config, entry, { ...options, touchedLater });
}

/** A history entry as front ends list it. */
export interface HistoryEntrySummary {
  /** Identifies the entry for `undoHistoryEntry`. */
  timestamp: string;
  /** 0 is the most recent. */
  position: number;
  /** Main files. */
  operations: number;
  /** Main plus associated files. */
  files: number;
  /** How the files were transferred; "mixed" when the entry has several modes. */
  transfer: TransferMode | "mixed";
  /** The entry's first few renames (main files), for display. */
  samples: { source: string; destination: string }[];
}

/** Summaries of the history, most recent first. */
export async function listHistory(
  config: ConfigService,
  { samples = 3 }: { samples?: number } = {},
): Promise<HistoryEntrySummary[]> {
  const history = await config.loadHistory();
  return history
    .map((entry, position): HistoryEntrySummary => {
      const modes = new Set(entry.operations.map((op) => op.transfer ?? "move"));
      return {
        timestamp: entry.timestamp,
        position,
        operations: entry.operations.length,
        files: entry.operations.reduce((n, op) => n + 1 + op.associatedFiles.length, 0),
        transfer: modes.size > 1 ? "mixed" : ([...modes][0] ?? "move"),
        samples: entry.operations.slice(0, samples).map((op) => ({ source: op.source, destination: op.destination })),
      };
    })
    .filter((e) => e.operations > 0);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionOptions {
  /** Default "auto". */
  provider?: ProviderChoice;
  /** Default "auto". */
  mediaType?: MediaTypeChoice;
  /** Validate without renaming; also disables cover art and history. Default false. */
  dryRun?: boolean;
  /**
   * One output folder for every media type (the CLI's `--output`), instead
   * of the `[output]` folders. Created when missing.
   */
  outputDir?: string;
  /** Default: `[output] transfer_mode`. */
  transferMode?: TransferMode;
  selectionCallback?: SelectionCallback;
  /**
   * Throw MissingApiKeyError (see `checkApiKeys`) when required keys are
   * missing. Default true (Python CLI). Pass false to run with null
   * providers instead (Python GUI).
   */
  requireApiKeys?: boolean;
  /** Config service for history and the default cache directory. */
  config?: ConfigService;
  /**
   * Response cache. Default: an APICache in `config.cacheDir` when a config
   * is given, else none; that cache removes its expired entries in the
   * background at most once a day. Pass false for no cache.
   */
  cache?: ResponseCache | false;
  /** Fetch implementation for providers and cover art. */
  fetch?: FetchFn;
  /** Use these instead of building providers from settings (tests, custom providers). */
  providers?: Partial<Pick<ProviderSet, "movieProvider" | "tvProvider" | "musicProvider">>;
  parser?: FilenameParser;
  musicParser?: MusicParser;
  /** Use this episode order instead of `[tv] episode_order` (CLI `--order`). */
  episodeOrder?: EpisodeOrder;
  /** Use this metadata language instead of `[metadata] language` (CLI `--language`). */
  language?: string;
  /** Override `[write_metadata]` for this run (CLI `--write-tags`, `--write-nfo`). */
  writeMetadata?: Partial<WriteMetadataSettings>;
}

/** Settings with a session's per-run overrides applied. */
export function applySessionOverrides(
  settings: Settings,
  options: Pick<SessionOptions, "episodeOrder" | "language">,
): Settings {
  if (options.episodeOrder === undefined && options.language === undefined) return settings;
  return {
    ...settings,
    tv: { ...settings.tv, ...(options.episodeOrder !== undefined ? { episodeOrder: options.episodeOrder } : {}) },
    metadata: {
      ...settings.metadata,
      ...(options.language !== undefined ? { language: options.language } : {}),
    },
  };
}

export interface PlanOptions {
  /** Put renamed files here instead of next to the originals. */
  destinationDir?: string;
  progressCallback?: ProcessProgressCallback;
  signal?: AbortSignal;
}

/** Everything a front end needs for one rename run, built from settings. */
export class RenameSession {
  readonly settings: Settings;
  readonly config: ConfigService | undefined;
  readonly provider: ProviderChoice;
  readonly mediaType: MediaTypeChoice;
  /** The forced media type for non-music files (undefined: detect per file). */
  readonly forceType: MediaType | undefined;
  readonly dryRun: boolean;
  readonly providers: ProviderSet;
  readonly service: RenameService;
  readonly coverArt: CoverArtDownloader;
  /** Where renamed files go: the `[output]` folders, or `outputDir` for all. */
  readonly output: OutputPlan;
  /** What `execute` writes after renaming: `[write_metadata]` with the session's overrides. */
  readonly writeMetadata: WriteMetadataSettings;

  /** @throws MissingApiKeyError when `requireApiKeys` is on and keys are missing. */
  constructor(settings: Settings, options: SessionOptions = {}) {
    settings = applySessionOverrides(settings, options);
    this.settings = settings;
    this.config = options.config;
    this.provider = options.provider ?? "auto";
    this.mediaType = options.mediaType ?? "auto";
    this.forceType = forceTypeForChoice(this.mediaType);
    this.dryRun = options.dryRun ?? false;
    this.output = outputPlanFromSettings(settings.output, options.outputDir);
    this.writeMetadata = { ...settings.writeMetadata, ...options.writeMetadata };

    if (options.requireApiKeys ?? true) {
      const missing = checkApiKeys(settings, {
        provider: this.provider,
        mediaType: this.mediaType,
      });
      if (missing) throw missing;
    }

    let cache: ResponseCache | undefined;
    if (options.cache) cache = options.cache;
    else if (options.cache === undefined && options.config) {
      const apiCache = new APICache({ cacheDir: options.config.cacheDir });
      // Expired entries are otherwise removed only when read again. At most
      // once a day, in the background; never throws or delays the caller.
      void apiCache.scheduleCleanup();
      cache = apiCache;
    }

    const built = buildProviders(settings, {
      provider: this.provider,
      cache,
      fetch: options.fetch,
    });
    const overrides = options.providers ?? {};
    this.providers = {
      ...built,
      movieProvider: overrides.movieProvider ?? built.movieProvider,
      tvProvider: overrides.tvProvider ?? built.tvProvider,
      musicProvider: overrides.musicProvider ?? built.musicProvider,
    };

    this.service = buildRenameService(settings, {
      providers: this.providers,
      selectionCallback: options.selectionCallback,
      dryRun: this.dryRun,
      transferMode: options.transferMode,
      parser: options.parser,
      musicParser: options.musicParser,
    });
    this.coverArt = buildCoverArtDownloader(settings, { fetch: options.fetch });
  }

  /** The selection callback (may be replaced between runs). */
  get selectionCallback(): SelectionCallback | undefined {
    return this.service.selectionCallback;
  }
  set selectionCallback(callback: SelectionCallback | undefined) {
    this.service.selectionCallback = callback;
  }

  /** The `[cover_art] enabled` setting, the default for "download cover art". */
  get coverArtEnabled(): boolean {
    return this.settings.coverArt.enabled;
  }

  /** The extensions this session's media type scans for. */
  get extensions(): ReadonlySet<string> {
    return extensionsForMediaType(this.forceType);
  }

  /** Collect media files for this session's media type (see `collectMediaFiles`). */
  collectFiles(paths: readonly string[], options: CollectOptions = {}): Promise<string[]> {
    return collectMediaFiles(paths, { mediaType: this.forceType, ...options });
  }

  /** How files get to their new names (may be changed between plan and execute). */
  get transferMode(): TransferMode {
    return this.service.fileRenamer.transferMode;
  }
  set transferMode(mode: TransferMode) {
    this.service.fileRenamer.transferMode = mode;
  }

  /** The output folder for a planned operation, or undefined when it is renamed in place. */
  outputDirFor(operation: RenameOperation): string | undefined {
    return outputDirFor(this.output, outputKindFor(operation.mediaFile.matchedMetadata));
  }

  /**
   * Parse, fetch metadata, and plan operations. Files go to the output
   * folder for their matched kind (see `output`) unless `destinationDir` is
   * given. Hard links that cannot work are marked (`applyTransferChecks`).
   * @throws OutputFolderError when an output folder the plan uses cannot be
   *   used (missing, a file, not writable).
   */
  async plan(paths: readonly string[], options: PlanOptions = {}): Promise<PlannedOperation[]> {
    const operations = await this.service.processFiles(paths, {
      destinationDir: (mediaFile) => outputDirFor(this.output, outputKindFor(mediaFile.matchedMetadata)),
      ...options,
      forceType: this.forceType,
    });
    if (options.destinationDir === undefined) {
      await checkOutputFolders(this.output, operations, { dryRun: true });
    }
    return applyTransferChecks(operations, this.transferMode);
  }

  /**
   * A corrector for operations this session planned (see `PlanCorrector`):
   * search again, choose or clear a match, edit a new name. Pass the
   * `destinationDir` the operations were planned with; without one, files go
   * to the output folder for their matched kind, as in `plan`, so a file
   * whose match changes kind moves to that kind's folder. Hard links that
   * cannot work are marked after every change.
   */
  corrector(
    operations: readonly PlannedOperation[],
    options: { destinationDir?: string } = {},
  ): PlanCorrector {
    return new PlanCorrector(this.service, operations, {
      forceType: this.forceType,
      destinationDir:
        options.destinationDir ??
        ((mediaFile) => outputDirFor(this.output, outputKindFor(mediaFile.matchedMetadata))),
      afterPlan: (planned) => applyTransferChecks(planned, this.transferMode),
    });
  }

  /**
   * Execute planned operations (updated in place). Output folders are
   * checked again first (the override folder is created when missing), so a
   * folder that went away since planning stops the whole batch before any
   * file is touched.
   * @throws OutputFolderError
   */
  async execute<T extends RenameOperation>(
    operations: T[],
    progressCallback?: ProgressCallback,
  ): Promise<T[]> {
    if (!this.dryRun) await checkOutputFolders(this.output, operations);
    applyTransferChecks(operations as unknown as PlannedOperation[], this.transferMode);
    const done = await this.service.executeRename(operations, progressCallback);
    await this.writeMetadataFor(done, { progressCallback });
    return done;
  }

  /**
   * Write tags and NFO files for completed operations (`[write_metadata]`);
   * `execute` calls this. In a dry run (or with `preview`), nothing is
   * written: pending operations report what would be (`metadataWrites`).
   */
  async writeMetadataFor(
    operations: readonly RenameOperation[],
    options: { progressCallback?: ProgressCallback; preview?: boolean } = {},
  ): Promise<void> {
    await writeMetadataForOperations(operations, {
      settings: this.writeMetadata,
      dryRun: this.dryRun || (options.preview ?? false),
      transferMode: this.transferMode,
      overwrite: resolveConflictStrategy(this.settings) === "overwrite",
      ...(options.progressCallback ? { progressCallback: options.progressCallback } : {}),
    });
  }

  /** Download cover art next to completed operations. Returns [] in a dry run. */
  async downloadCoverArt(
    operations: RenameOperation[],
    progressCallback?: ProgressCallback,
  ): Promise<string[]> {
    if (this.dryRun) return [];
    return this.coverArt.downloadForOperations(operations, progressCallback);
  }

  /**
   * Record completed operations for undo. Returns the number recorded (0 in
   * a dry run, or when none completed).
   * @throws ConfigError when the session has no config.
   */
  async saveHistory(operations: readonly RenameOperation[]): Promise<number> {
    if (this.dryRun) return 0;
    return recordHistory(this.requireConfig(), operations);
  }

  /**
   * Undo the most recent history entry (see `undoLastRename`).
   * @throws ConfigError when the session has no config.
   */
  async undoLast(options: UndoOptions = {}): Promise<UndoResult> {
    return undoLastRename(this.requireConfig(), options);
  }

  /**
   * Undo a history entry by its timestamp (see `undoHistoryEntry`).
   * @throws ConfigError when the session has no config.
   */
  async undoEntry(timestamp: string, options: Omit<UndoOptions, "expectedTimestamp" | "touchedLater"> = {}): Promise<UndoResult> {
    return undoHistoryEntry(this.requireConfig(), timestamp, options);
  }

  private requireConfig(): ConfigService {
    if (!this.config) throw new ConfigError("This session has no ConfigService for history");
    return this.config;
  }
}

/**
 * Load settings from `config` and create a session that uses it for
 * history and caching.
 * @throws ConfigError when the config cannot be loaded.
 * @throws MissingApiKeyError when `requireApiKeys` is on and keys are missing.
 */
export async function createSession(
  config: ConfigService,
  options: Omit<SessionOptions, "config"> = {},
): Promise<RenameSession> {
  const settings = await config.getSettings();
  return new RenameSession(settings, { ...options, config });
}
