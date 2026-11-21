/**
 * How a file gets to its new name: moved (the default), copied, or hard
 * linked, and how each of those is undone.
 *
 * Safety rules, shared by every mode:
 * - Nothing is ever written under the final name until it is complete. A
 *   copy goes to a hidden temporary file in the destination folder first
 *   and is then put in place in one step, so a failure or a crash leaves at
 *   most a `.…tidytitles-tmp` file, never a half-written file with the new
 *   name. A cross-volume move uses the same copy.
 * - With overwrite off, an existing destination is never replaced, also not
 *   by a race: the final step is a hard link (which fails when the name is
 *   taken) where the filesystem supports one.
 * - Every file the app moves or creates is recorded with a fingerprint
 *   (device, inode, size, modification time), so undo can tell whether the
 *   file at the destination is still the one the app put there.
 */

import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, statSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  rename as fsRename,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { RenameError } from "./errors";

/**
 * How files reach their destination:
 * - "move": rename (or, across volumes, copy and then delete the original)
 * - "copy": a new copy; the original stays where it is
 * - "hardlink": a second name for the same data; only within one volume
 */
export type TransferMode = "move" | "copy" | "hardlink";

export const TRANSFER_MODES: readonly TransferMode[] = ["move", "copy", "hardlink"];

export function isTransferMode(value: unknown): value is TransferMode {
  return TRANSFER_MODES.includes(value as TransferMode);
}

/**
 * Identity of a file the app moved or created, taken right after the
 * transfer. Device and inode are decimal strings (they can exceed 2^53);
 * `mtimeNs` is the modification time in nanoseconds, also a string.
 */
export interface FileFingerprint {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
}

/** What `FileRenamer` records on an operation (and its associated files) after a transfer. */
export interface TransferRecord {
  mode: TransferMode;
  /** Absent when the file could not be examined afterward (it is then never removed by undo). */
  fingerprint?: FileFingerprint;
}

/** The fingerprint of the file (not following links) at `p`, or undefined when nothing is there. */
export function fingerprintOf(p: string): FileFingerprint | undefined {
  try {
    const s = lstatSync(p, { bigint: true });
    return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs) };
  } catch {
    return undefined;
  }
}

/**
 * Some filesystems (FAT and exFAT on some systems, some network shares)
 * report inode 0 for every file; then the inode tells nothing.
 */
function inodeKnown(f: FileFingerprint): boolean {
  return f.ino !== "0";
}

/**
 * Whether two fingerprints are the same file: device and inode (or, where
 * inodes are unknown, size and modification time).
 *
 * A known limit: Linux reuses the inode number of a deleted file for the
 * next file created, so a file deleted and then recreated under the same
 * name can pass as the original. Undo then moves the new file back; nothing
 * is lost, but it is not the file that was renamed. Creation time would not
 * settle it: macOS rewrites it when a modification time is set earlier.
 */
export function sameFileIdentity(a: FileFingerprint, b: FileFingerprint): boolean {
  if (!inodeKnown(a) || !inodeKnown(b)) return a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs;
  return a.dev === b.dev && a.ino === b.ino;
}

/** Same file with the same size and modification time: unchanged since the fingerprint was taken. */
export function unchangedSince(current: FileFingerprint, recorded: FileFingerprint): boolean {
  return (
    sameFileIdentity(current, recorded) && current.size === recorded.size && current.mtimeNs === recorded.mtimeNs
  );
}

/**
 * Why a transfer could not be done, for front ends to branch on:
 * - "cross_device_link": a hard link was asked for across volumes
 * - "link_unsupported": the destination volume does not support hard links
 */
export type TransferFailureReason = "cross_device_link" | "link_unsupported";

/** A transfer that cannot be done for a reason the user should see per file. */
export class TransferError extends RenameError {
  readonly reason: TransferFailureReason;

  constructor(reason: TransferFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/** Skip message for a hard link that would cross volumes (see `SkipReason` "cross_device_link"). */
export const CROSS_DEVICE_LINK_MESSAGE = "A hard link can't cross volumes; the destination is on another volume";
/** Skip message for a volume without hard links (see `SkipReason` "link_unsupported"). */
export const LINK_UNSUPPORTED_MESSAGE = "The destination volume doesn't support hard links";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Error codes meaning "this filesystem cannot make hard links". */
const NO_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "EINVAL"]);

