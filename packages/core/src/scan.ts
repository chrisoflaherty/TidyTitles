/**
 * Finding media files on disk.
 *
 * One implementation of the scanning that the Python `RenameService`, CLI,
 * and GUI each did with `Path.glob` / `Path.rglob`.
 */

import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { MediaType } from "./models";
import { MUSIC_EXTENSIONS } from "./musicParser";

/** Recognized video file extensions (lowercase, with leading dot). */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
]);

/** All recognized media extensions (video and music). */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...VIDEO_EXTENSIONS,
  ...MUSIC_EXTENSIONS,
]);

/** Check if a file is a video file based on its extension (case-insensitive). */
export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Check if a file is a video or music file based on its extension (case-insensitive). */
export function isMediaFile(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * The extensions to scan for a media type: music extensions for "music",
 * video extensions for "movie" and "tv_episode", and both otherwise.
 */
export function extensionsForMediaType(mediaType?: MediaType): ReadonlySet<string> {
  if (mediaType === "music") return MUSIC_EXTENSIONS;
  if (mediaType === "movie" || mediaType === "tv_episode") return VIDEO_EXTENSIONS;
  return MEDIA_EXTENSIONS;
}

export interface ScanOptions {
  /** Scan subdirectories too. Default false. */
  recursive?: boolean;
  /** Only scan for this media type's extensions. Default: all media. */
  mediaType?: MediaType;
  /**
   * Extensions to match (lowercase, with leading dot). Overrides
   * `mediaType` when given.
   */
  extensions?: ReadonlySet<string>;
}

/** Python's `sorted(paths)` on strings: plain code-unit order, no locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function walk(
  dir: string,
  extensions: ReadonlySet<string>,
  recursive: boolean,
  out: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Hidden files and folders, including macOS "._name" AppleDouble files
    // that appear on non-HFS volumes, are never media.
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (recursive) await walk(full, extensions, recursive, out);
      continue;
    }

    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Follow links to files; do not descend into linked directories
      // (Path.rglob does not either).
      isFile = await stat(full).then(
        (s) => s.isFile(),
        () => false,
      );
    }
    if (isFile && extensions.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/**
 * Scan a directory for media files.
 *
 * Extensions match case-insensitively; hidden entries are skipped. The
 * result is sorted by full path.
 */
export async function scanDirectory(
  directory: string,
  options: ScanOptions = {},
): Promise<string[]> {
  const extensions = options.extensions ?? extensionsForMediaType(options.mediaType);
  const files: string[] = [];
  await walk(path.resolve(directory), extensions, options.recursive ?? false, files);
  return files.sort(compareCodeUnits);
}

export interface CollectOptions extends ScanOptions {
  /**
   * Also apply the extension filter to paths that name files directly.
   * Default false: a file the user named is always included (as the Python
   * CLI does). Set it for drag-and-drop, as the Python GUI does.
   */
  filterExplicitFiles?: boolean;
}

/**
 * Collect media files from a mix of file and directory paths: files are
 * taken as they are, directories are scanned. Paths that do not exist are
 * ignored. Duplicates (by real path) are removed and the result is sorted
 * by full path. All returned paths are absolute.
 */
export async function collectMediaFiles(
  paths: readonly string[],
  options: CollectOptions = {},
): Promise<string[]> {
  const extensions = options.extensions ?? extensionsForMediaType(options.mediaType);
  const seen = new Set<string>();
  const files: string[] = [];

  const add = (file: string) => {
    let key = file;
    try {
      key = realpathSync(file);
    } catch {
      // Keep the path as given.
    }
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  for (const input of paths) {
    const resolved = path.resolve(input);
    const info = await stat(resolved).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      for (const file of await scanDirectory(resolved, { ...options, extensions })) add(file);
    } else if (info.isFile()) {
      if (
        options.filterExplicitFiles &&
        !extensions.has(path.extname(resolved).toLowerCase())
      ) {
        continue;
      }
      add(resolved);
    }
  }

  return files.sort(compareCodeUnits);
}
