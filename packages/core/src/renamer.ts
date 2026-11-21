/**
 * File renaming operations.
 *
 * Port of `file_renamer/core/renamer.py`. All operations that touch the
 * filesystem are async (`node:fs/promises`) so they never block an Electron
 * main process; only existence checks are synchronous.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { mkdir, rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { RenameError } from "./errors";
import {
  CROSS_DEVICE_LINK_MESSAGE,
  LINK_UNSUPPORTED_MESSAGE,
  TransferError,
  crossesVolumes,
  fingerprintOf,
  hardLink,
  moveAcrossVolumes,
  safeCopy,
  undoTransferredFile,
  type TransferMode,
} from "./transfer";
import {
  willOverwrite,
  type AssociatedFileRename,
  type RenameOperation,
} from "./models";

/** Progress callback: receives (current, total, message); current is 1-based. */
export type ProgressCallback = (
  current: number,
  total: number,
  message: string,
) => void;

export interface FileRenamerOptions {
  /** If true, validate but do not rename anything. Default false. */
  dryRun?: boolean;
  /** If true, overwrite existing destination files. Default false. */
  overwrite?: boolean;
  /** How `execute` gets files to their destination. Default "move". */
  transferMode?: TransferMode;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * True when `source` and `destination` differ only in letter case (or Unicode
 * normalization) and refer to the same existing file, which is what a
 * case-only rename looks like on a case-insensitive volume (most macOS and
 * Windows volumes). On a case-sensitive volume the two names are different
 * files, so this returns false.
 */
export function isCaseOnlyRename(source: string, destination: string): boolean {
  if (source === destination) return false;
  const fold = (p: string) => path.normalize(p).normalize("NFC").toLowerCase();
  if (fold(source) !== fold(destination)) return false;
  try {
    const a = statSync(source, { bigint: true });
    const b = statSync(destination, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * A stable identity (device and inode) for the file or link at `p`, or
 * undefined when nothing is there. Links are not followed: renaming a link
 * moves the link, and overwriting one does not touch its target.
 */
function fileIdentity(p: string): string | undefined {
  try {
    const s = lstatSync(p, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return undefined;
  }
}

/** Skip message for an operation whose destination is another file of the same batch. */
export const BATCH_OVERWRITE_MESSAGE = "Would overwrite another file in this batch";

/** Handles file renaming operations. */
export class FileRenamer {
  dryRun: boolean;
  overwrite: boolean;
  /** How `execute` gets files to their destination (`rename` always moves). */
  transferMode: TransferMode;

  constructor({ dryRun = false, overwrite = false, transferMode = "move" }: FileRenamerOptions = {}) {
    this.dryRun = dryRun;
    this.overwrite = overwrite;
    this.transferMode = transferMode;
  }

  /**
   * Get one file to `destination` in the current transfer mode, creating
   * the destination folder. "move" is `rename`; "copy" and "hardlink" leave
   * the source untouched.
   *
   * @throws TransferError for a hard link across volumes or on a volume
   *   without hard links; RenameError for everything `rename` refuses.
   */
  async transfer(source: string, destination: string): Promise<void> {
    if (this.transferMode === "move") {
      await this.rename(source, destination);
      return;
    }
    if (!existsSync(source)) {
      throw new RenameError(`Source file does not exist: ${source}`);
    }
    if (existsSync(destination) && !this.overwrite) {
      throw new RenameError(`Destination already exists: ${destination}`);
    }
    if (this.transferMode === "hardlink" && crossesVolumes(source, destination)) {
      throw new TransferError("cross_device_link", CROSS_DEVICE_LINK_MESSAGE);
    }
    if (this.dryRun) return;

    try {
      await mkdir(path.dirname(destination), { recursive: true });
    } catch (error) {
      throw new RenameError(
        `Failed to create directory ${path.dirname(destination)}: ${errorText(error)}`,
        { cause: error },
      );
    }
    if (this.transferMode === "copy") await safeCopy(source, destination, this.overwrite);
    else await hardLink(source, destination, this.overwrite);
  }

  /**
   * Rename (move) a single file, creating the destination directory if
   * needed. Falls back to copy + delete for cross-device moves (EXDEV).
   *
   * @throws RenameError when the source is missing, the destination exists
   *   and overwrite is off, or the filesystem operation fails.
   */
  async rename(source: string, destination: string): Promise<void> {
    if (!existsSync(source)) {
      throw new RenameError(`Source file does not exist: ${source}`);
    }

    const caseOnly = isCaseOnlyRename(source, destination);

    if (!caseOnly && existsSync(destination) && !this.overwrite) {
      throw new RenameError(`Destination already exists: ${destination}`);
    }

    if (this.dryRun) return;

    try {
      await mkdir(path.dirname(destination), { recursive: true });
    } catch (error) {
      throw new RenameError(
        `Failed to create directory ${path.dirname(destination)}: ${errorText(error)}`,
        { cause: error },
      );
    }

    if (caseOnly) {
      await this.renameCaseOnly(source, destination);
      return;
    }

    try {
      await fsRename(source, destination);
    } catch (error) {
      if (!isErrnoCode(error, "EXDEV")) {
        throw new RenameError(`Failed to rename file: ${errorText(error)}`, {
          cause: error,
        });
      }
      await this.copyAndDelete(source, destination);
    }
  }

  /**
   * Case-only rename on a case-insensitive volume: go through a temporary
   * name so the new case sticks on every filesystem (some, such as FAT and
   * exFAT on some platforms, ignore a direct case-only rename).
   */
  private async renameCaseOnly(source: string, destination: string): Promise<void> {
    const temp = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${randomUUID().slice(0, 8)}.tidytitles-tmp`,
    );
    try {
      await fsRename(source, temp);
    } catch (error) {
      throw new RenameError(`Failed to rename file: ${errorText(error)}`, {
        cause: error,
      });
    }
    try {
      await fsRename(temp, destination);
    } catch (error) {
      await fsRename(temp, source).catch(() => undefined);
      throw new RenameError(`Failed to rename file: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Cross-device move: a safe copy (preserving timestamps, never a partial
   * file under the final name), then delete the source.
   */
  private async copyAndDelete(source: string, destination: string): Promise<void> {
    await moveAcrossVolumes(source, destination, this.overwrite);
  }

  /**
   * Rename associated files. Returns error messages ("name: reason"), empty
   * when all succeeded, and the files that were actually moved.
   */
  private async renameAssociatedFiles(
    associated: AssociatedFileRename[],
    batchFiles: Set<string>,
  ): Promise<{ errors: string[]; moved: AssociatedFileRename[] }> {
    const errors: string[] = [];
    const moved: AssociatedFileRename[] = [];
    for (const assoc of associated) {
      try {
        if (this.clobbersBatchFile(assoc.source, assoc.destination, batchFiles)) {
          throw new RenameError(BATCH_OVERWRITE_MESSAGE);
        }
        await this.transfer(assoc.source, assoc.destination);
        this.rememberMoved(assoc.destination, batchFiles);
        this.recordTransfer(assoc);
        moved.push(assoc);
      } catch (error) {
        if (!(error instanceof RenameError)) throw error;
        errors.push(`${path.basename(assoc.source)}: ${error.message}`);
      }
    }
    return { errors, moved };
  }

  /**
   * True when overwriting is on and `destination` is a different file that
   * in this batch (still at its old name, or already at its new one).
   * Overwriting it would destroy a file the user is renaming, not one they
   * agreed to replace. (With overwrite off, `rename` refuses any existing
   * destination anyway.)
   */
  private clobbersBatchFile(source: string, destination: string, batchFiles: Set<string>): boolean {
    if (!this.overwrite) return false;
    const target = fileIdentity(destination);
    return target !== undefined && target !== fileIdentity(source) && batchFiles.has(target);
  }

  /** Note how a file got to its destination, with its fingerprint, for history and undo. */
  private recordTransfer(target: { destination: string; transfer?: RenameOperation["transfer"] }): void {
    if (this.dryRun) return;
    const fingerprint = fingerprintOf(target.destination);
    target.transfer = fingerprint ? { mode: this.transferMode, fingerprint } : { mode: this.transferMode };
  }

  /** Track a file this batch moved (a cross-device move gives it a new identity). */
  private rememberMoved(destination: string, batchFiles: Set<string>): void {
    if (this.dryRun) return;
    const id = fileIdentity(destination);
    if (id !== undefined) batchFiles.add(id);
  }

  /**
   * Execute a batch of rename operations. Operations are updated in place and
   * the same array is returned.
   *
   * Only "pending" operations run. Each one ends as:
   * - "skipped" with "Source and destination are the same"
   * - "skipped" with "Would overwrite existing file" (overwrite off)
   * - "skipped" with BATCH_OVERWRITE_MESSAGE (overwrite on, but the
   *   destination is another file this batch moves)
   * - "completed" (errorMessage "Associated files: ..." if some associated
   *   files failed; the main file still counts as renamed, and
   *   `associatedFiles` is narrowed to the files that actually moved, so
   *   history and undo never touch the others)
   * - "failed" with the RenameError message
   */
  async execute(
    operations: RenameOperation[],
    progressCallback?: ProgressCallback,
  ): Promise<RenameOperation[]> {
    const total = operations.length;

    // Every file in this batch, so no operation overwrites another one's
    // source (a swap or chain of names) or result. That includes files whose
    // own operation is already skipped (for example a correctly named file
    // that another file in the batch also maps onto): the user listed them,
    // so "overwrite" must not destroy them.
    const batchFiles = new Set<string>();
    for (const op of operations) {
      for (const p of [op.source, ...op.associatedFiles.map((a) => a.source)]) {
        const id = fileIdentity(p);
        if (id !== undefined) batchFiles.add(id);
      }
    }

    for (const [i, op] of operations.entries()) {
      progressCallback?.(i + 1, total, `Renaming: ${path.basename(op.source)}`);

      if (op.status !== "pending") continue;

      if (path.normalize(op.source) === path.normalize(op.destination)) {
        op.status = "skipped";
        op.errorMessage = "Source and destination are the same";
        continue;
      }

      if (
        willOverwrite(op) &&
        !this.overwrite &&
        !isCaseOnlyRename(op.source, op.destination)
      ) {
        op.status = "skipped";
        op.errorMessage = "Would overwrite existing file";
        continue;
      }

      if (this.clobbersBatchFile(op.source, op.destination, batchFiles)) {
        op.status = "skipped";
        op.errorMessage = BATCH_OVERWRITE_MESSAGE;
        continue;
      }

      // Another name for the very same file (a hard link made earlier):
      // there is nothing to transfer, and replacing it would be a no-op
      // that leaves a temporary name behind.
      // A case-only change can't give a copy or link a name of its own on a
      // case-insensitive volume either.
      const destinationId = fileIdentity(op.destination);
      if (
        destinationId !== undefined &&
        destinationId === fileIdentity(op.source) &&
        (this.transferMode !== "move" || !isCaseOnlyRename(op.source, op.destination))
      ) {
        op.status = "skipped";
        op.errorMessage = "Source and destination are the same";
        continue;
      }

      try {
        await this.transfer(op.source, op.destination);
        this.rememberMoved(op.destination, batchFiles);
        this.recordTransfer(op);

        if (op.associatedFiles.length > 0) {
          const { errors, moved } = await this.renameAssociatedFiles(
            op.associatedFiles,
            batchFiles,
          );
          if (errors.length > 0) {
            op.errorMessage = `Associated files: ${errors.join("; ")}`;
            op.associatedFiles = moved;
          }
        }

        op.status = "completed";
      } catch (error) {
        if (error instanceof TransferError) {
          // Nothing was created; the file is skipped with a typed reason.
          op.status = "skipped";
          op.errorMessage =
            error.reason === "cross_device_link" ? CROSS_DEVICE_LINK_MESSAGE : LINK_UNSUPPORTED_MESSAGE;
          continue;
        }
        if (!(error instanceof RenameError)) throw error;
        op.status = "failed";
        op.errorMessage = error.message;
      }
    }

    return operations;
  }

  /**
   * Undo a batch of rename operations, in reverse order. Only "completed"
   * operations are undone: associated files first (in reverse), then the main
   * file. An undone operation goes back to "pending"; a failed undo keeps its
   * status and gets errorMessage "Undo failed: ...".
   */
  async undo(
    operations: RenameOperation[],
    progressCallback?: ProgressCallback,
  ): Promise<RenameOperation[]> {
    const total = operations.length;
    const reversed = [...operations].reverse();

    for (const [i, op] of reversed.entries()) {
      progressCallback?.(i + 1, total, `Undoing: ${path.basename(op.destination)}`);

      if (op.status !== "completed") continue;

      if (op.transfer && op.transfer.mode !== "move") {
        // A copy or link: remove what was made, never the original.
        const problems: string[] = [];
        for (const file of [...op.associatedFiles].reverse()) {
          problems.push(...(await this.undoCreated(file)));
        }
        problems.push(...(await this.undoCreated(op)));
        if (problems.length === 0) op.status = "pending";
        else op.errorMessage = `Undo failed: ${problems.join("; ")}`;
        continue;
      }

      try {
        for (const assoc of [...op.associatedFiles].reverse()) {
          await this.rename(assoc.destination, assoc.source);
        }
        await this.rename(op.destination, op.source);
        op.status = "pending";
      } catch (error) {
        if (!(error instanceof RenameError)) throw error;
        op.errorMessage = `Undo failed: ${error.message}`;
      }
    }

    return operations;
  }

  /** Remove a copy or link this renamer made, if it is still the file it made. Returns problems. */
  private async undoCreated(file: {
    source: string;
    destination: string;
    transfer?: RenameOperation["transfer"];
  }): Promise<string[]> {
    const mode = file.transfer?.mode;
    const outcome = await undoTransferredFile(
      {
        source: file.source,
        destination: file.destination,
        transfer: mode === "copy" || mode === "hardlink" ? mode : undefined,
        fingerprint: file.transfer?.fingerprint,
      },
      { moveBack: (from, to) => this.rename(from, to) },
    );
    if (outcome.kind === "failed") return [outcome.message];
    if (outcome.kind === "kept") return [`${path.basename(file.destination)}: left in place (${outcome.reason})`];
    return [];
  }
}
