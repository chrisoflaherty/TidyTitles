/**
 * Template engine for generating filenames.
 *
 * Port of `file_renamer/core/template.py`. Behavior matches the Python
 * engine, including Python's `str.title()` and `str.zfill()` semantics.
 */

import { TemplateError } from "./errors";
import type { Episode, Movie, Track } from "./models";
import { hasSections, renderSections, sectionErrors } from "./templateSections";
import { EpisodeNumbers, episodeContext } from "./templateEpisodes";

/** Values substituted into a template; `undefined`/`null` render as "". */
export type TemplateContext = Record<string, unknown>;

/** Result of validating a template string. */
export interface TemplateValidation {
  isValid: boolean;
  errors: string[];
}

/** Templates used by a TemplateEngine. */
export interface TemplateEngineOptions {
  movieTemplate?: string;
  tvTemplate?: string;
  musicTemplate?: string;
}

// ---------------------------------------------------------------------------
// Python string semantics
// ---------------------------------------------------------------------------

/** Python's `str()` for the value types a template context holds. */
function pyStr(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Python's `str.zfill(width)`: zero-pad on the left, after any sign. */
export function zfill(value: string, width: number): string {
  const chars = Array.from(value);
  if (chars.length >= width) return value;
  const padding = "0".repeat(width - chars.length);
  if (value.startsWith("+") || value.startsWith("-")) {
    return value[0] + padding + value.slice(1);
  }
  return padding + value;
}

/** Python's `int(str)` for ASCII input; throws on anything else. */
function pyInt(text: string): number {
  if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(text)) {
    throw new TemplateError(`invalid literal for int() with base 10: '${text}'`);
  }
  return Number.parseInt(text.replace(/_/g, ""), 10);
}

const CASED = /[\p{Lowercase}\p{Uppercase}\p{Lt}]/u;

/** Titlecase mappings that differ from uppercase (Unicode digraphs). */
const TITLECASE: Record<string, string> = {
  "\u01C4": "\u01C5", "\u01C5": "\u01C5", "\u01C6": "\u01C5",
  "\u01C7": "\u01C8", "\u01C8": "\u01C8", "\u01C9": "\u01C8",
  "\u01CA": "\u01CB", "\u01CB": "\u01CB", "\u01CC": "\u01CB",
  "\u01F1": "\u01F2", "\u01F2": "\u01F2", "\u01F3": "\u01F2",
};

function titlecaseChar(ch: string): string {
  const mapped = TITLECASE[ch];
  if (mapped) return mapped;
  const upper = ch.toUpperCase();
  // Multi-character uppercase forms ("ß" -> "SS") titlecase as "Ss".
  const [first = "", ...rest] = Array.from(upper);
  return rest.length ? first + rest.join("").toLowerCase() : upper;
}

/**
 * Python's `str.title()`: a cased character is titlecased when the previous
 * character is not cased, and lowercased otherwise. Digits and apostrophes
 * are not cased, so "they're 1st" becomes "They'Re 1St".
 */
export function pyTitle(value: string): string {
  const chars = Array.from(value);
  let out = "";
  let prevCased = false;
  chars.forEach((ch, i) => {
    const cased = CASED.test(ch);
    if (!cased) {
      out += ch;
    } else if (prevCased) {
      // Final sigma: Σ at the end of a word lowercases to ς.
      const next = chars[i + 1];
      out += ch === "\u03A3" && !(next !== undefined && CASED.test(next)) ? "\u03C2" : ch.toLowerCase();
    } else {
      out += titlecaseChar(ch);
    }
    prevCased = cased;
  });
  return out;
}

// ---------------------------------------------------------------------------
// TemplateEngine
// ---------------------------------------------------------------------------