/** A hidden temporary name next to `destination`. */
export function temporaryNameFor(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID().slice(0, 8)}.tidytitles-tmp`,
  );
}

/** The device of the nearest existing folder at or above `dir`, or undefined. */
function deviceOfNearestFolder(dir: string): bigint | undefined {
  let current = path.resolve(dir);
  for (;;) {
    try {
      return statSync(current, { bigint: true }).dev;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * True when `source` and the folder `destination` would be created in are
 * known to be on different volumes (false when either cannot be examined).
 */
export function crossesVolumes(source: string, destination: string): boolean {
  let sourceDev: bigint;
  try {
    sourceDev = statSync(source, { bigint: true }).dev;
  } catch {
    return false;
  }
  const destDev = deviceOfNearestFolder(path.dirname(destination));
  return destDev !== undefined && destDev !== sourceDev;
}

/**
 * Put a finished temporary file in place under `destination`. With
 * `overwrite` an existing file is replaced in one step; without it the
 * destination is never replaced: a hard link fails if the name is taken
 * (on filesystems without hard links, the name is checked just before).
 * The temporary file is gone afterward, whatever happens.
 */
async function commitTemporary(temp: string, destination: string, overwrite: boolean): Promise<void> {
  try {
    if (overwrite) {
      await fsRename(temp, destination);
      return;
    }
    try {
      await link(temp, destination);
      await unlink(temp).catch(() => undefined);
      return;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") throw new RenameError(`Destination already exists: ${destination}`);
      if (!NO_LINK_CODES.has(errnoCode(error) ?? "")) throw error;
    }
    if (existsSync(destination)) throw new RenameError(`Destination already exists: ${destination}`);
    await fsRename(temp, destination);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (error instanceof RenameError) throw error;
    throw new RenameError(`Failed to put the file in place: ${errorText(error)}`, { cause: error });
  }
}

/**
 * Copy `source` to `destination` safely: into a temporary file in the
 * destination folder (keeping the modification time), then into place. On
 * any failure the temporary file is removed and `destination` is untouched.
 * The destination folder must exist.
 */
export async function safeCopy(source: string, destination: string, overwrite: boolean): Promise<void> {
  const temp = temporaryNameFor(destination);
  try {
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    try {
      const st = await stat(source);
      await utimes(temp, st.atime, st.mtime);
    } catch {
      // Timestamps are best effort, as with shutil.copy2 on some filesystems.
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new RenameError(`Failed to copy file: ${errorText(error)}`, { cause: error });
  }
  await commitTemporary(temp, destination, overwrite);
}

/**
 * Make `destination` a hard link to `source`. Fails with TransferError when
 * the two are on different volumes or the volume has no hard links. With
 * overwrite on, an existing destination is replaced in one step.
 */
export async function hardLink(source: string, destination: string, overwrite: boolean): Promise<void> {
  const target = overwrite ? temporaryNameFor(destination) : destination;
  try {
    await link(source, target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "EXDEV") throw new TransferError("cross_device_link", CROSS_DEVICE_LINK_MESSAGE, { cause: error });
    if (code === "EEXIST") throw new RenameError(`Destination already exists: ${destination}`);
    if (NO_LINK_CODES.has(code ?? "")) {
      throw new TransferError("link_unsupported", LINK_UNSUPPORTED_MESSAGE, { cause: error });
    }
    throw new RenameError(`Failed to create hard link: ${errorText(error)}`, { cause: error });
  }
  if (overwrite) await commitTemporary(target, destination, true);
}

/**
 * Move across volumes: a safe copy, then delete the original. When the
 * original cannot be deleted, the copy is removed again so the file is not
 * left in two places (and the error is reported).
 */
export async function moveAcrossVolumes(source: string, destination: string, overwrite: boolean): Promise<void> {
  await safeCopy(source, destination, overwrite);
  try {
    await unlink(source);
  } catch (error) {
    const copy = fingerprintOf(destination);
    const original = fingerprintOf(source);
    // Only remove the copy while the original is certainly still there.
    if (copy && original) await unlink(destination).catch(() => undefined);
    throw new RenameError(`Failed to move file: ${errorText(error)}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Undo of one file
