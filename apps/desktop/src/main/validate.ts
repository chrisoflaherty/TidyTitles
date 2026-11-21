/**
 * Validation of IPC arguments. Everything the renderer sends is untrusted:
 * each handler parses its arguments here and rejects anything malformed.
 */

import path from "node:path";
import { isMetadataLanguageCode, MEDIA_TYPE_CHOICES, PROVIDER_CHOICES, type MatchQuery } from "@tidytitles/core";
import {
  CONFLICT_CHOICES,
  COVER_SIZE_CHOICES,
  EPISODE_ORDER_CHOICES,
  HISTORY_LIMIT_RANGE,
  TRANSFER_MODE_CHOICES,
  TV_PROVIDER_CHOICES,
  type ChooseMatchOptions,
  type EditableSettings,
  type RunOptions,
  type TemplateSet,
} from "../shared/ipc";

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(`Invalid IPC argument: ${message}`);
    this.name = "IpcValidationError";
  }
}

const MAX_PATHS = 10_000;
const MAX_STRING = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, name: string, max = MAX_STRING): string {
  if (typeof value !== "string") throw new IpcValidationError(`${name} must be a string`);
  if (value.length > max) throw new IpcValidationError(`${name} is too long`);
  if (value.includes("\0")) throw new IpcValidationError(`${name} contains a NUL character`);
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new IpcValidationError(`${name} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new IpcValidationError(`${name} must be one of ${choices.join(", ")}`);
  }
  return value as T;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new IpcValidationError(`${name} must be an object`);
  return value;
}

/** Absolute filesystem paths (dropped files and folders). */
export function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new IpcValidationError("paths must be an array");
  if (value.length > MAX_PATHS) throw new IpcValidationError("too many paths");
  return value.map((p, i) => {
    const s = str(p, `paths[${i}]`);
    if (!path.isAbsolute(s)) throw new IpcValidationError(`paths[${i}] must be absolute`);
    return s;
  });
}

export function parseFileIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new IpcValidationError("ids must be an array");
  if (value.length > MAX_PATHS) throw new IpcValidationError("too many ids");
  return value.map((id, i) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
      throw new IpcValidationError(`ids[${i}] must be a non-negative integer`);
    }
    return id;
  });
}

export function parseDialogKind(value: unknown): "files" | "folder" {
  return oneOf(value, ["files", "folder"] as const, "kind");
}

export function parseRunOptions(value: unknown): Partial<RunOptions> {
  const r = record(value, "options");
  const out: Partial<RunOptions> = {};
  for (const key of Object.keys(r)) {
    if (!["mediaType", "provider", "recursive", "coverArt", "transferMode"].includes(key)) {
      throw new IpcValidationError(`unknown option ${key}`);
    }
  }
  if (r.mediaType !== undefined) out.mediaType = oneOf(r.mediaType, MEDIA_TYPE_CHOICES, "mediaType");
  if (r.provider !== undefined) out.provider = oneOf(r.provider, PROVIDER_CHOICES, "provider");
  if (r.recursive !== undefined) out.recursive = bool(r.recursive, "recursive");
  if (r.coverArt !== undefined) out.coverArt = bool(r.coverArt, "coverArt");
  if (r.transferMode !== undefined) out.transferMode = oneOf(r.transferMode, TRANSFER_MODE_CHOICES, "transferMode");
  return out;
}

/** The "Check for updates automatically" toggle. */
export function parseEnabled(value: unknown): boolean {
  return bool(value, "enabled");
}

/** Whether the renderer would accept a drop now (`takeOpenedPaths`). */
export function parseAccept(value: unknown): boolean {
  return bool(value, "accept");
}

export function parseSelectionAnswer(id: unknown, index: unknown): { id: string; index: number | null } {
  const parsedId = str(id, "id", 64);
  if (index === null) return { id: parsedId, index: null };
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new IpcValidationError("index must be a non-negative integer or null");
  }
  return { id: parsedId, index };
}

export function parseTemplates(value: unknown): TemplateSet {
  const r = record(value, "templates");
  return {
    movie: str(r.movie, "templates.movie", 1_000),
    tv: str(r.tv, "templates.tv", 1_000),
    music: str(r.music, "templates.music", 1_000),
  };
}

export function parseEditableSettings(value: unknown): EditableSettings {
  const r = record(value, "settings");
  const api = record(r.api, "api");
  const assoc = record(r.associatedFiles, "associatedFiles");
  const cover = record(r.coverArt, "coverArt");
  const tv = record(r.tv, "tv");
  const metadata = record(r.metadata, "metadata");
  const language = str(metadata.language, "metadata.language", 16);
  if (!isMetadataLanguageCode(language)) {
    throw new IpcValidationError("metadata.language must be a language code such as en-US");
  }
  return {
    templates: parseTemplates(r.templates),
    api: {
      tmdbApiKey: str(api.tmdbApiKey, "api.tmdbApiKey", 512),
      tvdbApiKey: str(api.tvdbApiKey, "api.tvdbApiKey", 512),
      tvdbPin: str(api.tvdbPin, "api.tvdbPin", 512),
    },
    associatedFiles: {
      enabled: bool(assoc.enabled, "associatedFiles.enabled"),
      subtitles: bool(assoc.subtitles, "associatedFiles.subtitles"),
      nfo: bool(assoc.nfo, "associatedFiles.nfo"),
      images: bool(assoc.images, "associatedFiles.images"),
    },
    coverArt: {
      enabled: bool(cover.enabled, "coverArt.enabled"),
      filename: safeFilename(cover.filename, "coverArt.filename"),
      musicFilename: safeFilename(cover.musicFilename, "coverArt.musicFilename"),
      overwrite: bool(cover.overwrite, "coverArt.overwrite"),
      size: oneOf(cover.size, COVER_SIZE_CHOICES, "coverArt.size"),
    },
    conflictResolution: oneOf(r.conflictResolution, CONFLICT_CHOICES, "conflictResolution"),
    tvProvider: oneOf(r.tvProvider, TV_PROVIDER_CHOICES, "tvProvider"),
    ...parseOutputAndHistory(r),
    tv: { episodeOrder: oneOf(tv.episodeOrder, EPISODE_ORDER_CHOICES, "tv.episodeOrder") },
    metadata: { language },
  };
}

/** `[output]` and `[history]` from the settings dialog. */
function parseOutputAndHistory(r: Record<string, unknown>): Pick<EditableSettings, "output" | "history"> {
  const output = record(r.output, "output");
  const history = record(r.history, "history");
  const max = history.maxEntries;
  if (
    typeof max !== "number" ||
    !Number.isSafeInteger(max) ||
    max < HISTORY_LIMIT_RANGE.min ||
    max > HISTORY_LIMIT_RANGE.max
  ) {
    throw new IpcValidationError(
      `history.maxEntries must be a whole number from ${HISTORY_LIMIT_RANGE.min} to ${HISTORY_LIMIT_RANGE.max}`,
    );
  }
  return {
    output: {
      movie: outputFolder(output.movie, "output.movie"),
      tv: outputFolder(output.tv, "output.tv"),
      music: outputFolder(output.music, "output.music"),
      transferMode: oneOf(output.transferMode, TRANSFER_MODE_CHOICES, "output.transferMode"),
    },
    history: { maxEntries: max },
  };
}

/** An output folder: "" (rename in place) or an absolute path. */
function outputFolder(value: unknown, name: string): string {
  const s = str(value, name).trim();
  if (s !== "" && !path.isAbsolute(s)) throw new IpcValidationError(`${name} must be an absolute path`);
  return s;
}

/** A history entry's timestamp (`undoEntry`). */
export function parseTimestamp(value: unknown): string {
  return str(value, "timestamp", 64);
}

/** The folder a folder picker starts in: an absolute path, or undefined. */
export function parseOptionalFolder(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = str(value, "folder");
  if (!path.isAbsolute(s)) throw new IpcValidationError("folder must be absolute");
  return s;
}

/** A file's id in the list. */
export function parseFileId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new IpcValidationError("fileId must be a non-negative integer");
  }
  return value;
}

const QUERY_KEYS: Record<MatchQuery["mediaType"], readonly string[]> = {
  movie: ["mediaType", "title", "year"],
  tv_episode: ["mediaType", "title", "year", "season", "episode"],
  music: ["mediaType", "title", "artist", "album"],
};

function optionalInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new IpcValidationError(`${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

function optionalStr(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : str(value, name, 500);
}

/** A search for a file's match ("Change Match" dialog). */
export function parseMatchQuery(value: unknown): MatchQuery {
  const r = record(value, "query");
  const mediaType = oneOf(r.mediaType, ["movie", "tv_episode", "music"] as const, "query.mediaType");
  for (const key of Object.keys(r)) {
    if (!QUERY_KEYS[mediaType].includes(key)) throw new IpcValidationError(`unknown query field ${key}`);
  }
  const title = str(r.title, "query.title", 500);
  const year = optionalInt(r.year, "query.year", 9999);
  switch (mediaType) {
    case "movie":
      return { mediaType, title, ...(year !== undefined ? { year } : {}) };
    case "tv_episode": {
      const season = optionalInt(r.season, "query.season", 100_000);
      const episode = optionalInt(r.episode, "query.episode", 100_000);
      return {
        mediaType,
        title,
        ...(year !== undefined ? { year } : {}),
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
      };
    }
    case "music": {
      const artist = optionalStr(r.artist, "query.artist");
      const album = optionalStr(r.album, "query.album");
      return { mediaType, title, ...(artist !== undefined ? { artist } : {}), ...(album !== undefined ? { album } : {}) };
    }
  }
}

export function parseMatchChoice(
  searchId: unknown,
  index: unknown,
  options: unknown,
): { searchId: string; index: number; options: ChooseMatchOptions } {
  const id = str(searchId, "searchId", 64);
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new IpcValidationError("index must be a non-negative integer");
  }
  const r = record(options, "options");
  for (const key of Object.keys(r)) {
    if (!["applyToSimilar", "season", "episode"].includes(key)) throw new IpcValidationError(`unknown option ${key}`);
  }
  const season = optionalInt(r.season, "options.season", 100_000);
  const episode = optionalInt(r.episode, "options.episode", 100_000);
  return {
    searchId: id,
    index,
    options: {
      applyToSimilar: bool(r.applyToSimilar, "options.applyToSimilar"),
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
    },
  };
}

/** A typed new name (checked again by core), or null for the template's name. */
export function parseNewName(value: unknown): string | null {
  return value === null ? null : str(value, "name", 1_024);
}

/** A bare filename: no directory parts (cover art is written next to the media). */
function safeFilename(value: unknown, name: string): string {
  const s = str(value, name, 255).trim();
  if (s.includes("/") || s.includes("\\") || s === "." || s === "..") {
    throw new IpcValidationError(`${name} must be a file name without folders`);
  }
  return s;
}

/** Only https URLs leave the app, and only to the system browser. */
export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
