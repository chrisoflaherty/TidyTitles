/**
 * Output folders: where renamed files go when they should leave the folder
 * they are in (`[output]` in config.toml, the CLI's `--output`), and the
 * checks that run before anything is moved.
 *
 * Usable on its own (a watch folder, a script): resolve a folder per file
 * with `outputDirFor`, check the folders a plan uses with
 * `checkOutputFolders`, and mark hard links that cannot work with
 * `applyTransferChecks`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { OutputSettings } from "./config";
import { ConfigError } from "./errors";
import type { MatchedMetadata, RenameOperation } from "./models";
import type { PlannedOperation } from "./renameService";
import { CROSS_DEVICE_LINK_MESSAGE, crossesVolumes, type TransferMode } from "./transfer";

/** The three kinds of output folder. */
export type OutputKind = "movie" | "tv" | "music";

export const OUTPUT_KINDS: readonly OutputKind[] = ["movie", "tv", "music"];

/** The output kind for matched metadata (undefined when there is no match). */
export function outputKindFor(metadata: MatchedMetadata | undefined): OutputKind | undefined {
  switch (metadata?.kind) {
    case "movie":
      return "movie";
    case "episode":
      return "tv";
    case "track":
      return "music";
    default:
      return undefined;
  }
}

/** Where output goes for one run: the configured folders, or one folder for everything. */
export interface OutputPlan {
  /** Folders per kind; "" or undefined: next to the original. */
  folders: Partial<Record<OutputKind, string>>;
  /**
   * One folder for every kind (the CLI's `--output`), which wins over
   * `folders`. It is created when missing, as the CLI always did; the
   * configured folders are not, because a missing one usually means an
   * unmounted drive or share.
   */
  override?: string;
}

/** The output plan from the `[output]` settings and an optional override folder. */
export function outputPlanFromSettings(settings: OutputSettings, override?: string): OutputPlan {
  const plan: OutputPlan = {
    folders: { movie: settings.movie.trim(), tv: settings.tv.trim(), music: settings.music.trim() },
  };
  if (override) plan.override = override;
  return plan;
}

/** The output folder for a file of `kind`, or undefined to rename it in place. */
export function outputDirFor(plan: OutputPlan, kind: OutputKind | undefined): string | undefined {
  if (plan.override) return plan.override;
  if (!kind) return undefined;
  const folder = plan.folders[kind];
  return folder ? folder : undefined;
}

/** True when the plan sends at least one kind somewhere else. */
export function hasOutputFolders(plan: OutputPlan): boolean {
  return Boolean(plan.override) || OUTPUT_KINDS.some((kind) => Boolean(plan.folders[kind]));
}

/**
 * Why an output folder cannot be used:
 * - "not_absolute": the setting is not an absolute path
 * - "missing": the folder does not exist (an unmounted drive, a typo)
 * - "not_directory": the path is a file
 * - "not_writable": no file can be created in it
 */
export type OutputFolderProblem = "not_absolute" | "missing" | "not_directory" | "not_writable";

/** An output folder that cannot be used. Thrown before any file is touched. */
export class OutputFolderError extends ConfigError {
  readonly reason: OutputFolderProblem;
  readonly folder: string;
  /** The kind whose folder it is; undefined for the override folder. */
  readonly kind: OutputKind | undefined;

  constructor(reason: OutputFolderProblem, folder: string, kind: OutputKind | undefined, options?: ErrorOptions) {
    const which = kind ? `The ${OUTPUT_KIND_LABELS[kind]} output folder` : "The output folder";
    const text: Record<OutputFolderProblem, string> = {
      not_absolute: `${which} must be a full path: ${folder}`,
      missing: `${which} doesn't exist (is the drive connected?): ${folder}`,
      not_directory: `${which} is a file, not a folder: ${folder}`,
      not_writable: `${which} can't be written to: ${folder}`,
    };
    super(text[reason], options);
    this.reason = reason;
    this.folder = folder;
    this.kind = kind;
  }
}

const OUTPUT_KIND_LABELS: Record<OutputKind, string> = { movie: "movie", tv: "TV", music: "music" };

export interface CheckOutputFolderOptions {
  /** Create the folder (and its parents) when it is missing. Default false. */
  create?: boolean;
  /** Only report what creating would need; never create (planning, dry runs). Default false. */
  dryRun?: boolean;
}

/**
 * Check that `folder` can take renamed files: absolute, an existing folder
 * (or created, with `create`), and writable. Writability is tested by
 * creating and removing an empty hidden file, the only test that is right
 * on every platform and for network shares.
 * @throws OutputFolderError
 */
export async function checkOutputFolder(
  folder: string,
  kind: OutputKind | undefined,
  { create = false, dryRun = false }: CheckOutputFolderOptions = {},
): Promise<void> {
  if (!path.isAbsolute(folder)) throw new OutputFolderError("not_absolute", folder, kind);
  let isDir: boolean | undefined;
  try {
    isDir = statSync(folder).isDirectory();
  } catch {
    isDir = undefined;
  }
  if (isDir === false) throw new OutputFolderError("not_directory", folder, kind);
  if (isDir === undefined) {
    if (!create) throw new OutputFolderError("missing", folder, kind);
    if (dryRun) return;
    try {
      await mkdir(folder, { recursive: true });
    } catch (error) {
      throw new OutputFolderError("not_writable", folder, kind, { cause: error });
    }
  }

  const probe = path.join(folder, `.tidytitles-write-test-${randomUUID().slice(0, 8)}`);
  try {
    const handle = await open(probe, "wx");
    await handle.close();
  } catch (error) {
    throw new OutputFolderError("not_writable", folder, kind, { cause: error });
  }
  await unlink(probe).catch(() => undefined);
}

/**
 * Check every output folder that `operations` use (pending operations
 * only), before anything is moved.
 * @throws OutputFolderError for the first folder that cannot be used.
 */
export async function checkOutputFolders(
  plan: OutputPlan,
  operations: readonly RenameOperation[],
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const used = new Map<string, OutputKind | undefined>();
  for (const op of operations) {
    if (op.status !== "pending") continue;
    const kind = outputKindFor(op.mediaFile.matchedMetadata);
    const folder = outputDirFor(plan, kind);
    if (folder && !used.has(folder)) used.set(folder, plan.override ? undefined : kind);
  }
  for (const [folder, kind] of used) {
    await checkOutputFolder(folder, kind, { create: folder === plan.override, dryRun: options.dryRun });
  }
}

/**
 * Mark the operations a transfer mode cannot carry out, before renaming:
 * in "hardlink" mode, a file whose destination is on another volume is
 * skipped with `skipReason` "cross_device_link" (no silent fallback to
 * copying). Operations marked by an earlier call for a different mode go
 * back to pending, so the mode can be changed without planning again.
 * Updates in place and returns the same array.
 */
export function applyTransferChecks<T extends PlannedOperation>(operations: T[], mode: TransferMode): T[] {
  for (const op of operations) {
    if (op.status === "skipped" && op.skipReason === "cross_device_link") {
      op.status = "pending";
      delete op.skipReason;
      delete op.errorMessage;
    }
    if (mode === "hardlink" && op.status === "pending" && crossesVolumes(op.source, op.destination)) {
      op.status = "skipped";
      op.skipReason = "cross_device_link";
      op.errorMessage = CROSS_DEVICE_LINK_MESSAGE;
    }
  }
  return operations;
}
