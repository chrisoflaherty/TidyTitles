/** Formatting helpers shared by the commands (always en-US, never the runtime locale). */

import path from "node:path";
import { episodeNumbers } from "@tidytitles/core";
import type {
  LookupErrorInfo,
  MatchedMetadata,
  PlannedOperation,
  SelectableOption,
  SkipReason,
} from "@tidytitles/core";

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const NUMBER = new Intl.NumberFormat("en-US");

/** "18,450" */
export function formatCount(n: number): string {
  return NUMBER.format(n);
}

/**
 * Parse a history timestamp (Python `datetime.isoformat()`, local time,
 * optional microseconds and offset) without relying on Date's lenient parser.
 */
export function parseHistoryTimestamp(timestamp: string): Date | undefined {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      timestamp.trim(),
    );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = "0", frac = "0", zone] = m;
  const ms = Math.floor(Number(frac.padEnd(6, "0")) / 1000);
  if (zone) {
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s.padStart(2, "0")}.${String(ms).padStart(3, "0")}${
      zone === "Z" ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone
    }`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "Nov 7, 2026, 7:00 PM"; the raw string when it cannot be parsed. */
export function formatHistoryTimestamp(timestamp: string): string {
  const date = parseHistoryTimestamp(timestamp);
  return date ? DATE_TIME.format(date) : timestamp;
}

/** Short, human description of a skip reason. */
export function describeSkip(op: PlannedOperation): string {
  const reason: SkipReason | undefined = op.skipReason;
  switch (reason) {
    case "no_match":
      return "no match";
    case "lookup_failed":
      return `lookup failed: ${op.lookupError?.message ?? op.errorMessage ?? "unknown error"}`;
    case "unknown_metadata":
      return "unknown metadata";
    case "template_error":
      return `template error: ${op.errorMessage ?? ""}`.trim();
    case "duplicate_destination":
      return "duplicate destination";
    case "same_path":
      return "already named";
    case "would_overwrite":
      return "destination exists";
    case "cross_device_link":
      return "can't hard link to another volume";
    case "link_unsupported":
      return "the volume doesn't support hard links";
    case "match_cleared":
      return "match cleared";
    default:
      return op.errorMessage ?? "skipped";
  }
}

/** Table cells for one selection option: [title, artist/year, type]. */
export function describeOption(option: SelectableOption): [string, string, string] {
  switch (option.kind) {
    case "movie":
      return [option.title, String(option.year), "Movie"];
    case "show":
      return [option.title, String(option.year), "TV Show"];
    case "track": {
      const artist = option.artist.name;
      return [option.title, option.album ? `${artist} - ${option.album.title}` : artist, "Track"];
    }
  }
}

// ---------------------------------------------------------------------------
// JSON shapes (stable, documented in --help; never contain API keys)
// ---------------------------------------------------------------------------

export function matchToJson(metadata: MatchedMetadata | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  switch (metadata.kind) {
    case "movie":
      return {
        kind: "movie",
        id: metadata.id,
        title: metadata.title,
        year: metadata.year,
        provider: metadata.provider,
        verificationStatus: metadata.verificationStatus ?? null,
      };
    case "episode":
      return {
        kind: "episode",
        show: {
          id: metadata.show.id,
          title: metadata.show.title,
          year: metadata.show.year,
          provider: metadata.show.provider,
        },
        season: metadata.season,
        episode: metadata.episode,
        episodes: episodeNumbers(metadata),
        absoluteNumber: metadata.absoluteNumber ?? null,
        airDate: metadata.airDate ?? null,
        title: metadata.title,
        episodeTitles: metadata.parts ? metadata.parts.map((part) => part.title) : [metadata.title],
        verificationStatus: metadata.verificationStatus ?? null,
      };
    case "track":
      return {
        kind: "track",
        id: metadata.id,
        title: metadata.title,
        artist: metadata.artist.name,
        album: metadata.album?.title ?? null,
        year: metadata.album?.year ?? null,
        trackNumber: metadata.trackNumber ?? null,
        discNumber: metadata.discNumber ?? null,
        verificationStatus: metadata.verificationStatus ?? null,
      };
    default:
      return null;
  }
}

function lookupErrorToJson(info: LookupErrorInfo | undefined): Record<string, unknown> | null {
  return info ? { kind: info.kind, name: info.name, message: info.message } : null;
}

export function operationToJson(op: PlannedOperation): Record<string, unknown> {
  return {
    source: op.source,
    destination: op.destination,
    status: op.status,
    skipReason: op.skipReason ?? null,
    error: op.errorMessage ?? null,
    lookupError: lookupErrorToJson(op.lookupError),
    mediaType: op.mediaFile.parsedInfo.mediaType,
    match: matchToJson(op.mediaFile.matchedMetadata),
    // "chosen" when the user picked the match with a search of their own words.
    correction: op.mediaFile.correction?.match ?? null,
    associatedFiles: op.associatedFiles.map((a) => ({
      source: a.source,
      destination: a.destination,
      fileType: a.fileType,
    })),
  };
}

/** Base name of a path. */
export function base(p: string): string {
  return path.basename(p);
}

/**
 * How to show a rename destination: the path relative to the folder the file
 * is renamed into (`baseDir`: the output directory, or the source's own
 * folder). That is the bare name when the file stays put, and includes any
 * folders the template creates, e.g. "Artist/Album (2001)/01 - Song.mp3".
 */
export function destinationLabel(destination: string, baseDir: string): string {
  const relative = path.relative(baseDir, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.basename(destination);
  }
  return relative;
}

/** "Subtitle" from "subtitle" (Python `str.capitalize`). */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
