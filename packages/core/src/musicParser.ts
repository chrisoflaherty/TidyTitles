/**
 * Music file tag parsing with filename fallback.
 *
 * Ported from the original Python app's `core/music_parser.py`. The Python app reads tags with
 * mutagen; this port uses `music-metadata`, which is async, so `parse`
 * returns a Promise. Tags are only read, never written.
 */

import path from "node:path";

import { parseFile } from "music-metadata";

import { createParsedMusicInfo } from "./models";
import type { ParsedMusicInfo } from "./models";

/** A music metadata parser. */
export interface MusicParser {
  /** Parse a music file to extract metadata. */
  parse(filePath: string): Promise<ParsedMusicInfo>;
  /** Check if this parser can read the file format. */
  canRead(filePath: string): boolean;
}

/** Recognized music file extensions (lowercase, with leading dot). */
export const MUSIC_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp3",
  ".flac",
  ".m4a",
  ".ogg",
  ".opus",
  ".wav",
  ".aiff",
  ".wma",
  ".aac",
  ".ape",
]);

/** Check if a file is a music file based on its extension (case-insensitive). */
export function isMusicFile(filePath: string): boolean {
  return MUSIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Build ParsedMusicInfo without keys whose value is undefined. */
function compact(fields: Partial<ParsedMusicInfo>): ParsedMusicInfo {
  const info = createParsedMusicInfo(fields) as unknown as Record<string, unknown>;
  for (const key of Object.keys(info)) {
    if (info[key] === undefined) delete info[key];
  }
  return info as unknown as ParsedMusicInfo;
}

/** Python's `int()` on a short string, or undefined when it would raise. */
function toInt(text: string): number | undefined {
  return /^\s*[+-]?\d+\s*$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

/** Use the first value of a tag, as the Python `_get_tag` did; "" is absent. */
function tag(value: string | readonly string[] | undefined | null): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first ? String(first) : undefined;
}

/** Music tag parser backed by `music-metadata` (Python: `MutagenParser`). */
export class MusicMetadataParser implements MusicParser {
  canRead(filePath: string): boolean {
    return isMusicFile(filePath);
  }

  /** Parse tags from a music file, falling back to the filename. */
  async parse(filePath: string): Promise<ParsedMusicInfo> {
    try {
      const metadata = await parseFile(filePath, { skipCovers: true });
      const common = metadata.common;

      const title = tag(common.title);
      const artist = tag(common.artists) ?? tag(common.artist);

      // If no useful tags, fall back to filename
      if (!title && !artist) {
        return this.parseFromFilename(filePath);
      }

      const duration = metadata.format.duration;

      return compact({
        title,
        artist,
        album: tag(common.album),
        albumArtist: tag(common.albumartist),
        year: this.parseYear(common.date) ?? (common.year || undefined),
        trackNumber: common.track.no ?? undefined,
        discNumber: common.disk.no ?? undefined,
        totalTracks: common.track.of ?? undefined,
        totalDiscs: common.disk.of ?? undefined,
        genre: tag(common.genre),
        durationMs: duration != null && Number.isFinite(duration) ? Math.trunc(duration * 1000) : undefined,
        rawFilename: path.basename(filePath),
        source: "tags",
      });
    } catch {
      return this.parseFromFilename(filePath);
    }
  }

  /** Extract the year from a date string such as "2023" or "2023-01-15". */
  private parseYear(date: string | undefined): number | undefined {
    if (!date) return undefined;
    return toInt(date.slice(0, 4));
  }

  private parseFromFilename(filePath: string): ParsedMusicInfo {
    return new MusicFilenameParser().parseSync(filePath);
  }
}

/** Fallback parser for filename-based extraction. */
export class MusicFilenameParser implements MusicParser {
  /** Common patterns for music filenames, tried in order. */
  static readonly PATTERNS: readonly RegExp[] = [
    // "Artist - Album - 01 - Title"
    /^(?<artist>.+?)\s*-\s*(?<album>.+?)\s*-\s*(?<track>\d+)\s*-\s*(?<title>.+)$/,
    // "01 - Artist - Title"
    /^(?<track>\d+)\s*-\s*(?<artist>.+?)\s*-\s*(?<title>.+)$/,
    // "Artist - Title"
    /^(?<artist>.+?)\s*-\s*(?<title>.+)$/,
    // "01. Title"
    /^(?<track>\d+)\.\s*(?<title>.+)$/,
    // "01 Title"
    /^(?<track>\d+)\s+(?<title>.+)$/,
  ];

  canRead(filePath: string): boolean {
    return isMusicFile(filePath);
  }

  /** Parse metadata from the filename. Never touches the file itself. */
  async parse(filePath: string): Promise<ParsedMusicInfo> {
    return this.parseSync(filePath);
  }

  /** Synchronous form of `parse` (the Python method was synchronous). */
  parseSync(filePath: string): ParsedMusicInfo {
    const name = path.basename(filePath);
    const stem = path.basename(filePath, path.extname(filePath));

    for (const pattern of MusicFilenameParser.PATTERNS) {
      const groups = pattern.exec(stem)?.groups;
      if (groups) {
        return compact({
          title: (groups.title ?? "").trim(),
          artist: (groups.artist ?? "").trim() || undefined,
          album: (groups.album ?? "").trim() || undefined,
          trackNumber: groups.track ? Number.parseInt(groups.track, 10) : undefined,
          rawFilename: name,
          source: "filename",
        });
      }
    }

    // No pattern matched, use whole stem as title
    return compact({ title: stem, rawFilename: name, source: "filename" });
  }
}

/**
 * Create a music parser instance.
 *
 * @param readTags If true (default), read file tags with music-metadata and
 *   fall back to the filename. If false, use only the filename.
 *   (Python: `use_mutagen`.)
 */
export function createMusicParser(readTags = true): MusicParser {
  return readTags ? new MusicMetadataParser() : new MusicFilenameParser();
}