/**
 * Template engine for generating filenames from metadata.
 *
 * Supported placeholders:
 *   {title}          Movie/show title
 *   {original_title} Original language title
 *   {year}           Release year
 *   {season}         Season number
 *   {season2}        Season number (2 digits, zero-padded)
 *   {episode}        Episode number
 *   {episode2}       Episode number (2 digits, zero-padded)
 *   {episode_title}  Episode title
 *   {absolute}       Absolute episode number, when the provider has one
 *   {air_date}       Air date (YYYY-MM-DD)
 *
 * In a multi-episode file, {episode} and {episode2} render every episode as
 * Plex and Jellyfin name them ("S{season2}E{episode2}" gives "S01E01-E02";
 * see `EpisodeNumbers`), and {episode_title} joins the titles with " & ".
 *   {quality}        Video quality (1080p, 720p, etc.)
 *   {source}         Video source (BluRay, WEB-DL, etc.)
 *   {codec}          Video codec
 *   {group}          Release group
 *   {ext}            File extension
 *   plus the music fields listed in VALID_FIELDS.
 *
 * Formatters (pipe syntax):
 *   {title|lower}       lowercase
 *   {title|upper}       uppercase
 *   {title|title}       title case (Python str.title() rules)
 *   {title|clean}       remove invalid filename characters
 *   {season|pad:2}      zero-pad to N digits
 *   {title|replace:_: } replace underscores with spaces
 *
 * Field names in templates and contexts keep the Python snake_case spelling
 * ("episode_title"), since templates are user-facing configuration.
 */
export class TemplateEngine {
  static readonly DEFAULT_MOVIE_TEMPLATE = "{title} ({year})";
  static readonly DEFAULT_TV_TEMPLATE = "{title} - S{season2}E{episode2} - {episode_title}";
  static readonly DEFAULT_MUSIC_TEMPLATE = "{artist}/{album} ({year})/{track2} - {title}";

