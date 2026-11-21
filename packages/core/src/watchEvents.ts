/**
 * What a watch folder reports: one stream of typed events that both front
 * ends log, show, or print as JSON. Front ends branch on `type` and
 * `reason`, never on message text.
 */

import type { LookupErrorKind } from "./renameService";
import type { TransferMode } from "./transfer";

/** A watched folder's state. */
export interface WatchFolderInfo {
  folder: string;
  /** "ok": being watched; "missing": not there (unplugged, unmounted); "error": cannot be read. */
  status: "ok" | "missing" | "error";
  /** Media files that were already there (left alone unless the user asks). */
  existing: number;
  /** True when changes are found only by rescanning (no file-system events). */
  polling: boolean;
}

/**
 * Why a file waits for the user instead of being renamed automatically:
 * - "review_mode": review mode; it has a match and waits for confirmation
 * - "several_matches": the search found more than one result
 * - "no_match": nothing was found
 * - "lookup_failed": the lookup failed in a way retrying does not fix
 *   (no episodes in the chosen order)
 * - "unverified": music tags that MusicBrainz did not confirm
 * - "conflict": the new name is taken (on disk or by another file of the batch)
 * - "template_error": the naming template could not be filled in
 * - "transfer_unavailable": a hard link is not possible for this file
 * - "rename_failed": renaming was attempted and failed (see `message`)
 * - "not_renamable": anything else that leaves the file unrenamed
 */
export type WatchReviewReason =
  | "review_mode"
  | "several_matches"
  | "no_match"
  | "lookup_failed"
  | "unverified"
  | "conflict"
  | "template_error"
  | "transfer_unavailable"
  | "rename_failed"
  | "not_renamable";

export const WATCH_REVIEW_TEXT: Record<WatchReviewReason, string> = {
  review_mode: "ready to rename once you confirm",
  several_matches: "several matches found; choose one",
  no_match: "no match found",
  lookup_failed: "the lookup failed",
  unverified: "music tags not confirmed by MusicBrainz",
  conflict: "the new name is already taken",
  template_error: "the naming template could not be filled in",
  transfer_unavailable: "a hard link isn't possible for this file",
  rename_failed: "renaming failed",
  not_renamable: "it can't be renamed as it is",
};

export type WatchEvent =
  /** Watching started (or resumed). */
  | { type: "started"; folders: WatchFolderInfo[] }
  /** A watched folder went away; it is checked again at every rescan. */
  | { type: "folder_missing"; folder: string }
  /** A watched folder came back. Files found in it then are treated like files present at start. */
  | { type: "folder_restored"; folder: string; existing: number }
  /** A watched folder or one of its subfolders cannot be read (permissions, I/O). */
  | { type: "folder_error"; folder: string; code: string; message: string }
  /** File-system events are not available for this folder; it is rescanned instead. */
  | { type: "polling"; folder: string; message: string }
  /** A new media file was noticed; it is left alone until it stops changing. */
  | { type: "arriving"; path: string }
  /** A temporary download name was noticed; the finished file will appear under `finalName`. */
  | { type: "temporary"; path: string; finalName: string }
  /** A file disappeared before it finished arriving (or before it was looked up). */
  | { type: "gone"; path: string }
  /** A file could not be examined (permissions). */
  | { type: "unreadable"; path: string; code: string; message: string }
  /** Files finished arriving and wait for a lookup. */
  | { type: "ready"; paths: string[] }
  /** A batch of files is being looked up. */
  | { type: "looking_up"; count: number }
  /** A file was renamed automatically (recorded in the history for undo). */
  | {
      type: "renamed";
      path: string;
      destination: string;
      associatedFiles: number;
      transfer: TransferMode;
    }
  /** A file waits for the user. `destination` is its planned new name, when it has one. */
  | { type: "review"; path: string; reason: WatchReviewReason; destination?: string; message?: string }
  /** A file already has the name it would get; nothing was done. */
  | { type: "unchanged"; path: string }
  /** Lookups failed (service down, rate limit); these files are tried again at `retryAt` (epoch ms). */
  | { type: "retry"; paths: string[]; retryAt: number; message: string; kind?: LookupErrorKind }
  /** A file changed again after it seemed finished; it waits until it stops changing. */
  | { type: "changed"; path: string }
  /** Automatic renames were saved in the history as one entry. */
  | { type: "history_saved"; operations: number }
  /** Cover art downloaded after automatic renames. */
  | { type: "cover_art"; files: string[] }
  /** Watching stopped (or paused). */
  | { type: "stopped" };

export type WatchEventType = WatchEvent["type"];
