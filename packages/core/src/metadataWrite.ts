/**
 * Writing metadata after a rename (`[write_metadata]`): corrected tags into
 * music files (musicTags.ts) and NFO files for media servers (nfo.ts).
 *
 * Runs as part of `RenameSession.execute`, after the files are in place,
 * for every completed operation. Results are reported per file on the
 * operation (`metadataWrites`); what undo needs goes into the history
 * (`metadataUndo`, stored as `tags` and `created_files`).
 *
 * Transfer modes:
 * - move: tags are written into the moved file
 * - copy: tags go into the copy; the original is never touched
 * - hard link: tags are not written (reason "hard_link"), because both
 *   names share the same data; NFO files are new files and are written
 *
 * `tvshow.nfo` is created once, by the first episode of a batch that finds
 * its show folder without one, and recorded with that episode's rename.
 * Undo removes it only when it is unchanged and no video is left in the
 * show folder (two levels deep) once the entry's episodes are back.
 */

import path from "node:path";
import type { MatchedMetadata, RenameOperation } from "./models";
import {
  restoreTrackTags,
  writeTrackTags,
  type TagRestoreRecord,
  type TagWriteResult,
} from "./musicTags";
import {
  episodeNfo,
  folderHasVideos,
  movieNfo,
  nfoPathFor,
  showFolderFor,
  tvShowNfo,
  writeNfoFile,
  type NfoKind,
} from "./nfo";
import type { ProgressCallback } from "./renamer";
import type { RewriteHooks } from "./tags/index";
import { fingerprintOf, sameFileIdentity, unchangedSince, type FileFingerprint, type TransferMode } from "./transfer";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

/** `[write_metadata]`: both off by default. */
export interface WriteMetadataSettings {
  /** Write the match's tags into renamed music files. */
  musicTags: boolean;
  /** Write NFO files next to renamed movies and episodes. */
  nfo: boolean;
}

export const DEFAULT_WRITE_METADATA: Readonly<WriteMetadataSettings> = { musicTags: false, nfo: false };

/**
 * Outcome of one NFO file:
 * - "written": created (or, with `replaced`, an existing file replaced)
 * - "would_write": dry run
 * - "not_written": left alone (`reason`)
 * - "failed": could not be written (`message`); nothing is left behind
 */
export type NfoWriteStatus = "written" | "would_write" | "not_written" | "failed";

/**
 * Why an NFO was not written:
 * - "exists": a file of that name is already there (and the conflict
 *   strategy is not "overwrite")
 * - "associated_file": the video's own NFO moved with it to that name; it is never replaced
 * - "no_show_folder": the episode is not in a folder of its own show, so
 *   there is nowhere to put `tvshow.nfo`
 * - "write_failed"
 */
export type NfoWriteReason = "exists" | "associated_file" | "no_show_folder" | "write_failed";

export interface NfoWriteResult {
  kind: NfoKind;
  /** Absent with reason "no_show_folder". */
  path?: string;
  status: NfoWriteStatus;
  reason?: NfoWriteReason;
  /** An existing file was replaced (conflict strategy "overwrite"); undo leaves it. */
  replaced?: boolean;
  message?: string;
}

/** What was written for one operation (`RenameOperation.metadataWrites`). */
export interface MetadataWriteResults {
  /** Music files only, when music tags are on. */
  tags?: TagWriteResult;
  /** Movies and episodes only, when NFO files are on. */
  nfo?: NfoWriteResult[];
}

/** A file the rename created, for undo to remove (history `created_files`). */
export interface CreatedFileRecord {
  path: string;
  kind: NfoKind;
  fingerprint?: FileFingerprint;
}

/** What undo needs for one operation (`RenameOperation.metadataUndo`). */
export interface MetadataUndoRecord {
  tags?: TagRestoreRecord;
  createdFiles?: CreatedFileRecord[];
}

