/**
 * One batch of watched files: look them up with `RenameSession.plan`, decide
 * which may be renamed without asking, and (in automatic mode) rename those
 * with `RenameSession.execute`, so output folders, transfer modes, conflict
 * checks, associated files, cover art, any post-rename steps, and the
 * history all apply exactly as in a rename the user starts.
 *
 * ## When automatic mode renames a file
 *
 * Only when every one of these holds; otherwise the file waits for review
 * (`WatchReviewReason`), and nothing about it changes on disk:
 *
 * 1. The lookup succeeded and gave **exactly one** candidate: a movie or TV
 *    search with a single result (and, for TV, the episode was found), a
 *    music search with a single result, or music tags that MusicBrainz
 *    confirmed (`verified`). The session's selection callback skips every
 *    question, so a search with several results is never resolved by
 *    taking the first one; unconfirmed music tags (`unverified`) wait too.
 * 2. The plan has the file as "pending": no template error, no hard link
 *    that cannot work, no other file of the batch wanting the same name.
 * 3. **No conflict**: nothing exists at the new name or at the new name of
 *    any associated file. The session is planned with the conflict strategy
 *    "skip" and no overwriting (`watchSessionSettings`), so a taken name is
 *    never versioned or replaced automatically; such files go to review,
 *    where the user's own strategy applies.
 * 4. The file is still the one that finished arriving (same device, inode,
 *    size, and modification time), checked right before renaming, and its
 *    associated files have not changed within the settle period.
 *
 * Lookup failures that may go away (service down, rate limit, network,
 * authentication) are retried later instead (`result: "retry"`).
 */

import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "./config";
import type { PlannedOperation, SkipReason } from "./renameService";
import { isCaseOnlyRename } from "./renamer";
import type { RenameSession } from "./session";
import type { WatchReviewReason } from "./watchEvents";
import type { WatchMode } from "./watchConfig";
import { fileIdentity, type ReadyFile, type WatchFileSystem, nodeWatchFileSystem } from "./watcher";

/** What happened to one file of a batch. */
export type WatchFileOutcome =
  | { path: string; result: "renamed"; operation: PlannedOperation }
  | { path: string; result: "review"; reason: WatchReviewReason; operation?: PlannedOperation; message?: string }
  | { path: string; result: "unchanged"; operation: PlannedOperation }
  | { path: string; result: "retry"; message: string; operation?: PlannedOperation }
  /** It changed after it seemed finished: back to waiting until it stops changing. */
  | { path: string; result: "changed" }
  /** It is no longer there. */
  | { path: string; result: "gone" };

export interface WatchBatchResult {
  outcomes: WatchFileOutcome[];
  /** The planned operations (after execution, in automatic mode). */
  operations: PlannedOperation[];
  /** Operations saved to the history (automatic renames, one entry per batch). */
  historySaved: number;
  coverArt: string[];
}

export interface WatchBatchOptions {
  mode: WatchMode;
  /** The settle period: associated files changed more recently than this hold the file back. */
  settleMs: number;
  signal?: AbortSignal;
  /** Runs renaming and saving the history; a CLI keeps Ctrl+C from cutting it short. */
  guard?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  fs?: Pick<WatchFileSystem, "stat">;
}

/**
 * The settings a watch session is built with: in automatic mode, conflicts
 * are never resolved automatically (strategy "skip", no overwriting).
 */
export function watchSessionSettings(settings: Settings, mode: WatchMode): Settings {
  if (mode !== "automatic") return settings;
  return { ...settings, conflictResolution: "skip", overwrite: false };
}

const RETRYABLE = new Set(["authentication", "rate_limit", "provider", "other"]);

const SKIP_REVIEW: Partial<Record<SkipReason, WatchReviewReason>> = {
  no_match: "no_match",
  duplicate_destination: "conflict",
  would_overwrite: "conflict",
  template_error: "template_error",
  cross_device_link: "transfer_unavailable",
  link_unsupported: "transfer_unavailable",
};

/** Reasons whose plan message says more than the reason itself. */
const WITH_MESSAGE = new Set<WatchReviewReason>(["lookup_failed", "template_error", "not_renamable", "rename_failed"]);

/** Lookup statuses that mean "exactly one candidate". */
const UNAMBIGUOUS = new Set(["auto_matched", "verified", "from_provider"]);

/**
 * Why a planned operation may not be renamed automatically, judged from
 * the plan alone (the disk is checked separately), or undefined when it
 * may. Exported for tests.
 */
