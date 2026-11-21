/**
 * Tags and NFO files (`[write_metadata]`) in the rename confirmation, the
 * rename result, and the undo result. Branches on typed fields only.
 */

import type {
  CreatedFileUndoOutcome,
  NfoWriteReason,
  PlannedOperation,
  Settings,
  TagChange,
  TagField,
  TagWriteReason,
  TransferMode,
} from "@tidytitles/core";
import type { RenameMetadataReport, UndoItemView } from "../../../shared/ipc";
import { formatCount, plural } from "../format";

const MUSIC_EXTENSIONS = /\.(mp3|flac|m4a|ogg|oga|opus|wav|aiff|wma|aac|ape)$/i;

const FIELD_LABELS: Record<TagField, string> = {
  title: "title",
  artist: "artist",
  album: "album",
  albumArtist: "album artist",
  track: "track",
  disc: "disc",
  year: "year",
  genre: "genre",
};

export const TAG_REASON_TEXT: Record<TagWriteReason, string> = {
  match_from_tags: "the match came from the file’s own tags",
  unsupported_format: "tags of this format can’t be written",
  unsupported_layout: "its tags are laid out in a way TidyTitles doesn’t write",
  hard_link: "hard linked: writing would change the original too",
  shared_data: "the file has other hard links, which would keep the old tags",
  read_failed: "the file couldn’t be read",
  write_failed: "the file couldn’t be written; it is unchanged",
  changed_during_write: "another app changed the file meanwhile; it was left as it is",
  verify_failed: "the new file didn’t read back correctly; the original is unchanged",
};

export const NFO_REASON_TEXT: Record<NfoWriteReason, string> = {
  exists: "a file of that name is already there",
  associated_file: "the video’s own NFO moved there",
  no_show_folder: "the episode isn’t in a folder of its show",
  write_failed: "couldn’t be written",
};

const CREATED_KEPT_TEXT: Record<NonNullable<CreatedFileUndoOutcome["reason"]>, string> = {
  changed: "left in place, because it was changed after the rename",
  in_use: "left in place, because other episodes in its folder use it",
};

function describeChange(c: TagChange): string {
  return c.from !== undefined ? `${FIELD_LABELS[c.field]} “${c.from}” → “${c.to}”` : `${FIELD_LABELS[c.field]} “${c.to}”`;
}

