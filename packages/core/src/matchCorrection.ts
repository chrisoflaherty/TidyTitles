/**
 * Correcting a plan after the lookup, shared by both front ends:
 *
 * - search again with other words (and, for a video file, as another kind:
 *   movie or TV episode, with corrected season and episode numbers);
 * - give a file any result of that search, and optionally give a chosen TV
 *   show to the other files whose parsed show title is the same;
 * - clear a file's match, so it is left alone;
 * - type a file's new name.
 *
 * Every change is followed by a re-plan of the whole list with
 * `RenameService.generatePreview`, so names, associated files, and
 * conflicts follow exactly the rules of a normal plan. One difference in
 * order: corrected files are planned after the files the user did not
 * touch, in the order they were corrected. So a correction never takes a
 * name away from a file the user did not correct (the corrected file is the
 * one marked "Duplicate name" or versioned), and the most recent correction
 * yields to earlier ones.
 *
 * A corrector changes the media files of the plan in place (as
 * `fetchMetadata` does) and holds the current operations; nothing it does
 * touches files on disk.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { abortable, mapConcurrent } from "./concurrency";
import { checkFileName, stemWithout, type FileNameProblem } from "./customName";
import {
  mediaFileExtension,
  type MatchedMetadata,
  type MediaType,
  type Movie,
  type Track,
} from "./models";
import { isMusicFile } from "./musicParser";
import {
  isNullProvider,
  type PlannedMediaFile,
  type DestinationDirResolver,
  type PlannedOperation,
  type RenameService,
  type SelectableOption,
} from "./renameService";
import { isCaseOnlyRename } from "./renamer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What to search for when correcting a match. */
export type MatchQuery =
  | { mediaType: "movie"; title: string; year?: number }
  | {
      mediaType: "tv_episode";
      /** The show's title. */
      title: string;
      year?: number;
      /** Needed to choose a show (the episode is looked up with them). */
      season?: number;
      episode?: number;
    }
  | { mediaType: "music"; title: string; artist?: string; album?: string };

export type MatchQueryType = MatchQuery["mediaType"];

/** How the user corrected a file after the lookup (`PlannedMediaFile.correction`). */
export interface MatchCorrection {
  /**
   * "chosen": the user picked the file's match (its `verificationStatus` is
   * "manual_selection"); "cleared": the user removed it. Absent when only
   * the name was edited.
   */
  match?: "chosen" | "cleared";
  /** The last query the user searched with for this file. */
  query?: MatchQuery;
  /** The new name the user typed, without the extension. */
  customName?: string;
  /** Order of corrections, from 1 (see the module comment). */
  sequence: number;
}

export const MATCH_CLEARED_MESSAGE = "The match was cleared, so the file is left as it is";

export interface MatchSearchResult {
  /** The query as searched (trimmed). */
  query: MatchQuery;
  options: SelectableOption[];
  /**
   * False when no metadata service is set up for this kind of search (no
   * API key, or the chosen provider does not cover it); `options` is empty.
   */
  providerAvailable: boolean;
}

export type ChooseMatchResult =
  | {
      kind: "applied";
      operations: PlannedOperation[];
      /** Indexes of the files that got the match (the file first). */
      changed: number[];
      /** Similar files (`applyToSimilar`) whose episode could not be found; left as they were. */
      unmatched: number[];
    }
  /** The show has no episode with the query's numbers. Nothing changed. */
  | { kind: "episode_not_found"; season: number; episode: number }
  /** A show was chosen but the query has no season or episode number. Nothing changed. */
  | { kind: "needs_episode" };

/** The name a file would get, for editing. */
export interface EditableName {
  /** The current new name without its extension: the typed one, or the template's. */
  name: string;
  /** The template's name without its extension. */
  templateName: string;
  /** The extension the file keeps (".mkv"), or "". */
  extension: string;
  /** Folders the template puts the file in, relative to where it is renamed ("" for none). */
  folder: string;
  /** True when `name` was typed by the user. */
  custom: boolean;
}