  /** Matches `{field}`, `{field|formatter}` and `{field|formatter:arg}`. */
  static readonly PLACEHOLDER_PATTERN =
    /\{(?<field>[\p{L}\p{N}_]+)(?:\|(?<formatter>[\p{L}\p{N}_]+)(?::(?<arg>[^}]+))?)?\}/gu;

  /** Characters invalid in filenames on various OSes (including "/"). */
  static readonly INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
  /** Same, but preserves forward slashes for directory templates. */
  static readonly INVALID_CHARS_PRESERVE_SLASH = /[<>:"\\|?*\x00-\x1f]/g;

  static readonly FORMATTERS: Readonly<Record<string, (value: string, ...args: string[]) => string>> = {
    lower: (s) => s.toLowerCase(),
    upper: (s) => s.toUpperCase(),
    title: (s) => pyTitle(s),
    clean: (s) => s.replace(TemplateEngine.INVALID_CHARS, ""),
    pad: (s, n) => {
      if (n === undefined) throw new TemplateError("The pad formatter needs a width, e.g. {episode|pad:2}");
      return zfill(s, pyInt(n));
    },
    replace: (s, oldText, newText) => {
      if (oldText === undefined || newText === undefined) {
        throw new TemplateError("The replace formatter needs two arguments, e.g. {title|replace:_: }");
      }
      return s.replaceAll(oldText, newText);
    },
  };

  static readonly VALID_FIELDS: ReadonlySet<string> = new Set([
    // Common fields
    "title",
    "original_title",
    "year",
    "ext",
    // Video fields
    "season",
    "season2",
    "episode",
    "episode2",
    "episode_title",
    "absolute",
    "air_date",
    "quality",
    "source",
    "codec",
    "group",
    "edition",
    "audio_codec",
    "audio_channels",
    "hdr",
    // Metadata IDs and dates
    "tmdb_id",
    "tvdb_id",
    "air_date",
    "air_year",
    // Music fields
    "artist",
    "album",
    "album_artist",
    "track",
    "track2",
    "disc",
    "disc2",
    "genre",
    "track_total",
    "disc_total",
    "disc_multi",
  ]);

  movieTemplate: string;
  tvTemplate: string;
  musicTemplate: string;

  constructor(options: TemplateEngineOptions = {}) {
    this.movieTemplate = options.movieTemplate ?? TemplateEngine.DEFAULT_MOVIE_TEMPLATE;
    this.tvTemplate = options.tvTemplate ?? TemplateEngine.DEFAULT_TV_TEMPLATE;
    this.musicTemplate = options.musicTemplate ?? TemplateEngine.DEFAULT_MUSIC_TEMPLATE;
  }

  /**
   * Render a template with the given context.
   *
   * Missing (`undefined`/`null`) fields render as "". Unknown formatters
   * leave the value unchanged. A malformed `pad` or `replace` formatter
   * throws TemplateError.
   *
   * A "/" inside a value is removed ("AC/DC" renders as "ACDC", "Face/Off"
   * as "FaceOff"), so only the slashes written in the template itself
   * create folders.
   *
   * Text between `<` and `>` is an optional section: it disappears when
   * none of its placeholders has a value (see `templateSections.ts`).
   */
  render(template: string, context: TemplateContext): string {
    if (hasSections(template)) {
      return renderSections(template, (text) => this.renderPlaceholders(text, context));
    }
    return this.renderPlaceholders(template, context);
  }

  /** Fill in the placeholders of a template without optional sections. */
  private renderPlaceholders(template: string, context: TemplateContext): string {
    return template.replace(TemplateEngine.PLACEHOLDER_PATTERN, (...args: unknown[]) => {
      const groups = args[args.length - 1] as { field: string; formatter?: string; arg?: string };
      const { field, formatter, arg } = groups;

      const raw = Object.hasOwn(context, field) ? context[field] : undefined;
      if (raw === undefined || raw === null) return "";
      if (raw instanceof EpisodeNumbers) {
        // Each number gets the formatter, as a single episode's would.
        const offset = args[args.length - 3] as number;
        const spec = formatter ? `|${formatter}${arg !== undefined ? `:${arg}` : ""}` : "";
        return raw.render(template.slice(0, offset), (n) => this.render(`{n${spec}}`, { n }));
      }

      let value = pyStr(raw).replaceAll("/", "");
      const formatters = TemplateEngine.FORMATTERS;

      if (formatter) {
        if (formatter === "pad" && arg) {
          value = formatters.pad!(value, arg);
        } else if (formatter === "replace" && arg) {
          const parts = arg.split(":");
          if (parts.length >= 2) {
            value = formatters.replace!(value, parts[0]!, parts[1]!);
          }
        } else if (Object.hasOwn(formatters, formatter)) {
          value = formatters[formatter]!(value);
        }
      }

      return value;
    });
  }

  /**
   * Generate a filename for a movie.
   *
   * @param extension File extension, with or without leading dot.
   * @param extraContext Additional values (quality, source, ...); these
   *   override the movie's own fields.
   */
  renderMovie(movie: Movie, extension = "", extraContext?: TemplateContext): string {
    const context: TemplateContext = {
      title: movie.title,
      original_title: movie.originalTitle,
      year: movie.year,
      tmdb_id: movie.provider === "tmdb" ? movie.id : undefined,
      ext: stripLeadingDots(extension),
      ...extraContext,
    };
    return this.finish(this.render(this.movieTemplate, context), extension);
  }

  /** Generate a filename for a TV episode. */
  renderEpisode(episode: Episode, extension = "", extraContext?: TemplateContext): string {
    const context: TemplateContext = {
      title: episode.show.title,
      original_title: episode.show.originalTitle,
      year: episode.show.year,
      season: episode.season,
      season2: zfill(String(episode.season), 2),
      episode: episode.episode,
      episode2: zfill(String(episode.episode), 2),
      episode_title: episode.title,
      tmdb_id: episode.show.provider === "tmdb" ? episode.show.id : undefined,
      tvdb_id: episode.show.provider === "tvdb" ? episode.show.id : undefined,
      air_date: episode.airDate,
      air_year: episode.airDate ? episode.airDate.slice(0, 4) : undefined,
      ext: stripLeadingDots(extension),
      ...episodeContext(episode),
      ...extraContext,
    };
    return this.finish(this.render(this.tvTemplate, context), extension);
  }

  /** Generate a filename for a music track (may include directories). */
  renderTrack(track: Track, extension = "", extraContext?: TemplateContext): string {
    const album = track.album;
    const context: TemplateContext = {
      title: track.title,
      artist: track.artist.name,
      album: album ? album.title : "",
      album_artist: album ? album.artist.name : track.artist.name,
      year: album && album.year ? album.year : "",
      track: track.trackNumber || "",
      track2: zfill(String(track.trackNumber || 0), 2),
      disc: track.discNumber || "",
      disc2: zfill(String(track.discNumber || 1), 2),
      genre: track.genres.length ? track.genres[0] : "",
      track_total: album?.totalTracks || undefined,
      disc_total: album?.totalDiscs || undefined,
      disc_multi: album?.totalDiscs && album.totalDiscs > 1 ? track.discNumber || undefined : undefined,
      ext: stripLeadingDots(extension),
      ...extraContext,
    };
    return this.finish(this.render(this.musicTemplate, context), extension);
  }

  /** Clean the rendered path and append the extension if it is missing. */
  private finish(rendered: string, extension: string): string {
    let result = this.cleanPath(rendered);
    if (extension) {
      const ext = stripLeadingDots(extension);
      if (!result.endsWith(`.${ext}`)) result += `.${ext}`;
    }
    return result;
  }

  /**
   * Remove invalid characters from each path component, preserving "/" as
   * the directory separator. Empty components (leading, trailing, or doubled
   * slashes) are dropped, and so are components made only of dots and
   * spaces (".", ".."), so neither a template nor metadata (a tag such as
   * artist "../..") can point outside the destination folder. Backslashes
   * are always removed, never treated as separators, so output is the same
   * on every OS.
   */
  cleanPath(path: string): string {
    const isDotsOnly = (part: string) => /^[.\s]*$/u.test(part) && part.includes(".");
    if (!path.includes("/")) {
      const cleaned = path.replace(TemplateEngine.INVALID_CHARS, "");
      return isDotsOnly(cleaned) ? "" : cleaned;
    }
    return path
      .split("/")
      .map((part) => part.replace(TemplateEngine.INVALID_CHARS, ""))
      .filter((part) => part && !isDotsOnly(part))
      .join("/");
  }

  /** Validate a template string. */
  validateTemplate(template: string): TemplateValidation {
    const errors: string[] = [];

    for (const match of template.matchAll(TemplateEngine.PLACEHOLDER_PATTERN)) {
      const { field, formatter } = match.groups as { field: string; formatter?: string };

      if (!TemplateEngine.VALID_FIELDS.has(field)) {
        errors.push(`Unknown field: {${field}}`);
      }
      if (formatter && !Object.hasOwn(TemplateEngine.FORMATTERS, formatter)) {
        errors.push(`Unknown formatter: ${formatter}`);
      }
    }

    // Check for unclosed braces
    const openCount = template.split("{").length - 1;
    const closeCount = template.split("}").length - 1;
    if (openCount !== closeCount) {
      errors.push("Mismatched braces in template");
    }
    errors.push(...sectionErrors(template));

    return { isValid: errors.length === 0, errors };
  }

  /** Documentation for available template fields: name to description. */
  static getAvailableFields(): Record<string, string> {
    return {
      // Common
      title: "Movie, TV show, or track title",
      original_title: "Original language title",
      year: "Release year",
      ext: "File extension",
      // Video
      season: "Season number",
      season2: "Season number (2 digits, zero-padded)",
      episode: "Episode number",
      episode2: "Episode number (2 digits, zero-padded)",
      episode_title: "Episode title",
      absolute: "Absolute episode number (anime)",
      quality: "Video quality (e.g., 1080p)",
      source: "Video source (e.g., BluRay)",
      codec: "Video codec (e.g., x264)",
      group: "Release group",
      edition: "Edition (e.g., Director's Cut)",
      audio_codec: "Audio codec (e.g., Dolby Digital Plus)",
      audio_channels: "Audio channels (e.g., 5.1)",
      hdr: "HDR format (e.g., HDR10, Dolby Vision)",
      tmdb_id: "TMDB ID of the movie or show",
      tvdb_id: "TVDB ID of the show",
      air_date: "Episode air date (YYYY-MM-DD)",
      air_year: "Year the episode aired",
      // Music
      artist: "Track artist name",
      album: "Album title",
      album_artist: "Album artist (for compilations)",
      track: "Track number",
      track2: "Track number (2 digits, zero-padded)",
      disc: "Disc number",
      disc2: "Disc number (2 digits, zero-padded)",
      genre: "Music genre",
      track_total: "Number of tracks on the album",
      disc_total: "Number of discs in the album",
      disc_multi: "Disc number, only for albums with more than one disc",
    };
  }

  /** Documentation for available formatters: syntax to description. */
  static getAvailableFormatters(): Record<string, string> {
    return {
      lower: "Convert to lowercase",
      upper: "Convert to uppercase",
      title: "Convert to title case",
      clean: "Remove invalid filename characters",
      "pad:N": "Zero-pad to N digits",
      "replace:old:new": "Replace old with new",
    };
  }
}

/** Python's `str.lstrip(".")`. */
function stripLeadingDots(extension: string): string {
  return extension.replace(/^\.+/, "");
}
