/**
 * NFO files for media servers (`[write_metadata] nfo`).
 *
 * Kodi, Jellyfin, and Emby read an XML `.nfo` file next to a video; Plex
 * does not (without an add-on). Written from the matched metadata the app
 * already has, with no extra lookups:
 * - a movie: `<movie>` in "<video name>.nfo"
 * - an episode: `<episodedetails>` in "<video name>.nfo"; a file holding
 *   several episodes gets one `<episodedetails>` per episode, one after the
 *   other, as Kodi (up to v21) and Jellyfin read them
 * - the show: `<tvshow>` in `tvshow.nfo`, in the show's folder
 *
 * Every file starts with an XML declaration (UTF-8) and a comment saying
 * TidyTitles wrote it. Text is escaped and characters XML 1.0 does not
 * allow are dropped, so the file parses whatever the metadata contains. The
 * names come from the video's own (already valid) name, or are the fixed
 * `tvshow.nfo`.
 *
 * Existing files are never replaced, except when the conflict strategy is
 * "overwrite" (and never an NFO that travels with the video as an
 * associated file). See `writeNfoFile`.
 */

import { existsSync } from "node:fs";
import { link, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Episode, EpisodePart, Movie, TVShow } from "./models";
import { fingerprintOf, temporaryNameFor, type FileFingerprint } from "./transfer";
import { VIDEO_EXTENSIONS } from "./scan";

/** The kinds of NFO file. */
export type NfoKind = "movie" | "episode" | "tvshow";

/** Marker comment at the top of every NFO this app writes. */
export const NFO_MARKER = "Written by TidyTitles";

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/** Remove characters XML 1.0 does not allow (controls, lone surrogates, U+FFFE/U+FFFF). */
export function xmlSafeText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

export function escapeXml(value: string): string {
  return xmlSafeText(value).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;",
  );
}

type Field = [name: string, value: string | number | undefined, attributes?: Record<string, string>];

function element([name, value, attributes]: Field): string | undefined {
  if (value === undefined || value === "") return undefined;
  const attrs = Object.entries(attributes ?? {})
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  return `  <${name}${attrs}>${escapeXml(String(value))}</${name}>`;
}

function block(root: string, fields: Field[]): string {
  const lines = fields.map(element).filter((l): l is string => l !== undefined);
  return [`<${root}>`, ...lines, `</${root}>`].join("\n");
}

function document(...blocks: string[]): string {
  return ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<!-- ${NFO_MARKER} -->`, ...blocks, ""].join("\n");
}

/** "tmdb" or "tvdb", the `uniqueid` type for a provider name. */
function idType(provider: string): string | undefined {
  const p = provider.toLowerCase();
  return p === "tmdb" || p === "tvdb" || p === "imdb" ? p : undefined;
}

function uniqueId(provider: string, id: number): Field[] {
  const type = idType(provider);
  return type && id > 0 ? [["uniqueid", id, { type, default: "true" }]] : [];
}

export function movieNfo(movie: Movie): string {
  return document(
    block("movie", [
      ["title", movie.title],
      ["originaltitle", movie.originalTitle],
      ["year", movie.year > 0 ? movie.year : undefined],
      ["premiered", movie.releaseDate],
      ["plot", movie.overview],
      ...movie.genres.map((g): Field => ["genre", g]),
      ...uniqueId(movie.provider, movie.id),
    ]),
  );
}

function episodeBlock(show: TVShow, season: number, part: EpisodePart): string {
  return block("episodedetails", [
    ["title", part.title],
    ["showtitle", show.title],
    ["season", season],
    ["episode", part.episode],
    ["aired", part.airDate],
    ["plot", part.overview],
  ]);
}

/** The NFO of an episode file; one `<episodedetails>` per episode it holds. */
export function episodeNfo(episode: Episode): string {
  const parts: EpisodePart[] =
    episode.parts && episode.parts.length > 0
      ? episode.parts
      : [
          {
            episode: episode.episode,
            title: episode.title,
            ...(episode.airDate ? { airDate: episode.airDate } : {}),
            ...(episode.overview ? { overview: episode.overview } : {}),
          },
        ];
  return document(...parts.map((p) => episodeBlock(episode.show, episode.season, p)));
}

export function tvShowNfo(show: TVShow): string {
  return document(
    block("tvshow", [
      ["title", show.title],
      ["originaltitle", show.originalTitle],
      ["year", show.year > 0 ? show.year : undefined],
      ...show.genres.map((g): Field => ["genre", g]),
      ["studio", show.network],
      ["status", show.status],
      ...uniqueId(show.provider, show.id),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Where they go
// ---------------------------------------------------------------------------

/** "<video name>.nfo" next to the video. */
export function nfoPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return path.join(path.dirname(videoPath), `${path.basename(videoPath, ext)}.nfo`);
}

const SEASON_FOLDER = /^(?:(?:season|series|staffel|saison|temporada|stagione|seizoen)[\s._-]*\d{1,4}|s\d{1,4}|specials?)$/i;

/** Lowercase letters and digits only, accents removed, for comparing names. */
function nameKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The show's folder for an episode at `videoPath`: the episode's folder, or
 * the one above it when that is a season folder ("Season 1", "S01",
 * "Specials"), provided its name contains the show's title. Undefined when
 * the episodes do not sit in a folder of their own (a flat folder of
 * several shows), so a `tvshow.nfo` would describe the wrong thing.
 */
export function showFolderFor(videoPath: string, showTitle: string): string | undefined {
  let folder = path.dirname(path.resolve(videoPath));
  if (SEASON_FOLDER.test(path.basename(folder))) folder = path.dirname(folder);
  if (path.dirname(folder) === folder) return undefined;
  const title = nameKey(showTitle);
  if (title === "" || !nameKey(path.basename(folder)).includes(title)) return undefined;
  return folder;
}

/** True when `folder` (or a folder below it, two levels deep) holds a video file. */
export async function folderHasVideos(folder: string, depth = 2): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) return true;
  }
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory() && (await folderHasVideos(path.join(folder, e.name), depth - 1))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write `content` as a new file at `target`, never leaving a partial file
 * under that name: a temporary file first, then a hard link to the final
 * name, which fails if the name was taken meanwhile. With `replace`, an
 * existing file is replaced in one step instead. Returns the new file's
 * fingerprint.
 */
export async function writeNfoFile(target: string, content: string, replace: boolean): Promise<FileFingerprint | undefined> {
  const temp = temporaryNameFor(target);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    if (replace) {
      await rename(temp, target);
    } else {
      try {
        await link(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw error;
        // No hard links on this volume: check, then rename.
        if (existsSync(target)) throw Object.assign(new Error(`${target} already exists`), { code: "EEXIST" });
        await rename(temp, target);
      }
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return fingerprintOf(target);
}
