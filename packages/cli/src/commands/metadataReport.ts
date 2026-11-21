/** How `rename` reports the tags and NFO files it wrote (or would write, with --dry-run). */

import path from "node:path";
import type {
  NfoWriteReason,
  RenameOperation,
  TagChange,
  TagField,
  TagWriteReason,
} from "@tidytitles/core";
import { formatCount } from "../format";
import type { Ui } from "../ui";

export const TAG_FIELD_LABELS: Record<TagField, string> = {
  title: "title",
  artist: "artist",
  album: "album",
  albumArtist: "album artist",
  track: "track",
  disc: "disc",
  year: "year",
  genre: "genre",
};

/** Why tags were not written, in words. */
export function describeTagReason(reason: TagWriteReason | undefined): string {
  switch (reason) {
    case "match_from_tags":
      return "the match came from the file's own tags";
    case "unsupported_format":
      return "tags of this format can't be written";
    case "unsupported_layout":
      return "the file's tags are laid out in a way TidyTitles doesn't write";
    case "hard_link":
      return "hard linked: writing would change the original too";
    case "shared_data":
      return "the file has other hard links, which would keep the old tags";
    case "read_failed":
      return "the file could not be read";
    case "write_failed":
      return "the file could not be written; it is unchanged";
    case "changed_during_write":
      return "another program changed the file meanwhile; it was left as it is";
    case "verify_failed":
      return "the rewritten file did not read back correctly; the original is unchanged";
    default:
      return "not written";
  }
}

/** Why an NFO file was not written, in words. */
export function describeNfoReason(reason: NfoWriteReason | undefined): string {
  switch (reason) {
    case "exists":
      return "a file of that name already exists";
    case "associated_file":
      return "the video's own NFO moved there";
    case "no_show_folder":
      return "the episode is not in a folder of its show";
    case "write_failed":
      return "could not be written";
    default:
      return "not written";
  }
}

function describeChange(c: TagChange): string {
  const label = TAG_FIELD_LABELS[c.field];
  return c.from !== undefined ? `${label} "${c.from}" → "${c.to}"` : `${label} "${c.to}"`;
}

/** Print what was written (or, with `dryRun`, what would be). Nothing when the features are off. */
export function showMetadataResults(ui: Ui, operations: readonly RenameOperation[], dryRun: boolean): void {
  const c = ui.c;
  const withTags = operations.filter((op) => op.metadataWrites?.tags);
  const withNfo = operations.filter((op) => op.metadataWrites?.nfo?.length);
  if (withTags.length === 0 && withNfo.length === 0) return;
  const name = (op: RenameOperation) => path.basename(dryRun ? op.source : op.destination);

  ui.print();
  if (withTags.length > 0) {
    const changed = withTags.filter((op) => ["written", "would_write"].includes(op.metadataWrites!.tags!.status));
    const unchanged = withTags.filter((op) => op.metadataWrites!.tags!.status === "unchanged");
    const notWritten = withTags.filter((op) => ["not_written", "failed"].includes(op.metadataWrites!.tags!.status));
    ui.print(`${c.green(dryRun ? "Tags to write:" : "Tags written:")} ${formatCount(changed.length)} file(s)`);
    for (const op of changed) {
      ui.print(`  ${name(op)}: ${op.metadataWrites!.tags!.changes.map(describeChange).join(", ")}`);
    }
    if (unchanged.length > 0) ui.print(c.dim(`Tags already right: ${formatCount(unchanged.length)} file(s)`));
    if (notWritten.length > 0) {
      ui.print(`${c.yellow("Tags not written:")} ${formatCount(notWritten.length)} file(s)`);
      for (const op of notWritten) {
        const tags = op.metadataWrites!.tags!;
        ui.print(`  ${name(op)}: ${describeTagReason(tags.reason)}${tags.message && tags.status === "failed" ? ` (${tags.message})` : ""}`);
      }
    }
  }
  if (withNfo.length > 0) {
    const all = withNfo.flatMap((op) => op.metadataWrites!.nfo!.map((n) => ({ op, n })));
    const written = all.filter(({ n }) => n.status === "written" || n.status === "would_write");
    const skipped = all.filter(({ n }) => n.status === "not_written" || n.status === "failed");
    ui.print(`${c.green(dryRun ? "NFO files to write:" : "NFO files written:")} ${formatCount(written.length)}`);
    for (const { n } of written) ui.print(`  ${n.path}${n.replaced ? c.dim(" (replaced)") : ""}`);
    if (skipped.length > 0) {
      ui.print(`${c.yellow("NFO files not written:")} ${formatCount(skipped.length)}`);
      for (const { op, n } of skipped) {
        const what = n.path ? path.basename(n.path) : `${n.kind === "tvshow" ? "tvshow.nfo" : "NFO"} for ${name(op)}`;
        ui.print(`  ${what}: ${describeNfoReason(n.reason)}${n.message ? ` (${n.message})` : ""}`);
      }
    }
  }
}
