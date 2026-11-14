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
 *   await session.execute(ops, progressCallback);
 *   if (session.coverArtEnabled) await session.downloadCoverArt(ops);
 *   await session.saveHistory(ops);
 *   // later
 *   await undoLastRename(config);
 *
 * Every builder below is exported on its own, so a front end can assemble
 * a `RenameService` differently when it needs to.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  toHistoryOperation,
  type ConfigService,
  type HistoryOperation,
  type Settings,
} from "./config";
import { isConflictStrategy, type ConflictStrategy } from "./conflictResolution";
import { CoverArtDownloader } from "./coverArt";
import { ConfigError, RenameError } from "./errors";
import type { MediaType, RenameOperation } from "./models";
import type { MusicParser } from "./musicParser";
import type { FilenameParser } from "./parser";
import type { FetchFn, MovieProvider, MusicProvider, TVProvider } from "./providers/base";
import { APICache } from "./providers/cache";
import { MusicBrainzClient } from "./providers/musicbrainz";
import { TMDBClient } from "./providers/tmdb";
import { TVDBClient } from "./providers/tvdb";
import type { ResponseCache } from "./providers/util";
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
    clients.tmdb = new TMDBClient({ apiKey: settings.api.tmdbApiKey.trim(), cache, ...fetchOpt });
  }
  if (wantTvdb) {
    const pin = settings.api.tvdbPin.trim();
    clients.tvdb = new TVDBClient({
      apiKey: settings.api.tvdbApiKey.trim(),
      ...(pin ? { pin } : {}),
      cache,
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
}

/**
 * A FileRenamer for the settings. Overwriting is on exactly when the
 * conflict strategy is "overwrite".
 */
export function buildFileRenamer(
  settings: Settings,
  { dryRun = false }: BuildFileRenamerOptions = {},
): FileRenamer {
  return new FileRenamer({
    dryRun,
    overwrite: resolveConflictStrategy(settings) === "overwrite",
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
    fileRenamer: options.fileRenamer ?? buildFileRenamer(settings, { dryRun: options.dryRun }),
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
 * - "undone": the file (and any associated files found) were moved back
 * - "missing": nothing was found at the renamed paths, so nothing moved
 * - "failed": at least one move failed; see `errors`
 */
export type UndoItemStatus = "undone" | "missing" | "failed";

export interface UndoItemResult {
  operation: HistoryOperation;
  status: UndoItemStatus;
  /** "name: reason" for each move that failed. */
  errors: string[];
}

export interface UndoResult {
  /** False when there was no history to undo (Python CLI: "No rename history found."). */
  historyFound: boolean;
  /** One result per operation, in the order they were undone (last renamed first). */
  items: UndoItemResult[];
  undone: number;
  missing: number;
  failed: number;
}

export interface UndoOptions {
  progressCallback?: ProgressCallback;
  /** Renamer used to move files back. Default: a new FileRenamer (no overwrite). */
  renamer?: FileRenamer;
}

interface UndoItemInternal extends UndoItemResult {
  /** What is still renamed after the attempt (for rewriting history). */
  remaining?: HistoryOperation;
  moved: boolean;
}

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
    const failedAssoc: HistoryOperation["associatedFiles"] = [];
    let moved = false;

    const moveBack = async (from: string, to: string): Promise<boolean> => {
      if (!existsSync(from)) return true;
      try {
        await renamer.rename(from, to);
        moved = true;
        return true;
      } catch (error) {
        if (!(error instanceof RenameError)) throw error;
        errors.push(`${path.basename(from)}: ${error.message}`);
        return false;
      }
    };

    // Associated files first, then the main file (as FileRenamer.undo does).
    for (const assoc of [...op.associatedFiles].reverse()) {
      if (!(await moveBack(assoc.destination, assoc.source))) failedAssoc.unshift(assoc);
    }
    await moveBack(op.destination, op.source);

    const status: UndoItemStatus = errors.length > 0 ? "failed" : moved ? "undone" : "missing";
    const item: UndoItemInternal = { operation: op, status, errors, moved };
    if (status === "failed") {
      item.remaining = { ...op, associatedFiles: failedAssoc };
    }
    results.push(item);
  }
  return results;
}

function toUndoResult(items: UndoItemInternal[]): UndoResult {
  return {
    historyFound: true,
    items: items.map(({ operation, status, errors }) => ({ operation, status, errors })),
    undone: items.filter((i) => i.status === "undone").length,
    missing: items.filter((i) => i.status === "missing").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}

/**
 * Move files from history operations back to their original names, last
 * renamed first. Does not touch the history file.
 */
export async function undoHistoryOperations(
  operations: readonly HistoryOperation[],
  options: UndoOptions = {},
): Promise<UndoResult> {
  return toUndoResult(await undoItems(operations, options));
}

/**
 * Undo the most recent history entry and update the history: the entry is
 * removed when everything was undone; when some moves failed, it is
 * replaced by an entry holding only what is still renamed, so undo can be
 * retried; when nothing could be moved at all, it is left as it was.
 */
export async function undoLastRename(
  config: ConfigService,
  options: UndoOptions = {},
): Promise<UndoResult> {
  const operations = await config.getLastOperations();
  if (operations.length === 0) {
    return { historyFound: false, items: [], undone: 0, missing: 0, failed: 0 };
  }

  const items = await undoItems(operations, options);
  const failed = items.filter((i) => i.status === "failed");
  if (failed.length === 0) {
    await config.clearLastHistory();
  } else if (items.some((i) => i.moved)) {
    await config.clearLastHistory();
    // History is undone last-first; store the remainder in the original order.
    const remaining = failed.map((i) => i.remaining!).reverse();
    await config.saveHistory(remaining);
  }
  return toUndoResult(items);
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
   * is given, else none. Pass false for no cache.
   */
  cache?: ResponseCache | false;
  /** Fetch implementation for providers and cover art. */
  fetch?: FetchFn;
  /** Use these instead of building providers from settings (tests, custom providers). */
  providers?: Partial<Pick<ProviderSet, "movieProvider" | "tvProvider" | "musicProvider">>;
  parser?: FilenameParser;
  musicParser?: MusicParser;
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

  /** @throws MissingApiKeyError when `requireApiKeys` is on and keys are missing. */
  constructor(settings: Settings, options: SessionOptions = {}) {
    this.settings = settings;
    this.config = options.config;
    this.provider = options.provider ?? "auto";
    this.mediaType = options.mediaType ?? "auto";
    this.forceType = forceTypeForChoice(this.mediaType);
    this.dryRun = options.dryRun ?? false;

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
      cache = new APICache({ cacheDir: options.config.cacheDir });
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

  /** Parse, fetch metadata, and plan operations. */
  plan(paths: readonly string[], options: PlanOptions = {}): Promise<PlannedOperation[]> {
    return this.service.processFiles(paths, { ...options, forceType: this.forceType });
  }

  /** Execute planned operations (updated in place). */
  execute<T extends RenameOperation>(
    operations: T[],
    progressCallback?: ProgressCallback,
  ): Promise<T[]> {
    return this.service.executeRename(operations, progressCallback);
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