/** What the rename will also write, for the confirmation dialog. */
export function MetadataConfirmNote({
  ready,
  settings,
  transfer,
}: {
  ready: readonly PlannedOperation[];
  settings: Settings["writeMetadata"];
  transfer: TransferMode;
}) {
  const music = ready.filter((op) => op.mediaFile.matchedMetadata?.kind === "track" || MUSIC_EXTENSIONS.test(op.source)).length;
  const videos = ready.filter((op) => {
    const kind = op.mediaFile.matchedMetadata?.kind;
    return kind === "movie" || kind === "episode";
  }).length;
  const lines: string[] = [];
  if (settings.musicTags && music > 0) {
    lines.push(
      transfer === "hardlink"
        ? `Tags won’t be written into the ${plural(music, "music file")}: they are hard linked, so the originals would change too.`
        : `Tags from MusicBrainz matches will be written into the ${plural(music, "music file")} where they differ${transfer === "copy" ? " (into the copies only)" : ""}.`,
    );
  }
  if (settings.nfo && videos > 0) lines.push(`NFO files will be written for ${plural(videos, "video")}.`);
  if (lines.length === 0) return null;
  return (
    <div data-testid="confirm-metadata">
      {lines.map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
    </div>
  );
}

/** Per-file tags and NFO files after a rename. */
export function MetadataResultList({ report }: { report: RenameMetadataReport }) {
  const tagged = report.files.filter((f) => f.tags?.status === "written");
  const unchanged = report.files.filter((f) => f.tags?.status === "unchanged");
  const tagProblems = report.files.filter((f) => f.tags && (f.tags.status === "not_written" || f.tags.status === "failed"));
  const nfo = report.files.flatMap((f) => (f.nfo ?? []).map((n) => ({ file: f.name, n })));
  const nfoWritten = nfo.filter(({ n }) => n.status === "written");
  const nfoSkipped = nfo.filter(({ n }) => n.status === "not_written" || n.status === "failed");
  if (report.files.length === 0) return null;
  return (
    <div className="metadata-result" data-testid="rename-metadata">
      <dl className="summary">
        {report.musicTags && (
          <div className="summary-row tone-text-success">
            <dt>Tags written</dt>
            <dd data-testid="tags-written">{formatCount(tagged.length)}</dd>
          </div>
        )}
        {unchanged.length > 0 && (
          <div className="summary-row">
            <dt>Tags already right</dt>
            <dd>{formatCount(unchanged.length)}</dd>
          </div>
        )}
        {tagProblems.length > 0 && (
          <div className="summary-row tone-text-warning">
            <dt>Tags not written</dt>
            <dd>{formatCount(tagProblems.length)}</dd>
          </div>
        )}
        {report.nfo && (
          <div className="summary-row tone-text-success">
            <dt>NFO files written</dt>
            <dd data-testid="nfo-written">{formatCount(nfoWritten.length)}</dd>
          </div>
        )}
        {nfoSkipped.length > 0 && (
          <div className="summary-row tone-text-warning">
            <dt>NFO files not written</dt>
            <dd>{formatCount(nfoSkipped.length)}</dd>
          </div>
        )}
      </dl>
      {(tagged.length > 0 || tagProblems.length > 0 || nfoSkipped.length > 0) && (
        <ul className="failure-list metadata-list" data-testid="metadata-details">
          {tagged.map((f) => (
            <li key={`t-${f.name}`}>
              <strong>{f.name}</strong>: {f.tags!.changes.map(describeChange).join(", ")}
            </li>
          ))}
          {tagProblems.map((f) => (
            <li key={`p-${f.name}`}>
              <strong>{f.name}</strong>: tags not written; {f.tags!.reason ? TAG_REASON_TEXT[f.tags!.reason] : "unknown reason"}
            </li>
          ))}
          {nfoSkipped.map(({ file, n }) => (
            <li key={`n-${file}-${n.kind}`}>
              <strong>{n.path ? n.path.split(/[\\/]/).pop() : n.kind === "tvshow" ? "tvshow.nfo" : `NFO for ${file}`}</strong>:{" "}
              {n.reason ? NFO_REASON_TEXT[n.reason] : "not written"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tags put back and NFO files removed by an undo. */
export function MetadataUndoList({ items }: { items: readonly UndoItemView[] }) {
  const restored = items.filter((i) => i.tags?.status === "restored").length;
  const notRestored = items.filter((i) => i.tags?.status === "not_restored");
  const created = items.flatMap((i) => i.createdFiles ?? []);
  const removed = created.filter((c) => c.status === "removed").length;
  const kept = created.filter((c) => c.status === "kept" || c.status === "failed");
  if (restored === 0 && notRestored.length === 0 && created.length === 0) return null;
  return (
    <div className="metadata-result" data-testid="undo-metadata">
      <dl className="summary">
        {(restored > 0 || notRestored.length > 0) && (
          <div className="summary-row">
            <dt>Tags put back</dt>
            <dd>{formatCount(restored)}</dd>
          </div>
        )}
        {created.length > 0 && (
          <div className="summary-row">
            <dt>NFO files removed</dt>
            <dd>{formatCount(removed)}</dd>
          </div>
        )}
      </dl>
      {(notRestored.length > 0 || kept.length > 0) && (
        <ul className="failure-list metadata-list">
          {notRestored.map((i) => (
            <li key={`t-${i.name}`}>
              <strong>{i.name}</strong>:{" "}
              {i.tags!.reason === "changed"
                ? "tags left as they are, because the file was changed after the rename"
                : `tags not put back${i.tags!.message ? ` (${i.tags!.message})` : ""}`}
            </li>
          ))}
          {kept.map((c) => (
            <li key={`c-${c.name}-${c.kind}`}>
              <strong>{c.name}</strong>: {c.status === "failed" ? `couldn’t be removed${c.message ? ` (${c.message})` : ""}` : CREATED_KEPT_TEXT[c.reason ?? "changed"]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
