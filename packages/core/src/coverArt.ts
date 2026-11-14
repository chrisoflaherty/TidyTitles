/**
 * Cover art download service.
 *
 * Port of `file_renamer/services/cover_art.py`. HTTP goes through an injected
 * `fetch` so tests can mock it.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathStem, pathSuffix } from "./associatedFiles";
import type {
  Album,
  Episode,
  MatchedMetadata,
  Movie,
  RenameOperation,
  Track,
} from "./models";
import type { FetchFn } from "./providers/base";
import type { ProgressCallback } from "./renamer";

/** TMDB poster sizes. */
export type TmdbPosterSize =
  | "w92"
  | "w154"
  | "w185"
  | "w342"
  | "w500"
  | "w780"
  | "original";

export interface CoverArtDownloaderOptions {
  /** Filename for movie/TV posters. Default "poster.jpg". */
  filename?: string;
  /** Filename for album art. Default "cover.jpg". */
  musicFilename?: string;
  /** Replace existing cover art. Default false. */
  overwrite?: boolean;
  /** TMDB poster size. Default "w500". */
  size?: TmdbPosterSize | (string & {});
  /** Fetch implementation. Default `globalThis.fetch`. */
  fetch?: FetchFn;
  /** Request timeout in milliseconds. Default 30,000. */
  timeoutMs?: number;
}

/** Replace a path's final extension, like Python's `Path.with_suffix`. */
function withSuffix(filePath: string, suffix: string): string {
  return path.join(path.dirname(filePath), pathStem(filePath) + suffix);
}

/** Service for downloading cover art for media files. */
export class CoverArtDownloader {
  static readonly TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
  static readonly CAA_BASE = "https://coverartarchive.org";
  static readonly TMDB_POSTER_SIZE = "w500";
  static readonly TMDB_ORIGINAL_SIZE = "original";

  filename: string;
  musicFilename: string;
  overwrite: boolean;
  size: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: CoverArtDownloaderOptions = {}) {
    this.filename = options.filename ?? "poster.jpg";
    this.musicFilename = options.musicFilename ?? "cover.jpg";
    this.overwrite = options.overwrite ?? false;
    this.size = options.size ?? "w500";
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** TMDB image URL for a poster path such as "/abc.jpg". */
  tmdbImageUrl(posterPath: string): string {
    return `${CoverArtDownloader.TMDB_IMAGE_BASE}/${this.size}${posterPath}`;
  }

  /** Cover Art Archive front-cover URL for a MusicBrainz release ID. */
  static coverArtArchiveUrl(releaseId: string): string {
    return `${CoverArtDownloader.CAA_BASE}/release/${releaseId}/front`;
  }

  /** Download a movie poster. Returns the saved path, or undefined. */
  async downloadForMovie(movie: Movie, destinationDir: string): Promise<string | undefined> {
    if (!movie.posterPath) return undefined;
    return this.download(
      this.tmdbImageUrl(movie.posterPath),
      path.join(destinationDir, this.filename),
    );
  }

  /** Download the show poster for a TV episode. */
  async downloadForEpisode(
    episode: Episode,
    destinationDir: string,
  ): Promise<string | undefined> {
    if (!episode.show.posterPath) return undefined;
    return this.download(
      this.tmdbImageUrl(episode.show.posterPath),
      path.join(destinationDir, this.filename),
    );
  }

  /** Download album art for a track (undefined when the track has no album). */
  async downloadForTrack(track: Track, destinationDir: string): Promise<string | undefined> {
    if (!track.album) return undefined;
    return this.downloadForAlbum(track.album, destinationDir);
  }

  /**
   * Download album art: the album's coverArtUrl first, then the Cover Art
   * Archive for MusicBrainz releases.
   */
  async downloadForAlbum(album: Album, destinationDir: string): Promise<string | undefined> {
    const destPath = path.join(destinationDir, this.musicFilename);

    if (album.coverArtUrl) {
      const result = await this.download(album.coverArtUrl, destPath);
      if (result) return result;
    }

    if (album.id && album.provider === "musicbrainz") {
      return this.download(CoverArtDownloader.coverArtArchiveUrl(album.id), destPath);
    }

    return undefined;
  }

  /**
   * Download an image to `destPath`. If the file already exists and overwrite
   * is off, nothing is downloaded and the existing path is returned. The
   * extension is adjusted to match the response's content type. Any failure
   * (network, non-200 status, filesystem) returns undefined.
   */
  private async download(url: string, destPath: string): Promise<string | undefined> {
    if (existsSync(destPath) && !this.overwrite) return destPath;

    try {
      const response = await this.fetchFn(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) return undefined;

      const body = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(destPath), { recursive: true });

      const contentType = response.headers.get("content-type") ?? "";
      let ext: string;
      if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = ".jpg";
      else if (contentType.includes("png")) ext = ".png";
      else if (contentType.includes("webp")) ext = ".webp";
      else ext = ".jpg";

      let finalPath = destPath;
      if (pathSuffix(finalPath).toLowerCase() !== ext) {
        finalPath = withSuffix(finalPath, ext);
        // The new name gets the same no-overwrite protection as the requested one.
        if (existsSync(finalPath) && !this.overwrite) return finalPath;
      }

      await writeFile(finalPath, body);
      return finalPath;
    } catch {
      return undefined;
    }
  }

  /** Download cover art for any matched metadata. */
  async downloadForMetadata(
    metadata: MatchedMetadata,
    destinationDir: string,
  ): Promise<string | undefined> {
    switch (metadata.kind) {
      case "movie":
        return this.downloadForMovie(metadata, destinationDir);
      case "episode":
        return this.downloadForEpisode(metadata, destinationDir);
      case "track":
        return this.downloadForTrack(metadata, destinationDir);
      default:
        return undefined;
    }
  }

  /**
   * Download cover art for completed rename operations, into each
   * destination's directory. Progress counts only completed operations.
   *
   * There is no explicit de-duplication: several files in one directory share
   * one poster/cover filename, so with overwrite off only the first download
   * happens and later ones return the existing path. The returned list has
   * one entry per completed operation that produced or found art, so the same
   * path can appear more than once (as in the Python).
   */
  async downloadForOperations(
    operations: RenameOperation[],
    progressCallback?: ProgressCallback,
  ): Promise<string[]> {
    const downloaded: string[] = [];
    const completed = operations.filter((op) => op.status === "completed");
    const total = completed.length;

    for (const [i, op] of completed.entries()) {
      progressCallback?.(i + 1, total, `Downloading art: ${path.basename(op.destination)}`);

      const metadata = op.mediaFile.matchedMetadata;
      if (!metadata) continue;

      const result = await this.downloadForMetadata(metadata, path.dirname(op.destination));
      if (result) downloaded.push(result);
    }

    return downloaded;
  }
}
