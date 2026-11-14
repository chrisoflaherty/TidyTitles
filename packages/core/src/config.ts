/**
 * Configuration management service.
 *
 * Port of `file_renamer/services/config_service.py`. Reads and writes the same
 * `config.toml` and `history.json`, in the same directory, as the Python app,
 * so users can switch between the two.
 *
 * ## config.toml (snake_case on disk)
 *
 * ```toml
 * # File Renamer Configuration
 *
 * [templates]
 * movie = "{title} ({year})"
 * tv = "{title} - S{season2}E{episode2} - {episode_title}"
 * music = "{artist}/{album} ({year})/{track2} - {title}"
 *
 * [api]
 * tmdb_api_key = ""
 * tvdb_api_key = ""
 * tvdb_pin = ""
 *
 * [associated_files]
 * enabled = true
 * subtitles = true
 * nfo = true
 * images = true
 *
 * [cover_art]
 * enabled = false
 * filename = "poster.jpg"
 * music_filename = "cover.jpg"
 * overwrite = false
 * size = "w500"
 *
 * [behavior]
 * dry_run = false
 * overwrite = false
 * preview_before_rename = true
 * conflict_resolution = "skip"
 *
 * [providers]
 * movie = "tmdb"
 * tv = "tvdb"
 * music = "musicbrainz"
 * ```
 *
 * Every key is optional when reading; missing keys take the defaults above.
 * Unknown sections and keys are ignored on load and, as in the Python, are not
 * preserved: `save()` rewrites the whole file in exactly this layout.
 *
 * ## history.json
 *
 * A JSON array of entries, most recent first, at most 10:
 *
 * ```json
 * [
 *   {
 *     "timestamp": "2026-11-14T19:05:42.123000",
 *     "operations": [
 *       {
 *         "source": "/abs/old/name.mkv",
 *         "destination": "/abs/new/Name (2024).mkv",
 *         "associated_files": [
 *           { "source": "/abs/old/name.en.srt", "destination": "/abs/new/Name (2024).en.srt" }
 *         ]
 *       }
 *     ]
 *   }
 * ]
 * ```
 *
 * - `timestamp` is Python's `datetime.now().isoformat()`: local time, no UTC
 *   offset, microseconds when non-zero ("YYYY-MM-DDTHH:MM:SS[.ffffff]").
 * - Paths are absolute strings as produced by `str(Path)`.
 * - Only completed operations are recorded, and no status is stored: every
 *   recorded operation is one that was renamed.
 * - `associated_files` may be missing in hand-edited files; it reads as [].
 * - The file is written with 2-space indentation and non-ASCII characters
 *   escaped as \uXXXX (Python's `json.dump(..., indent=2)`), so it is pure
 *   ASCII and reads back correctly in Python regardless of the locale encoding.
 * - Unknown keys in existing entries are preserved when the file is rewritten.
 *
 * ## Environment variables (pydantic-settings)
 *
 * `FILE_RENAMER_<FIELD>` and `FILE_RENAMER_<SECTION>__<KEY>`, matched without
 * regard to case, using the in-memory Python field names:
 * `FILE_RENAMER_DRY_RUN`, `FILE_RENAMER_CONFLICT_RESOLUTION`,
 * `FILE_RENAMER_MOVIE_PROVIDER`, `FILE_RENAMER_API__TMDB_API_KEY`,
 * `FILE_RENAMER_COVER_ART__SIZE`, and so on. A whole section can also be given
 * as JSON: `FILE_RENAMER_API='{"tmdb_api_key": "..."}'` (nested variables win
 * over the JSON). As in the Python, where file values are passed to the
 * pydantic model as init arguments, a value present in config.toml takes
 * precedence over the environment; the environment fills in only what the
 * file does not set.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { ConfigError } from "./errors";
import type { RenameOperation } from "./models";

export const APP_NAME = "file-renamer";
export const ENV_PREFIX = "FILE_RENAMER_";
export const ENV_NESTED_DELIMITER = "__";
/** Number of history entries kept. */
export const MAX_HISTORY_ENTRIES = 10;
/** How long `saveHistory` and friends wait for another process's history lock. */
export const HISTORY_LOCK_TIMEOUT_MS = 10_000;
/** A history lock file older than this was left behind by a crashed process. */
export const HISTORY_LOCK_STALE_MS = 30_000;

// ---------------------------------------------------------------------------
// Settings (camelCase, in memory)
// ---------------------------------------------------------------------------

export interface TemplateSettings {
  movie: string;
  tv: string;
  music: string;
}

