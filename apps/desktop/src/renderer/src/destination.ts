/**
 * Where a planned file goes, for display: whether it leaves its folder, and
 * a short label that still says where (the output folder's name, then the
 * path inside it). Pure functions; paths use either separator.
 */

import type { PlannedOperation, TransferMode } from "@tidytitles/core";
import type { OutputFolders } from "../../shared/ipc";
import { baseName, dirName, relativeTo } from "./format";

export type OutputKindView = keyof OutputFolders;

export const OUTPUT_KIND_LABELS: Record<OutputKindView, string> = { movie: "Movies", tv: "TV", music: "Music" };

export const TRANSFER_LABELS: Record<TransferMode, { label: string; verb: string; hint: string }> = {
  move: { label: "Move", verb: "Rename", hint: "Rename the files (moving them when they go to another folder)." },
  copy: { label: "Copy", verb: "Copy", hint: "Make renamed copies; the originals stay as they are." },
  hardlink: {
    label: "Hard link",
    verb: "Link",
    hint: "Add the new name as a hard link: no extra space, the originals stay. Only within one drive.",
  },
};

/** The output kind of a planned operation (by its match). */
export function kindOf(op: PlannedOperation): OutputKindView | undefined {
  switch (op.mediaFile.matchedMetadata?.kind) {
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

/** The configured output folder for an operation, or undefined (renamed in place). */
export function outputFolderFor(op: PlannedOperation, output: OutputFolders | undefined): string | undefined {
  const kind = kindOf(op);
  const folder = kind && output ? output[kind].trim() : "";
  return folder ? folder : undefined;
}

function isInside(dir: string, target: string): boolean {
  return relativeTo(dir, target) !== target;
}

export interface DestinationView {
  /** What to show: relative to the source folder, or "<output folder name>/<path inside it>". */
  text: string;
  /** True when the file leaves the folder it is in. */
  elsewhere: boolean;
}

/** How to show `destination` for a file that is now at `source`. */
export function destinationView(source: string, destination: string, outputFolder: string | undefined): DestinationView {
  const sourceDir = dirName(source);
  if (isInside(sourceDir, destination)) return { text: relativeTo(sourceDir, destination), elsewhere: false };
  if (outputFolder && isInside(outputFolder, destination)) {
    return { text: `${baseName(outputFolder)}/${relativeTo(outputFolder, destination)}`, elsewhere: true };
  }
  return { text: destination, elsewhere: true };
}

/** Short names of the output folders in use ("Movies → Films, TV → Shows"), or null when none is set. */
export function outputSummary(output: OutputFolders | undefined): { text: string; detail: string } | null {
  if (!output) return null;
  const set = (Object.keys(OUTPUT_KIND_LABELS) as OutputKindView[]).filter((k) => output[k].trim() !== "");
  if (set.length === 0) return null;
  return {
    text: set.map((k) => `${OUTPUT_KIND_LABELS[k]} → ${baseName(output[k].trim())}`).join(", "),
    detail: set.map((k) => `${OUTPUT_KIND_LABELS[k]}: ${output[k].trim()}`).join("\n"),
  };
}