export function automaticBlocker(op: PlannedOperation): WatchReviewReason | undefined {
  if (op.lookupError) return "lookup_failed";
  if (op.status !== "pending") {
    if (op.mediaFile.selectionSkipped) return "several_matches";
    return (op.skipReason && SKIP_REVIEW[op.skipReason]) ?? "not_renamable";
  }
  if (op.mediaFile.selectionSkipped) return "several_matches";
  const metadata = op.mediaFile.matchedMetadata;
  if (!metadata) return "no_match";
  if (metadata.verificationStatus === "unverified") return "unverified";
  if (!metadata.verificationStatus || !UNAMBIGUOUS.has(metadata.verificationStatus)) return "not_renamable";
  if (op.mediaFile.correction) return "not_renamable";
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

/** True when a new name is taken on disk by something other than the file itself. */
async function nameTaken(source: string, destination: string): Promise<boolean> {
  if (samePath(source, destination) || isCaseOnlyRename(source, destination)) return false;
  return exists(destination);
}

/**
 * Look up a batch of finished files and, in automatic mode, rename the
 * unambiguous ones. The session's selection callback is replaced by one
 * that never chooses. Throws only when `signal` aborts; any other failure
 * of the whole batch (an output folder missing, an unexpected error) makes
 * every file "retry".
 */
export async function processWatchBatch(
  session: RenameSession,
  files: readonly ReadyFile[],
  options: WatchBatchOptions,
): Promise<WatchBatchResult> {
  const fs = options.fs ?? nodeWatchFileSystem;
  const now = options.now ?? Date.now;
  const guard = options.guard ?? ((fn) => fn());
  const outcomes: WatchFileOutcome[] = [];
  const result: WatchBatchResult = { outcomes, operations: [], historySaved: 0, coverArt: [] };

  // Still the same file that finished arriving?
  const current = async (file: ReadyFile): Promise<"same" | "changed" | "gone"> => {
    try {
      const s = await fs.stat(file.path);
      return fileIdentity(s) === file.identity ? "same" : "changed";
    } catch {
      return "gone";
    }
  };

  const lookup: ReadyFile[] = [];
  for (const file of files) {
    const state = await current(file);
    if (state === "same") lookup.push(file);
    else outcomes.push({ path: file.path, result: state });
  }
  if (lookup.length === 0) return result;

  // Nobody is asked anything: several results always means "skip".
  session.selectionCallback = () => undefined;

  let operations: PlannedOperation[];
  try {
    operations = await session.plan(
      lookup.map((f) => f.path),
      options.signal ? { signal: options.signal } : {},
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    for (const file of lookup) outcomes.push({ path: file.path, result: "retry", message });
    return result;
  }
  result.operations = operations;

  const byPath = new Map(lookup.map((f) => [f.path, f]));
  const eligible: PlannedOperation[] = [];
  for (const op of operations) {
    const error = op.lookupError;
    if (error && RETRYABLE.has(error.kind)) {
      outcomes.push({ path: op.source, result: "retry", message: error.message, operation: op });
      continue;
    }
    const blocker = automaticBlocker(op);
    if (blocker) {
      const message = WITH_MESSAGE.has(blocker) ? op.errorMessage : undefined;
      outcomes.push({ path: op.source, result: "review", reason: blocker, operation: op, ...(message ? { message } : {}) });
      continue;
    }
    if (samePath(op.source, op.destination)) {
      outcomes.push({ path: op.source, result: "unchanged", operation: op });
      continue;
    }
    if (options.mode === "review") {
      outcomes.push({ path: op.source, result: "review", reason: "review_mode", operation: op });
      continue;
    }
    eligible.push(op);
  }

  // Automatic: check the disk once more, right before renaming.
  const toRename: PlannedOperation[] = [];
  for (const op of eligible) {
    const file = byPath.get(op.source)!;
    const state = await current(file);
    if (state !== "same") {
      outcomes.push({ path: op.source, result: state });
      continue;
    }
    let conflict = await nameTaken(op.source, op.destination);
    let associatedChanging = false;
    for (const assoc of op.associatedFiles) {
      if (await nameTaken(assoc.source, assoc.destination)) conflict = true;
      try {
        const s = await stat(assoc.source);
        if (now() - s.mtimeMs < options.settleMs) associatedChanging = true;
      } catch {
        // Gone: the renamer reports it; the main file is unaffected.
      }
    }
    if (conflict) {
      outcomes.push({ path: op.source, result: "review", reason: "conflict", operation: op });
      continue;
    }
    if (associatedChanging) {
      outcomes.push({ path: op.source, result: "changed" });
      continue;
    }
    toRename.push(op);
  }
  if (toRename.length === 0) return result;

  await guard(async () => {
    await session.execute(toRename);
    result.historySaved = await session.saveHistory(toRename);
  });
  if (session.coverArtEnabled && toRename.some((op) => op.status === "completed")) {
    try {
      result.coverArt = await session.downloadCoverArt(toRename);
    } catch {
      // Cover art is a bonus; the renames stand.
    }
  }

  for (const op of toRename) {
    if (op.status === "completed") outcomes.push({ path: op.source, result: "renamed", operation: op });
    else if (op.status === "skipped" && op.skipReason === "same_path") outcomes.push({ path: op.source, result: "unchanged", operation: op });
    else if (op.status === "skipped") {
      outcomes.push({ path: op.source, result: "review", reason: (op.skipReason && SKIP_REVIEW[op.skipReason]) ?? "not_renamable", operation: op, ...(op.errorMessage ? { message: op.errorMessage } : {}) });
    } else {
      outcomes.push({ path: op.source, result: "review", reason: "rename_failed", operation: op, message: op.errorMessage ?? "Unknown error" });
    }
  }
  return result;
}

/** Every path a completed operation created (main and associated files), for loop prevention. */
export function createdPaths(op: PlannedOperation): string[] {
  if (op.status !== "completed") return [];
  return [op.destination, ...op.associatedFiles.map((a) => a.destination)];
}