export interface APISettings {
  tmdbApiKey: string;
  tvdbApiKey: string;
  tvdbPin: string;
}

export interface AssociatedFilesSettings {
  enabled: boolean;
  subtitles: boolean;
  nfo: boolean;
  images: boolean;
}

export interface CoverArtSettings {
  enabled: boolean;
  filename: string;
  musicFilename: string;
  overwrite: boolean;
  /** TMDB poster size: w92, w154, w185, w342, w500, w780, original. */
  size: string;
}

export interface Settings {
  templates: TemplateSettings;
  api: APISettings;
  associatedFiles: AssociatedFilesSettings;
  coverArt: CoverArtSettings;
  dryRun: boolean;
  overwrite: boolean;
  previewBeforeRename: boolean;
  /** "skip", "overwrite", or "auto_version" (not validated, as in the Python). */
  conflictResolution: string;
  movieProvider: string;
  tvProvider: string;
  musicProvider: string;
}

// ---------------------------------------------------------------------------
// Validation schema (snake_case, mirrors the pydantic models)
// ---------------------------------------------------------------------------

const TRUE_STRINGS = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_STRINGS = new Set(["0", "off", "f", "false", "n", "no"]);

/** Pydantic's lax bool parsing: accepts 0/1 and common true/false strings. */
function coerceBool(value: unknown): unknown {
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(s)) return true;
    if (FALSE_STRINGS.has(s)) return false;
  }
  return value;
}

const bool = (def: boolean) => z.preprocess(coerceBool, z.boolean()).default(def);
const str = (def: string) => z.string().default(def);

const templateSchema = z.object({
  movie: str("{title} ({year})"),
  tv: str("{title} - S{season2}E{episode2} - {episode_title}"),
  music: str("{artist}/{album} ({year})/{track2} - {title}"),
});

const apiSchema = z.object({
  tmdb_api_key: str(""),
  tvdb_api_key: str(""),
  tvdb_pin: str(""),
});

const associatedFilesSchema = z.object({
  enabled: bool(true),
  subtitles: bool(true),
  nfo: bool(true),
  images: bool(true),
});

const coverArtSchema = z.object({
  enabled: bool(false),
  filename: str("poster.jpg"),
  music_filename: str("cover.jpg"),
  overwrite: bool(false),
  size: str("w500"),
});

const settingsSchema = z.object({
  templates: templateSchema.prefault({}),
  api: apiSchema.prefault({}),
  associated_files: associatedFilesSchema.prefault({}),
  cover_art: coverArtSchema.prefault({}),
  dry_run: bool(false),
  overwrite: bool(false),
  preview_before_rename: bool(true),
  conflict_resolution: str("skip"),
  movie_provider: str("tmdb"),
  tv_provider: str("tvdb"),
  music_provider: str("musicbrainz"),
});

type RawSettings = z.output<typeof settingsSchema>;

/** Nested (model) fields, which accept JSON and `__` variables from the environment. */
const NESTED_FIELDS = new Set(["templates", "api", "associated_files", "cover_art"]);
const SCALAR_FIELDS = new Set([
  "dry_run",
  "overwrite",
  "preview_before_rename",
  "conflict_resolution",
  "movie_provider",
  "tv_provider",
  "music_provider",
]);

/** Where each flattened field lives in config.toml, for error messages. */
const TOML_LOCATION: Record<string, string> = {
  dry_run: "behavior.dry_run",
  overwrite: "behavior.overwrite",
  preview_before_rename: "behavior.preview_before_rename",
  conflict_resolution: "behavior.conflict_resolution",
  movie_provider: "providers.movie",
  tv_provider: "providers.tv",
  music_provider: "providers.music",
};

function fromRaw(raw: RawSettings): Settings {
  return {
    templates: { ...raw.templates },
    api: {
      tmdbApiKey: raw.api.tmdb_api_key,
      tvdbApiKey: raw.api.tvdb_api_key,
      tvdbPin: raw.api.tvdb_pin,
    },
    associatedFiles: { ...raw.associated_files },
    coverArt: {
      enabled: raw.cover_art.enabled,
      filename: raw.cover_art.filename,
      musicFilename: raw.cover_art.music_filename,
      overwrite: raw.cover_art.overwrite,
      size: raw.cover_art.size,
    },
    dryRun: raw.dry_run,
    overwrite: raw.overwrite,
    previewBeforeRename: raw.preview_before_rename,
    conflictResolution: raw.conflict_resolution,
    movieProvider: raw.movie_provider,
    tvProvider: raw.tv_provider,
    musicProvider: raw.music_provider,
  };
}

