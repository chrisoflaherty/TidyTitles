/**
 * The per-file report of tags and NFO files a rename wrote, for the rename
 * result (`RenameOutcome.metadata`). No Electron imports.
 */

import path from "node:path";
import type { RenameOperation, RenameSession } from "@tidytitles/core";
import type { MetadataFileReport, RenameMetadataReport } from "../shared/ipc";

/** `{ metadata }` when the session wrote tags or NFO files, else `{}`. */
export function metadataReport(
  session: Pick<RenameSession, "writeMetadata">,
  operations: readonly RenameOperation[],
): { metadata?: RenameMetadataReport } {
  const { musicTags, nfo } = session.writeMetadata;
  if (!musicTags && !nfo) return {};
  const files: MetadataFileReport[] = [];
  for (const op of operations) {
    const written = op.metadataWrites;
    if (!written || (!written.tags && !written.nfo?.length)) continue;
    files.push({
      name: path.basename(op.destination),
      ...(written.tags ? { tags: written.tags } : {}),
      ...(written.nfo?.length ? { nfo: written.nfo } : {}),
    });
  }
  return { metadata: { musicTags, nfo, files } };
}