// ---------------------------------------------------------------------------

/**
 * Why undo left a file alone:
 * - "changed": the file at the new name is not the one the app put there
 *   (replaced or edited since)
 * - "original_missing": a copy or link whose original is gone, so removing
 *   it could lose the only copy
 * - "renamed_later": an entry recorded before fingerprints existed whose
 *   file a later rename in the history also touched; undo that one first
 */
export type UndoKeptReason = "changed" | "original_missing" | "renamed_later";

/** A file that undo left where it is. */
export interface UndoKeptFile {
  /** The file at its new name (left alone). */
  path: string;
  reason: UndoKeptReason;
}

/** What undoing one file did. */
export type UndoFileOutcome =
  | { kind: "restored" }
  | { kind: "missing" }
  | { kind: "kept"; reason: UndoKeptReason }
  | { kind: "failed"; message: string };

/** One file to undo: where it was, where the app put it, and how. */
export interface UndoFileRecord {
  source: string;
  destination: string;
  /** Absent: a move. */
  transfer?: Exclude<TransferMode, "move">;
  fingerprint?: FileFingerprint;
}

export interface UndoFileOptions {
  /** Moves the file back (a FileRenamer with overwrite off, so nothing is replaced). */
  moveBack: (from: string, to: string) => Promise<void>;
  /**
   * Paths a more recent history entry touched. Used only for records
   * without a fingerprint (written by older versions), which cannot
   * otherwise tell their file from another one put at the same path.
   */
  touchedLater?: ReadonlySet<string>;
}

function pathKey(p: string): string {
  return path.normalize(p);
}

/** Normalized key for `touchedLater` sets. */
export function historyPathKey(p: string): string {
  return pathKey(p);
}

/**
 * Undo one transferred file:
 * - a move is moved back, if the file at the new name is still the one the
 *   app moved (its device and inode match the fingerprint);
 * - a copy is deleted, only if it is unchanged since it was made (device,
 *   inode, size, and modification time) and the original still exists;
 * - a hard link is deleted, only if it is still the link the app made and
 *   the original name still refers to the same data.
 * The original is never touched by undoing a copy or link.
 */
export async function undoTransferredFile(
  record: UndoFileRecord,
  options: UndoFileOptions,
): Promise<UndoFileOutcome> {
  const { source, destination } = record;
  let current: FileFingerprint | undefined;
  try {
    const s = await lstat(destination, { bigint: true });
    current = { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs) };
  } catch {
    return { kind: "missing" };
  }

  const recorded = record.fingerprint;
  if (!recorded && options.touchedLater?.has(pathKey(destination))) {
    return { kind: "kept", reason: "renamed_later" };
  }

  if (!record.transfer) {
    if (recorded && !sameFileIdentity(current, recorded)) return { kind: "kept", reason: "changed" };
    try {
      await options.moveBack(destination, source);
      return { kind: "restored" };
    } catch (error) {
      if (!(error instanceof RenameError)) throw error;
      return { kind: "failed", message: error.message };
    }
  }

  // A copy or a link: never removed without proof that it is ours.
  if (!recorded) return { kind: "kept", reason: "changed" };
  const original = fingerprintOf(source);
  if (record.transfer === "copy") {
    if (!unchangedSince(current, recorded)) return { kind: "kept", reason: "changed" };
    if (!original || sameFileIdentity(original, current)) return { kind: "kept", reason: "original_missing" };
  } else {
    if (!sameFileIdentity(current, recorded)) return { kind: "kept", reason: "changed" };
    if (!original || !sameFileIdentity(original, current)) return { kind: "kept", reason: "original_missing" };
  }
  try {
    await unlink(destination);
    return { kind: "restored" };
  } catch (error) {
    return { kind: "failed", message: `Failed to remove ${path.basename(destination)}: ${errorText(error)}` };
  }
}