/** Default settings, ignoring config files and the environment. */
export function createDefaultSettings(): Settings {
  return fromRaw(settingsSchema.parse({}));
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge where `override` wins (pydantic-settings `deep_update`). */
function deepMerge(base: Dict, override: Dict): Dict {
  const out: Dict = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isDict(existing) && isDict(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Map the config.toml structure onto the flat settings fields (Python `load`). */
function configDataFromToml(rawConfig: Dict): Dict {
  const data: Dict = {};
  for (const section of ["templates", "api", "associated_files", "cover_art"]) {
    if (section in rawConfig) data[section] = rawConfig[section];
  }
  const behavior = rawConfig.behavior;
  if (behavior !== undefined) {
    if (!isDict(behavior)) throw new ConfigError("[behavior] must be a table");
    for (const key of [
      "dry_run",
      "overwrite",
      "preview_before_rename",
      "conflict_resolution",
    ]) {
      if (key in behavior) data[key] = behavior[key];
    }
  }
  const providers = rawConfig.providers;
  if (providers !== undefined) {
    if (!isDict(providers)) throw new ConfigError("[providers] must be a table");
    if ("movie" in providers) data.movie_provider = providers.movie;
    if ("tv" in providers) data.tv_provider = providers.tv;
    if ("music" in providers) data.music_provider = providers.music;
  }
  return data;
}

/** Collect settings from FILE_RENAMER_* environment variables. */
function envData(env: Record<string, string | undefined>): Dict {
  const json: Dict = {};
  const nested: Dict = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!name.toUpperCase().startsWith(ENV_PREFIX)) continue;
    const parts = name.slice(ENV_PREFIX.length).toLowerCase().split(ENV_NESTED_DELIMITER);
    const field = parts[0] ?? "";

    if (parts.length === 1) {
      if (SCALAR_FIELDS.has(field)) {
        json[field] = value;
      } else if (NESTED_FIELDS.has(field)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch (error) {
          throw new ConfigError(
            `Environment variable ${name} must be a JSON object: ${(error as Error).message}`,
          );
        }
        if (!isDict(parsed)) {
          throw new ConfigError(`Environment variable ${name} must be a JSON object`);
        }
        json[field] = parsed;
      }
    } else if (parts.length === 2 && NESTED_FIELDS.has(field) && parts[1]) {
      const section = (nested[field] as Dict | undefined) ?? {};
      section[parts[1]] = value;
      nested[field] = section;
    }
  }
  return deepMerge(json, nested);
}

function validate(data: Dict, source: string): Settings {
  const result = settingsSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const key = issue.path.map(String).join(".");
        const where = TOML_LOCATION[key] ?? key;
        return `${where || "(root)"}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigError(`Invalid configuration (${source}): ${details}`);
  }
  return fromRaw(result.data);
}

/**
 * Build settings the way the Python `Settings(**config_data)` does: defaults,
 * then environment variables, then values from config.toml on top.
 *
 * @param tomlText Contents of config.toml, or undefined when there is none.
 */
export function parseSettings(
  tomlText: string | undefined,
  env: Record<string, string | undefined> = {},
  sourceName = "config.toml",
): Settings {
  let configData: Dict = {};
  if (tomlText !== undefined) {
    let rawConfig: Dict;
    try {
      rawConfig = parseToml(tomlText) as Dict;
    } catch (error) {
      throw new ConfigError(
        `Could not parse ${sourceName}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    configData = configDataFromToml(rawConfig);
  }
  return validate(
    deepMerge(envData(env), configData),
    `${sourceName} and ${ENV_PREFIX}* environment variables`,
  );
}

/** Quote a TOML basic string. Plain values come out exactly as the Python writes them. */
function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\n":
        return "\\n";
      case "\t":
        return "\\t";
      case "\r":
        return "\\r";
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
  return `"${escaped}"`;
}