export interface WriteMetadataOptions {
  settings: WriteMetadataSettings;
  /** Report what would be written; touch nothing. */
  dryRun?: boolean;
  transferMode: TransferMode;
  /** Replace existing NFO files (conflict strategy "overwrite"). */
  overwrite?: boolean;
  progressCallback?: ProgressCallback;
  /** Tests: fail in the middle of a tag write. */
  tagHooks?: RewriteHooks;
}

function key(p: string): string {
  return path.resolve(p).normalize("NFC").toLowerCase();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeOneNfo(
  kind: NfoKind,
  target: string,
  content: string,
  op: RenameOperation,
  options: WriteMetadataOptions,
): Promise<{ result: NfoWriteResult; created?: CreatedFileRecord }> {
  const associated = op.associatedFiles.some((a) => key(a.destination) === key(target));
  if (associated) return { result: { kind, path: target, status: "not_written", reason: "associated_file" } };
  const exists = existsSync(target);
  if (exists && !options.overwrite) return { result: { kind, path: target, status: "not_written", reason: "exists" } };
  if (options.dryRun) return { result: { kind, path: target, status: "would_write", ...(exists ? { replaced: true } : {}) } };
  try {
    const fingerprint = await writeNfoFile(target, content, exists);
    if (exists) return { result: { kind, path: target, status: "written", replaced: true } };
    return {
      result: { kind, path: target, status: "written" },
      created: { path: target, kind, ...(fingerprint ? { fingerprint } : {}) },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { result: { kind, path: target, status: "not_written", reason: "exists" } };
    }
    return { result: { kind, path: target, status: "failed", reason: "write_failed", message: errorText(error) } };
  }
}

/** The file whose metadata matters: the new name, or the original in a dry run. */
function fileOf(op: RenameOperation, dryRun: boolean): string {
  return dryRun ? op.source : op.destination;
}

/**
 * Write tags and NFO files for completed operations (and, in a dry run,
 * report what would be written for pending and completed ones). Updates
 * each operation's `metadataWrites` and `metadataUndo`; after a tag write
 * the operation's transfer fingerprint is the rewritten file's, so undo
 * still recognizes it.
 */
export async function writeMetadataForOperations(
  operations: readonly RenameOperation[],
  options: WriteMetadataOptions,
): Promise<void> {
  const { settings } = options;
  if (!settings.musicTags && !settings.nfo) return;
  const dryRun = options.dryRun ?? false;
  const eligible = operations.filter(
    (op) => op.status === "completed" || (dryRun && op.status === "pending"),
  );
  const showFolders = new Set<string>();

  for (const [i, op] of eligible.entries()) {
    const metadata: MatchedMetadata | undefined = op.mediaFile.matchedMetadata;
    if (!metadata) continue;
    options.progressCallback?.(i + 1, eligible.length, `Writing metadata: ${path.basename(op.destination)}`);
    const results: MetadataWriteResults = {};
    const undo: MetadataUndoRecord = {};
    const file = fileOf(op, dryRun);
    const mode = op.transfer?.mode ?? options.transferMode;

    if (settings.musicTags && metadata.kind === "track") {
      const { result, restore } = await writeTrackTags(file, metadata, {
        dryRun,
        transferMode: mode,
        ...(options.tagHooks ? { hooks: options.tagHooks } : {}),
      });
      results.tags = result;
      if (restore) {
        undo.tags = restore;
        if (op.transfer) op.transfer = { ...op.transfer, fingerprint: restore.fingerprint };
      }
    }

    if (settings.nfo && (metadata.kind === "movie" || metadata.kind === "episode")) {
      const nfo: NfoWriteResult[] = [];
      const created: CreatedFileRecord[] = [];
      const add = (r: { result: NfoWriteResult; created?: CreatedFileRecord }) => {
        nfo.push(r.result);
        if (r.created) created.push(r.created);
      };
      // The NFO goes next to the renamed video, under its new name.
      const target = nfoPathFor(op.destination);
      if (metadata.kind === "movie") {
        add(await writeOneNfo("movie", target, movieNfo(metadata), op, options));
      } else {
        add(await writeOneNfo("episode", target, episodeNfo(metadata), op, options));
        const folder = showFolderFor(op.destination, metadata.show.title);
        if (!folder) {
          nfo.push({ kind: "tvshow", status: "not_written", reason: "no_show_folder" });
        } else if (!showFolders.has(key(folder))) {
          showFolders.add(key(folder));
          const show = path.join(folder, "tvshow.nfo");
          // tvshow.nfo is never replaced: other episodes rely on it.
          add(await writeOneNfo("tvshow", show, tvShowNfo(metadata.show), op, { ...options, overwrite: false }));
        }
      }
      results.nfo = nfo;
      if (created.length > 0) undo.createdFiles = created;
    }

    if (results.tags || results.nfo) op.metadataWrites = results;
    if (undo.tags || undo.createdFiles) op.metadataUndo = undo;
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * What undo did with the tags of a file:
 * - "restored": the old tags are back
 * - "not_restored": left as they are (`reason` "changed": the file was
 *   edited after the rename, so its tags are someone else's now; "failed":
 *   see `message`)
 */
export interface TagUndoOutcome {
  status: "restored" | "not_restored";
  reason?: "changed" | "failed";
  message?: string;
}

/**
 * What undo did with a file the rename created:
 * - "removed"
 * - "missing": already gone
 * - "kept": left in place (`reason` "changed": edited since; "in_use": a
 *   `tvshow.nfo` whose folder still holds videos)
 * - "failed": could not be removed (`message`)
 */
export interface CreatedFileUndoOutcome {
  path: string;
  kind: NfoKind;
  status: "removed" | "missing" | "kept" | "failed";
  reason?: "changed" | "in_use";
  message?: string;
}

/** The part of a history operation that tag undo needs. */
export interface TagUndoTarget {
  destination: string;
  transfer?: Exclude<TransferMode, "move">;
  fingerprint?: FileFingerprint;
  tags?: TagRestoreRecord;
}

/**
 * Before a moved file goes back: put its old tags back, if it is still
 * exactly the file the tag write produced. Returns the outcome and the
 * file's fingerprint afterward (undefined when nothing was done). Copies
 * are not restored: undo deletes them, and the original was never touched.
 */
export async function restoreTagsForUndo(
  record: TagUndoTarget,
  hooks?: RewriteHooks,
): Promise<{ outcome?: TagUndoOutcome; fingerprint?: FileFingerprint }> {
  const tags = record.tags;
  if (!tags || record.transfer) return {};
  const current = fingerprintOf(record.destination);
  if (!current) return {};
  if (!sameFileIdentity(current, tags.fingerprint)) return {};
  if (!unchangedSince(current, tags.fingerprint)) {
    return { outcome: { status: "not_restored", reason: "changed" } };
  }
  try {
    const fingerprint = await restoreTrackTags(record.destination, tags, hooks);
    return { outcome: { status: "restored" }, fingerprint };
  } catch (error) {
    return { outcome: { status: "not_restored", reason: "failed", message: errorText(error) } };
  }
}

/**
 * Remove files a rename created, if they are unchanged. A `tvshow.nfo` is
 * removed only when its folder no longer holds a video.
 */
export async function undoCreatedFiles(records: readonly CreatedFileRecord[]): Promise<CreatedFileUndoOutcome[]> {
  const outcomes: CreatedFileUndoOutcome[] = [];
  for (const record of records) {
    const base = { path: record.path, kind: record.kind };
    const current = fingerprintOf(record.path);
    if (!current) {
      outcomes.push({ ...base, status: "missing" });
      continue;
    }
    if (!record.fingerprint || !unchangedSince(current, record.fingerprint)) {
      outcomes.push({ ...base, status: "kept", reason: "changed" });
      continue;
    }
    if (record.kind === "tvshow" && (await folderHasVideos(path.dirname(record.path)))) {
      outcomes.push({ ...base, status: "kept", reason: "in_use" });
      continue;
    }
    try {
      await unlink(record.path);
      outcomes.push({ ...base, status: "removed" });
    } catch (error) {
      outcomes.push({ ...base, status: "failed", message: errorText(error) });
    }
  }
  return outcomes;
}
