/**
 * The "Write metadata" section of the Settings dialog's Files tab: tags
 * into renamed music files and NFO files for media servers. Edits the
 * `writeMetadata` part of the dialog's draft (`[write_metadata]`).
 */

import type { EditableSettings } from "../../../shared/ipc";

function Toggle({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label className="check check-block">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>
        {label}
        <span className="form-hint block">{hint}</span>
      </span>
    </label>
  );
}

export function WriteMetadataSettings({
  draft,
  update,
}: {
  draft: EditableSettings;
  update: (fn: (d: EditableSettings) => EditableSettings) => void;
}) {
  const set = (patch: Partial<EditableSettings["writeMetadata"]>) =>
    update((d) => ({ ...d, writeMetadata: { ...d.writeMetadata, ...patch } }));
  return (
    <fieldset className="settings-section" data-testid="write-metadata-settings">
      <legend>Write metadata</legend>
      <p className="section-description">
        After renaming, TidyTitles can also store what it found. Both change or add files, and both can be undone.
      </p>
      <Toggle
        label="Write tags into music files"
        hint="Title, artist, album, album artist, track and disc numbers, year, and genre from a MusicBrainz match, only where they differ. MP3, FLAC, M4A, Ogg Vorbis, and Opus; other formats are renamed without tags. Never through hard links. Artwork and other tags stay as they are, and undo puts the old tags back."
        checked={draft.writeMetadata.musicTags}
        onChange={(musicTags) => set({ musicTags })}
        testId="write-music-tags"
      />
      <Toggle
        label="Write NFO files for media servers"
        hint="An .nfo file next to each renamed movie and episode, and tvshow.nfo in a show’s folder, for Kodi, Jellyfin, and Emby (Plex doesn’t read them). Existing NFO files are left alone, unless “Replace the existing file” is chosen above; the video’s own NFO is never replaced. Undo removes the ones it wrote if they are unchanged."
        checked={draft.writeMetadata.nfo}
        onChange={(nfo) => set({ nfo })}
        testId="write-nfo"
      />
    </fieldset>
  );
}