/** Serialize settings to config.toml, in the Python layout (snake_case keys). */
export function settingsToToml(settings: Settings): string {
  const s = settings;
  const lines = [
    "# File Renamer Configuration",
    "",
    "[templates]",
    `movie = ${tomlString(s.templates.movie)}`,
    `tv = ${tomlString(s.templates.tv)}`,
    `music = ${tomlString(s.templates.music)}`,
    "",
    "[api]",
    `tmdb_api_key = ${tomlString(s.api.tmdbApiKey)}`,
    `tvdb_api_key = ${tomlString(s.api.tvdbApiKey)}`,
    `tvdb_pin = ${tomlString(s.api.tvdbPin)}`,
    "",
    "[associated_files]",
    `enabled = ${s.associatedFiles.enabled}`,
    `subtitles = ${s.associatedFiles.subtitles}`,
    `nfo = ${s.associatedFiles.nfo}`,
    `images = ${s.associatedFiles.images}`,
    "",
    "[cover_art]",
    `enabled = ${s.coverArt.enabled}`,
    `filename = ${tomlString(s.coverArt.filename)}`,
    `music_filename = ${tomlString(s.coverArt.musicFilename)}`,
    `overwrite = ${s.coverArt.overwrite}`,
    `size = ${tomlString(s.coverArt.size)}`,
    "",
    "[behavior]",
    `dry_run = ${s.dryRun}`,
    `overwrite = ${s.overwrite}`,
    `preview_before_rename = ${s.previewBeforeRename}`,
    `conflict_resolution = ${tomlString(s.conflictResolution)}`,
    "",
    "[providers]",
    `movie = ${tomlString(s.movieProvider)}`,
    `tv = ${tomlString(s.tvProvider)}`,
    `music = ${tomlString(s.musicProvider)}`,
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Directory resolution (replicates platformdirs for appname "file-renamer",
// appauthor unset, no version, roaming off)
// ---------------------------------------------------------------------------

export interface PlatformContext {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir()`. */
  homedir?: string;
}

function contextDefaults(ctx: PlatformContext) {
  return {
    platform: ctx.platform ?? process.platform,
    env: ctx.env ?? process.env,
    homedir: ctx.homedir ?? os.homedir(),
  };
}

/** %LOCALAPPDATA% (platformdirs asks the shell for the same known folder). */
function windowsLocalAppData(env: Record<string, string | undefined>, homedir: string) {
  const value = env.LOCALAPPDATA;
  return path.win32.normalize(
    value ? value : path.win32.join(homedir, "AppData", "Local"),
  );
}

/** XDG base directory: the variable if not blank, else ~/<fallback>. */
function xdgDir(
  env: Record<string, string | undefined>,
  variable: string,
  homedir: string,
  fallback: string,
): string {
  const value = env[variable] ?? "";
  return value.trim() ? value : path.posix.join(homedir, fallback);
}

/**
 * The user config directory, as `platformdirs.user_config_dir("file-renamer")`:
 * - macOS: ~/Library/Application Support/file-renamer
 * - Windows: %LOCALAPPDATA%\file-renamer\file-renamer
 * - Linux and other Unix: $XDG_CONFIG_HOME/file-renamer, or ~/.config/file-renamer
 */
export function resolveConfigDir(ctx: PlatformContext = {}): string {
  const { platform, env, homedir } = contextDefaults(ctx);
  if (platform === "win32") {
    return path.win32.join(windowsLocalAppData(env, homedir), APP_NAME, APP_NAME);
  }
  if (platform === "darwin") {
    return path.posix.join(homedir, "Library", "Application Support", APP_NAME);
  }
  return path.posix.join(xdgDir(env, "XDG_CONFIG_HOME", homedir, ".config"), APP_NAME);
}

/**
 * The user cache directory, as `platformdirs.user_cache_dir("file-renamer")`:
 * - macOS: ~/Library/Caches/file-renamer
 * - Windows: %LOCALAPPDATA%\file-renamer\file-renamer\Cache
 * - Linux and other Unix: $XDG_CACHE_HOME/file-renamer, or ~/.cache/file-renamer
 */
export function resolveCacheDir(ctx: PlatformContext = {}): string {
  const { platform, env, homedir } = contextDefaults(ctx);
  if (platform === "win32") {
    return path.win32.join(windowsLocalAppData(env, homedir), APP_NAME, APP_NAME, "Cache");
  }
  if (platform === "darwin") {
    return path.posix.join(homedir, "Library", "Caches", APP_NAME);
  }
  return path.posix.join(xdgDir(env, "XDG_CACHE_HOME", homedir, ".cache"), APP_NAME);
}

// ---------------------------------------------------------------------------
// History (camelCase in memory, snake_case on disk)
// ---------------------------------------------------------------------------

export interface HistoryAssociatedFile {
  source: string;
  destination: string;
}

/** One renamed file in a history entry. */
export interface HistoryOperation {
  source: string;
  destination: string;
  associatedFiles: HistoryAssociatedFile[];
}

/** One batch of renames, most recent first in the history. */
export interface HistoryEntry {
  /** Local time, Python isoformat ("2026-11-14T19:05:42.123000"). */
  timestamp: string;
  operations: HistoryOperation[];
}

/** Build the history record for a completed operation (as the Python CLI does). */
export function toHistoryOperation(op: RenameOperation): HistoryOperation {
  return {
    source: op.source,
    destination: op.destination,
    associatedFiles: op.associatedFiles.map((a) => ({
      source: a.source,
      destination: a.destination,
    })),
  };
}

function operationFromDisk(raw: unknown): HistoryOperation {
  const r = isDict(raw) ? raw : {};
  const assoc = Array.isArray(r.associated_files) ? r.associated_files : [];
  return {
    source: String(r.source ?? ""),
    destination: String(r.destination ?? ""),
    associatedFiles: assoc.map((a) => {
      const d = isDict(a) ? a : {};
      return { source: String(d.source ?? ""), destination: String(d.destination ?? "") };
    }),
  };
}

function operationToDisk(op: HistoryOperation): Dict {
  return {
    source: op.source,
    destination: op.destination,
    associated_files: op.associatedFiles.map((a) => ({
      source: a.source,
      destination: a.destination,
    })),
  };
}

function entryFromDisk(raw: unknown): HistoryEntry {
  const r = isDict(raw) ? raw : {};
  return {
    timestamp: String(r.timestamp ?? ""),
    operations: Array.isArray(r.operations) ? r.operations.map(operationFromDisk) : [],
  };
}

/** `datetime.now().isoformat()`: local time, no offset, microseconds if non-zero. */
export function pythonIsoTimestamp(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return ms === 0 ? base : `${base}.${p(ms * 1000, 6)}`;
}

/** `json.dumps(value, indent=2)`: 2-space indent, non-ASCII escaped. */
function pythonJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[^\x00-\x7f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// ---------------------------------------------------------------------------
// ConfigService
// ---------------------------------------------------------------------------

export interface ConfigServiceOptions extends PlatformContext {
  /** Full path to a config file (Python `config_path`); its directory becomes the config dir. */
  configPath?: string;
  /** Config directory; config.toml and history.json live here. */
  configDir?: string;
  /** Cache directory (created on save, as in the Python). */
  cacheDir?: string;
}

/** Service for managing application configuration and rename history. */
export class ConfigService {
  static readonly APP_NAME = APP_NAME;

  readonly configDir: string;
  readonly configFile: string;
  readonly cacheDir: string;
  private readonly env: Record<string, string | undefined>;
  private _settings: Settings | undefined;

  constructor(options: ConfigServiceOptions = {}) {
    if (options.configPath) {
      this.configFile = options.configPath;
      this.configDir = path.dirname(options.configPath);
    } else {
      this.configDir = options.configDir ?? resolveConfigDir(options);
      this.configFile = path.join(this.configDir, "config.toml");
    }
    this.cacheDir = options.cacheDir ?? resolveCacheDir(options);
    this.env = options.env ?? process.env;
  }

  /** Path to the rename history file. */
  get historyFile(): string {
    return path.join(this.configDir, "history.json");
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await mkdir(this.cacheDir, { recursive: true });
  }

  /**
   * Load settings from the config file and environment.
   * @throws ConfigError when the file cannot be read or parsed, or a value is invalid.
   */
  async load(): Promise<Settings> {
    let text: string | undefined;
    if (existsSync(this.configFile)) {
      try {
        text = await readFile(this.configFile, "utf8");
      } catch (error) {
        throw new ConfigError(
          `Could not read ${this.configFile}: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    this._settings = parseSettings(text, this.env, this.configFile);
    return this._settings;
  }

  /** True once settings have been loaded (or saved). */
  get isLoaded(): boolean {
    return this._settings !== undefined;
  }

  /**
   * Current settings. The Python property loads lazily; since loading is async
   * here, call `load()` or `getSettings()` first.
   * @throws ConfigError when settings have not been loaded yet.
   */
  get settings(): Settings {
    if (!this._settings) {
      throw new ConfigError("Settings have not been loaded; call load() first");
    }
    return this._settings;
  }

  /** Current settings, loading them if necessary. */
  async getSettings(): Promise<Settings> {
    return this._settings ?? (await this.load());
  }

  /**
   * Save settings to the config file. Uses the current settings when none are
   * given, or defaults (plus environment) when nothing has been loaded.
   */
  async save(settings?: Settings): Promise<void> {
    await this.ensureDirs();
    const toSave = settings ?? this._settings ?? parseSettings(undefined, this.env);
    await writeFile(this.configFile, settingsToToml(toSave), "utf8");
    this._settings = toSave;
  }

  /** API key for "tmdb" or "tvdb"; "" for any other provider. */
  async getApiKey(provider: string): Promise<string> {
    const settings = await this.getSettings();
    if (provider === "tmdb") return settings.api.tmdbApiKey;
    if (provider === "tvdb") return settings.api.tvdbApiKey;
    return "";
  }

  /** Set the API key for "tmdb" or "tvdb" and save (other providers are ignored, but settings are still saved). */
  async setApiKey(provider: string, key: string): Promise<void> {
    const settings = await this.getSettings();
    if (provider === "tmdb") settings.api.tmdbApiKey = key;
    else if (provider === "tvdb") settings.api.tvdbApiKey = key;
    await this.save(settings);
  }

  /** The raw on-disk history array; [] when missing or unreadable. */
  private async readRawHistory(): Promise<unknown[]> {
    if (!existsSync(this.historyFile)) return [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.historyFile, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Write the history atomically (temporary file, then rename), so a crash
   * mid-write never leaves a truncated file that the next save would treat
   * as empty and replace.
   */
  private async writeRawHistory(history: unknown[]): Promise<void> {
    const temp = `${this.historyFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, pythonJson(history), "utf8");
      await rename(temp, this.historyFile);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Run a read-modify-write of the history while holding a lock file, so the
   * CLI and the desktop app (or two of either) never overwrite each other's
   * entries. A lock older than HISTORY_LOCK_STALE_MS is treated as left
   * behind by a crashed process.
   * @throws ConfigError when the lock cannot be taken within HISTORY_LOCK_TIMEOUT_MS.
   */
  private async withHistoryLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.configDir, { recursive: true });
    const lockFile = `${this.historyFile}.lock`;
    const deadline = Date.now() + HISTORY_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(lockFile, "wx");
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockFile).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > HISTORY_LOCK_STALE_MS) {
          await unlink(lockFile).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) {
          throw new ConfigError(
            `The rename history is in use by another TidyTitles process (lock file ${lockFile})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(lockFile).catch(() => undefined);
    }
  }

  /**
   * Record a batch of renames for undo. The entry goes first; only the most
   * recent 10 entries are kept.
   */
  async saveHistory(operations: HistoryOperation[]): Promise<void> {
    await this.ensureDirs();
    await this.withHistoryLock(async () => {
      const history = await this.readRawHistory();
      history.unshift({
        timestamp: pythonIsoTimestamp(),
        operations: operations.map(operationToDisk),
      });
      await this.writeRawHistory(history.slice(0, MAX_HISTORY_ENTRIES));
    });
  }

  /**
   * Replace one history entry, found by its timestamp and operations, with
   * `operations` (keeping its timestamp and position), or remove it when
   * `operations` is empty. Other entries are untouched, even ones another
   * process added since `entry` was read. Returns false when the entry is no
   * longer in the history.
   */
  async replaceHistoryEntry(
    entry: HistoryEntry,
    operations: readonly HistoryOperation[],
  ): Promise<boolean> {
    if (!existsSync(this.historyFile)) return false;
    return this.withHistoryLock(async () => {
      const history = await this.readRawHistory();
      const wanted = JSON.stringify(entry);
      const index = history.findIndex((raw) => JSON.stringify(entryFromDisk(raw)) === wanted);
      if (index < 0) return false;
      if (operations.length === 0) history.splice(index, 1);
      else {
        history[index] = {
          timestamp: entry.timestamp,
          operations: operations.map(operationToDisk),
        };
      }
      await this.writeRawHistory(history);
      return true;
    });
  }

  /** Rename history, most recent first. Returns [] when missing or unreadable. */
  async loadHistory(): Promise<HistoryEntry[]> {
    return (await this.readRawHistory()).map(entryFromDisk);
  }

  /** The most recent batch of renames, for undo ([] when there is none). */
  async getLastOperations(): Promise<HistoryOperation[]> {
    const history = await this.loadHistory();
    return history[0]?.operations ?? [];
  }

  /** Remove the most recent history entry (after a successful undo). */
  async clearLastHistory(): Promise<void> {
    if (!existsSync(this.historyFile)) return;
    await this.withHistoryLock(async () => {
      const history = await this.readRawHistory();
      if (history.length > 0) {
        history.shift();
        await this.writeRawHistory(history);
      }
    });
  }
}
