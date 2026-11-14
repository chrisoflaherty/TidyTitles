/**
 * Associated file detection and handling.
 *
 * Port of `file_renamer/core/associated_files.py`.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AssociatedFileType } from "./models";

/** Subtitle file extensions (lowercase, with leading dot). */
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".srt",
  ".vtt",
  ".ass",
  ".ssa",
  ".sub",
  ".idx",
]);
/** NFO file extensions. */
export const NFO_EXTENSIONS: ReadonlySet<string> = new Set([".nfo"]);
/** Image file extensions. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tbn",
]);
/** Name fragments that mark sample/trailer files (unused, kept for parity). */
export const SAMPLE_PATTERNS: ReadonlySet<string> = new Set([
  "sample",
  "trailer",
  "preview",
]);

/** A file associated with a media file. */
export interface AssociatedFile {
  path: string;
  fileType: AssociatedFileType;
}

// ---------------------------------------------------------------------------
// Python pathlib semantics for `suffix` and `stem` (Python 3.12 rules), which
// differ from `path.extname` for names such as "foo." and ".hidden".
// ---------------------------------------------------------------------------

/** The final extension of a path, like Python's `PurePath.suffix` (".mkv" or ""). */
export function pathSuffix(filePath: string): string {
  const name = path.basename(filePath);
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i) : "";
}

/** The filename without its final extension, like Python's `PurePath.stem`. */
export function pathStem(filePath: string): string {
  const name = path.basename(filePath);
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}

/** The lowercase file extension of an associated file. */
export function associatedFileExtension(file: AssociatedFile): string {
  return pathSuffix(file.path).toLowerCase();
}

/** The filename of an associated file. */
export function associatedFileName(file: AssociatedFile): string {
  return path.basename(file.path);
}

/** Determine the type of an associated file from its extension. */
export function getFileType(filePath: string): AssociatedFileType {
  const ext = pathSuffix(filePath).toLowerCase();
  if (SUBTITLE_EXTENSIONS.has(ext)) return "subtitle";
  if (NFO_EXTENSIONS.has(ext)) return "nfo";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

export interface ExtensionSettings {
  includeSubtitles?: boolean;
  includeNfo?: boolean;
  includeImages?: boolean;
}

/** Get the file extensions to search for, based on settings (all default to true). */
export function getExtensionsFromSettings({
  includeSubtitles = true,
  includeNfo = true,
  includeImages = true,
}: ExtensionSettings = {}): Set<string> {
  const extensions = new Set<string>();
  if (includeSubtitles) SUBTITLE_EXTENSIONS.forEach((e) => extensions.add(e));
  if (includeNfo) NFO_EXTENSIONS.forEach((e) => extensions.add(e));
  if (includeImages) IMAGE_EXTENSIONS.forEach((e) => extensions.add(e));
  return extensions;
}

/** All default associated-file extensions. */
function defaultExtensions(): Set<string> {
  return getExtensionsFromSettings();
}

/**
 * Find files associated with a media file.
 *
 * Associated files live in the same directory and share the media file's
 * base name with a different extension (movie.mkv and movie.srt), or carry a
 * dotted suffix such as a language code (movie.en.srt).
 *
 * @param mediaPath Path to the media file.
 * @param extensions Extensions to look for (lowercase, with dot). Defaults to
 *   all subtitle, NFO, and image extensions.
 */
export async function findAssociatedFiles(
  mediaPath: string,
  extensions?: ReadonlySet<string>,
): Promise<AssociatedFile[]> {
  const exts = extensions ?? defaultExtensions();
  const media = path.normalize(mediaPath);
  const baseName = pathStem(media);
  const parentDir = path.dirname(media);

  const associated: AssociatedFile[] = [];

  // Files with the same base name. As in the Python, this existence check
  // follows the filesystem's case rules.
  for (const ext of exts) {
    const potential = path.join(parentDir, `${baseName}${ext}`);
    if (potential !== media && existsSync(potential)) {
      associated.push({ path: potential, fileType: getFileType(potential) });
    }
  }

  // Language-specific and other dotted variants (movie.en.srt, movie.es.srt).
  if (existsSync(parentDir)) {
    let names: string[];
    try {
      names = await readdir(parentDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const file = path.join(parentDir, name);
      if (file === media || associated.some((a) => a.path === file)) continue;

      if (pathStem(file).startsWith(`${baseName}.`)) {
        const ext = pathSuffix(file).toLowerCase();
        if (exts.has(ext)) {
          associated.push({ path: file, fileType: getFileType(file) });
        }
      }
    }
  }

  return associated;
}

/**
 * Generate the destination path for an associated file.
 *
 * @param originalPath Original path of the associated file.
 * @param newBaseName New base name (without extension) of the media file.
 * @param originalMediaStem The original media file's stem. When given, the
 *   part of the associated file's stem after it (such as "en") is kept.
 *   Otherwise a trailing alphabetic segment of up to 4 characters is treated
 *   as a language code.
 */
export function generateAssociatedDestination(
  originalPath: string,
  newBaseName: string,
  originalMediaStem?: string,
): string {
  const parent = path.dirname(originalPath);
  const ext = pathSuffix(originalPath);
  const stem = pathStem(originalPath);

  let suffixPart: string | undefined;

  if (originalMediaStem) {
    // "Movie.Name.en" with original stem "Movie.Name" -> suffix "en"
    if (stem.startsWith(`${originalMediaStem}.`)) {
      suffixPart = stem.slice(originalMediaStem.length + 1);
    }
  } else if (stem.includes(".")) {
    // Fallback: a short alphabetic final segment is a language code.
    const potentialLang = stem.slice(stem.lastIndexOf(".") + 1);
    // Equivalent of Python's str.isalpha(): non-empty, all letters.
    if (potentialLang.length <= 4 && /^\p{L}+$/u.test(potentialLang)) {
      suffixPart = potentialLang;
    }
  }

  const newName = suffixPart
    ? `${newBaseName}.${suffixPart}${ext}`
    : `${newBaseName}${ext}`;

  return path.join(parent, newName);
}