export type SetNameResult =
  | { kind: "applied"; operations: PlannedOperation[] }
  /** The name was refused; nothing changed. "exists": another file already has that name. */
  | { kind: "invalid"; problem: FileNameProblem | "exists"; message: string }
  /** The file has no planned name to edit (no match, or its template failed). */
  | { kind: "not_editable" };

export interface PlanCorrectorOptions {
  /** The session's forced media type for non-music files, as in the lookup. */
  forceType?: MediaType;
  /**
   * The folder files are renamed into, as passed to `generatePreview`: one
   * folder, or a folder chosen per file (output folders by matched kind).
   */
  destinationDir?: string | DestinationDirResolver;
  /** Applied to every new plan (for example to mark hard links that cannot work). */
  afterPlan?: (operations: PlannedOperation[]) => PlannedOperation[];
}

export interface ChooseMatchOptions {
  /**
   * For a TV show: also give the show to the files `similarFiles` returns,
   * each with its own season and episode. Default false.
   */
  applyToSimilar?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Queries and searching
// ---------------------------------------------------------------------------

function cleanText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function cleanNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Trim the text fields and drop empty or invalid optional ones. */
export function normalizeMatchQuery(query: MatchQuery): MatchQuery {
  const title = query.title.trim();
  switch (query.mediaType) {
    case "movie":
      return withDefined({ mediaType: "movie", title, year: cleanNumber(query.year) });
    case "tv_episode":
      return withDefined({
        mediaType: "tv_episode",
        title,
        year: cleanNumber(query.year),
        season: cleanNumber(query.season),
        episode: cleanNumber(query.episode),
      });
    case "music":
      return withDefined({
        mediaType: "music",
        title,
        artist: cleanText(query.artist),
        album: cleanText(query.album),
      });
  }
}

/** Remove keys whose value is undefined (models use absent values). */
function withDefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/**
 * The query the lookup used for a file (or the user's last one for it):
 * music files search by title, artist, and album from their tags; other
 * files by their parsed title and year, as a TV episode when the parser (or
 * the session's forced type) says so, with its season and episode numbers.
 */
export function defaultMatchQuery(file: PlannedMediaFile, forceType?: MediaType): MatchQuery {
  if (file.correction?.query) return { ...file.correction.query };
  const parsed = file.parsedInfo;
  if (isMusicFile(file.path)) {
    const tags = file.parsedMusicInfo;
    return withDefined({
      mediaType: "music",
      title: tags?.title ?? parsed.title,
      artist: cleanText(tags?.artist),
      album: cleanText(tags?.album),
    });
  }
  const type = forceType ?? parsed.mediaType;
  if (type === "tv_episode") {
    return withDefined({
      mediaType: "tv_episode",
      title: parsed.title,
      year: parsed.year,
      season: parsed.season,
      episode: parsed.episode,
    });
  }
  return withDefined({ mediaType: "movie", title: parsed.title, year: parsed.year });
}

/** The kinds of query that make sense for a file: music for audio, movie or TV for video. */
export function queryTypesFor(file: { path: string }): MatchQueryType[] {
  return isMusicFile(file.path) ? ["music"] : ["movie", "tv_episode"];
}

/**
 * Search the service's providers. An empty title returns no options without
 * a request. Provider errors are thrown (describe them with
 * `describeLookupError`).
 */
export async function searchMatches(
  service: RenameService,
  query: MatchQuery,
  { signal }: { signal?: AbortSignal } = {},
): Promise<MatchSearchResult> {
  const q = normalizeMatchQuery(query);
  signal?.throwIfAborted();
  let available: boolean;
  let search: (() => Promise<SelectableOption[]>) | undefined;
  switch (q.mediaType) {
    case "movie":
      available = !isNullProvider(service.movieProvider);
      search = () => service.movieProvider.searchMovie(q.title, q.year);
      break;
    case "tv_episode":
      available = !isNullProvider(service.tvProvider);
      search = () => service.tvProvider.searchShow(q.title, q.year);
      break;
    case "music": {
      const provider = service.musicProvider;
      available = provider !== undefined && !isNullProvider(provider);
      search = provider ? () => provider.searchRecording(q.title, q.artist, q.album) : undefined;
      break;
    }
  }
  if (!available || !search || q.title === "") {
    return { query: q, options: [], providerAvailable: available };
  }
  const options = await abortable(search(), signal);
  return { query: q, options, providerAvailable: true };
}

// ---------------------------------------------------------------------------
// The corrector
// ---------------------------------------------------------------------------

/** Show-title key for "the other files with the same parsed show title". */
function showTitleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The season and episode to look up for a file: the user's numbers, else the parsed ones. */
function episodeNumbers(file: PlannedMediaFile): { season: number; episode: number } | undefined {
  const query = file.correction?.query;
  if (query?.mediaType === "tv_episode" && query.season !== undefined && query.episode !== undefined) {
    return { season: query.season, episode: query.episode };
  }
  const { season, episode } = file.parsedInfo;
  return season != null && episode != null ? { season, episode } : undefined;
}

interface Snapshot {
  file: PlannedMediaFile;
  matchedMetadata: PlannedMediaFile["matchedMetadata"];
  lookupError: PlannedMediaFile["lookupError"];
  selectionSkipped: PlannedMediaFile["selectionSkipped"];
  correction: PlannedMediaFile["correction"];
}

function snapshot(file: PlannedMediaFile): Snapshot {
  return {
    file,
    matchedMetadata: file.matchedMetadata,
    lookupError: file.lookupError,
    selectionSkipped: file.selectionSkipped,
    correction: file.correction,
  };
}

function restore(saved: Snapshot): void {
  const { file } = saved;
  for (const key of ["matchedMetadata", "lookupError", "selectionSkipped", "correction"] as const) {
    if (saved[key] === undefined) delete file[key];
    else (file as unknown as Record<string, unknown>)[key] = saved[key];
  }
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

/**
 * Corrects the operations of one plan. Front ends create one per plan
 * (`RenameSession.corrector`) and replace their operations with
 * `operations` after every change.
 */
export class PlanCorrector {
  private ops: PlannedOperation[];

  constructor(
    readonly service: RenameService,
    operations: readonly PlannedOperation[],
    readonly options: PlanCorrectorOptions = {},
  ) {
    this.ops = [...operations];
  }

  /** The current operations, index-aligned with the ones given. */
  get operations(): PlannedOperation[] {
    return this.ops;
  }

  private file(index: number): PlannedMediaFile {
    const op = this.ops[index];
    if (!op) throw new RangeError(`No operation at index ${index}`);
    return op.mediaFile;
  }

  /** The query to start a search with for the file at `index`. */
  query(index: number): MatchQuery {
    return defaultMatchQuery(this.file(index), this.options.forceType);
  }

  /** Search with `query` (see `searchMatches`). */
  search(query: MatchQuery, options: { signal?: AbortSignal } = {}): Promise<MatchSearchResult> {
    return searchMatches(this.service, query, options);
  }

  /**
   * The other video files with the same parsed show title as the file at
   * `index` (and the same year, when both have one) that have season and
   * episode numbers: the files `applyToSimilar` changes.
   */
  similarFiles(index: number): number[] {
    const file = this.file(index);
    if (isMusicFile(file.path)) return [];
    const key = showTitleKey(file.parsedInfo.title);
    if (key === "") return [];
    const year = file.parsedInfo.year;
    const similar: number[] = [];
    this.ops.forEach((op, j) => {
      if (j === index) return;
      const other = op.mediaFile;
      if (isMusicFile(other.path) || !episodeNumbers(other)) return;
      if (showTitleKey(other.parsedInfo.title) !== key) return;
      if (year != null && other.parsedInfo.year != null && other.parsedInfo.year !== year) return;
      similar.push(j);
    });
    return similar;
  }

  private nextSequence(): number {
    let max = 0;
    for (const op of this.ops) max = Math.max(max, op.mediaFile.correction?.sequence ?? 0);
    return max + 1;
  }

  /**
   * Give the file at `index` a result of a search with `query`. A movie or
   * recording is used as it is; for a TV show, the episode with the query's
   * season and episode numbers is looked up. The match is marked
   * "manual_selection", and a name typed earlier is dropped (it was for the
   * old match). Provider errors are thrown, with nothing changed.
   */
  async chooseMatch(
    index: number,
    query: MatchQuery,
    option: SelectableOption,
    { applyToSimilar = false, signal }: ChooseMatchOptions = {},
  ): Promise<ChooseMatchResult> {
    const file = this.file(index);
    const q = normalizeMatchQuery(query);

    // Everything is looked up first, so an error or abort changes nothing.
    const updates: Array<{ index: number; metadata: MatchedMetadata; query: MatchQuery }> = [];
    const unmatched: number[] = [];
    if (option.kind === "show") {
      const numbers =
        q.mediaType === "tv_episode" && q.season !== undefined && q.episode !== undefined
          ? { season: q.season, episode: q.episode }
          : undefined;
      if (!numbers) return { kind: "needs_episode" };
      const episode = await abortable(
        this.service.tvProvider.getEpisode(option.id, numbers.season, numbers.episode),
        signal,
      );
      if (!episode) return { kind: "episode_not_found", ...numbers };
      updates.push({ index, metadata: { ...episode, verificationStatus: "manual_selection" }, query: q });

      if (applyToSimilar) {
        const others = this.similarFiles(index);
        const found = await abortable(
          mapConcurrent(others, this.service.fetchConcurrency, async (j) => {
            const n = episodeNumbers(this.file(j))!;
            try {
              return await this.service.tvProvider.getEpisode(option.id, n.season, n.episode);
            } catch (error) {
              if (signal?.aborted) throw error;
              return undefined;
            }
          }),
          signal,
        );
        others.forEach((j, k) => {
          const episodeJ = found[k];
          if (!episodeJ) {
            unmatched.push(j);
            return;
          }
          updates.push({
            index: j,
            metadata: { ...episodeJ, verificationStatus: "manual_selection" },
            query: withDefined({
              mediaType: "tv_episode",
              title: q.title,
              year: q.mediaType === "tv_episode" ? q.year : undefined,
              season: episodeJ.season,
              episode: episodeJ.episode,
            }),
          });
        });
      }
    } else {
      const metadata: Movie | Track = { ...(option as Movie | Track), verificationStatus: "manual_selection" };
      updates.push({ index, metadata, query: q });
    }
    signal?.throwIfAborted();

    let sequence = this.nextSequence();
    const operations = await this.commit(
      updates.map((u) => u.index),
      () => {
        for (const u of updates) {
          const target = u.index === index ? file : this.file(u.index);
          target.matchedMetadata = u.metadata;
          delete target.lookupError;
          delete target.selectionSkipped;
          target.correction = { match: "chosen", query: u.query, sequence: sequence++ };
        }
      },
    );
    return { kind: "applied", operations, changed: updates.map((u) => u.index), unmatched };
  }

  /** Clear the match of the file at `index`: it is left alone ("match_cleared"). */
  async clearMatch(index: number): Promise<PlannedOperation[]> {
    const file = this.file(index);
    const sequence = this.nextSequence();
    return this.commit([index], () => {
      delete file.matchedMetadata;
      delete file.lookupError;
      delete file.selectionSkipped;
      file.correction = withDefined<MatchCorrection>({ match: "cleared", query: file.correction?.query, sequence });
    });
  }

  /**
   * The name the file at `index` gets, for editing; undefined when it has
   * none (no match, or its template cannot be rendered).
   */
  async editableName(index: number): Promise<EditableName | undefined> {
    const file = this.file(index);
    if (!file.matchedMetadata) return undefined;
    const destination = await this.templateDestination(file);
    if (destination === undefined) return undefined;
    const extension = mediaFileExtension(file);
    const templateName = stemWithout(destination, extension);
    const destDir = this.destinationDirFor(file);
    const folder = path.relative(destDir, path.dirname(destination));
    const customName = file.correction?.customName;
    return {
      name: customName ?? templateName,
      templateName,
      extension,
      folder: folder.startsWith("..") || path.isAbsolute(folder) ? "" : folder,
      custom: customName !== undefined,
    };
  }

  /**
   * Give the file at `index` the typed new name (without its extension;
   * the file keeps its own). Null goes back to the template's name. A name
   * that `checkFileName` refuses, or that another file already has on disk,
   * is refused with nothing changed. The file's associated files follow the
   * new name.
   */
  async setName(index: number, typed: string | null): Promise<SetNameResult> {
    const file = this.file(index);
    const editable = await this.editableName(index);
    if (!editable) return { kind: "not_editable" };

    if (typed === null) {
      const correction = file.correction;
      if (correction?.customName === undefined) return { kind: "applied", operations: this.ops };
      const operations = await this.commit([index], () => {
        const { customName: _dropped, ...rest } = correction;
        if (rest.match === undefined) delete file.correction;
        else file.correction = rest;
      });
      return { kind: "applied", operations };
    }

    const check = checkFileName(typed, editable.extension);
    if (!check.ok) return { kind: "invalid", problem: check.problem, message: check.message };

    const destDir = this.destinationDirFor(file);
    const intended = path.join(destDir, editable.folder, check.name + editable.extension);
    if (!samePath(intended, file.path) && !isCaseOnlyRename(file.path, intended) && existsSync(intended)) {
      return {
        kind: "invalid",
        problem: "exists",
        message: `A file named “${path.basename(intended)}” already exists. Choose another name.`,
      };
    }

    const sequence = this.nextSequence();
    const operations = await this.commit([index], () => {
      file.correction = { ...file.correction, customName: check.name, sequence };
    });
    return { kind: "applied", operations };
  }

  /** The folder `file` is renamed into with its current match. */
  private destinationDirFor(file: PlannedMediaFile): string {
    const dir = this.options.destinationDir;
    return (typeof dir === "function" ? dir(file) : dir) ?? path.dirname(file.path);
  }

  /** The destination the template gives `file` on its own (no typed name, no batch conflicts). */
  private async templateDestination(file: PlannedMediaFile): Promise<string | undefined> {
    const { correction: _ignored, ...plain } = file;
    const [op] = await this.service.generatePreview([plain], this.options.destinationDir);
    return op && op.status === "pending" ? op.destination : undefined;
  }

  /** Change files, then re-plan; on an error the files are put back as they were. */
  private async commit(indexes: readonly number[], change: () => void): Promise<PlannedOperation[]> {
    const saved = indexes.map((i) => snapshot(this.file(i)));
    try {
      change();
      return await this.replan();
    } catch (error) {
      for (const s of saved) restore(s);
      throw error;
    }
  }

  /**
   * Plan every file again with the current matches and names: files the
   * user did not correct first, in list order, then corrected files in the
   * order they were corrected.
   */
  async replan(): Promise<PlannedOperation[]> {
    const files = this.ops.map((op) => op.mediaFile);
    const order = files.map((_, i) => i);
    const seq = (i: number) => files[i]!.correction?.sequence ?? 0;
    order.sort((a, b) => seq(a) - seq(b) || a - b);

    const planned = await this.service.generatePreview(
      order.map((i) => files[i]!),
      this.options.destinationDir,
    );
    const operations = new Array<PlannedOperation>(files.length);
    order.forEach((i, k) => {
      const op = planned[k]!;
      if (op.mediaFile.correction?.match === "cleared" && op.skipReason === "no_match") {
        op.skipReason = "match_cleared";
        op.errorMessage = MATCH_CLEARED_MESSAGE;
      }
      operations[i] = op;
    });
    this.ops = this.options.afterPlan ? this.options.afterPlan(operations) : operations;
    return this.ops;
  }
}

