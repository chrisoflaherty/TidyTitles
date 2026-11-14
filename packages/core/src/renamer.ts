/**
 * File renaming operations.
 *
 * Port of `file_renamer/core/renamer.py`. All operations that touch the
 * filesystem are async (`node:fs/promises`) so they never block an Electron
 * main process; only existence checks are synchronous.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  rename as fsRename,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { RenameError } from "./errors";
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

/** Handles file renaming operations. */
export class FileRenamer {
  dryRun: boolean;
  overwrite: boolean;

  constructor({ dryRun = false, overwrite = false }: FileRenamerOptions = {}) {
    this.dryRun = dryRun;
    this.overwrite = overwrite;
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

  /** Cross-device move: copy (preserving timestamps), then delete the source. */
  private async copyAndDelete(source: string, destination: string): Promise<void> {
    const destinationExisted = existsSync(destination);
    try {
      await copyFile(source, destination);
    } catch (error) {
      // Do not leave a partial copy behind (unless we were overwriting a
      // file that was already there, in which case it is already replaced).
      if (!destinationExisted) await unlink(destination).catch(() => undefined);
      throw new RenameError(`Failed to rename file: ${errorText(error)}`, {
        cause: error,
      });
    }
    try {
      const st = await stat(source);
      await utimes(destination, st.atime, st.mtime);
    } catch {
      // Timestamps are best effort, as with shutil.copy2 on some filesystems.
    }
    try {
      await unlink(source);
    } catch (error) {
      throw new RenameError(`Failed to rename file: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Rename associated files. Returns error messages ("name: reason"), empty
   * when all succeeded.
   */
  private async renameAssociatedFiles(
    associated: AssociatedFileRename[],
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const assoc of associated) {
      try {
        await this.rename(assoc.source, assoc.destination);
      } catch (error) {
        if (!(error instanceof RenameError)) throw error;
        errors.push(`${path.basename(assoc.source)}: ${error.message}`);
      }
    }
    return errors;
  }

  /**
   * Execute a batch of rename operations. Operations are updated in place and
   * the same array is returned.
   *
   * Only "pending" operations run. Each one ends as:
   * - "skipped" with "Source and destination are the same"
   * - "skipped" with "Would overwrite existing file" (overwrite off)
   * - "completed" (errorMessage "Associated files: ..." if some associated
   *   files failed; the main file still counts as renamed)
   * - "failed" with the RenameError message
   */
  async execute(
    operations: RenameOperation[],
    progressCallback?: ProgressCallback,
  ): Promise<RenameOperation[]> {
    const total = operations.length;

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

      try {
        await this.rename(op.source, op.destination);

        if (op.associatedFiles.length > 0) {
          const assocErrors = await this.renameAssociatedFiles(op.associatedFiles);
          if (assocErrors.length > 0) {
            op.errorMessage = `Associated files: ${assocErrors.join("; ")}`;
          }
        }

        op.status = "completed";
      } catch (error) {
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
}
