/**
 * The "Watch" tab of the Settings dialog: `[watch]` in config.toml. Edits the
 * `watch` part of the dialog's draft.
 */

import { useId, useState } from "react";
import {
  MAX_WATCH_FOLDERS,
  SETTLE_SECONDS_RANGE,
  WATCH_MODE_CHOICES,
  type EditableSettings,
} from "../../../shared/ipc";
import { getApi } from "../api";
import { formatCount } from "../format";

type Mode = (typeof WATCH_MODE_CHOICES)[number];

const MODE_LABELS: Record<Mode, { label: string; hint: string }> = {
  review: {
    label: "Review before renaming",
    hint: "New files are added to the list and their metadata is fetched. Nothing is renamed until you click Rename.",
  },
  automatic: {
    label: "Rename automatically when the match is certain",
    hint:
      "A file is renamed without asking only when the lookup finds exactly one match and nothing already has its new name. " +
      "Files with several matches, no match, a failed lookup, or a name that is taken are added to the list for review. " +
      "Automatic renames are saved in History and can be undone.",
  },
};

export function WatchSettings({
  draft,
  update,
}: {
  draft: EditableSettings;
  update: (fn: (d: EditableSettings) => EditableSettings) => void;
}) {
  const api = getApi();
  const settleId = useId();
  const watch = draft.watch;
  const setWatch = (patch: Partial<EditableSettings["watch"]>) => update((d) => ({ ...d, watch: { ...d.watch, ...patch } }));
  const [settleText, setSettleText] = useState(String(watch.settleSeconds));
  const typed = Number(settleText);
  const settleValid = /^\s*\d+\s*$/.test(settleText) && typed >= SETTLE_SECONDS_RANGE.min && typed <= SETTLE_SECONDS_RANGE.max;
  const changeSettle = (text: string) => {
    setSettleText(text);
    const n = Number(text);
    if (/^\s*\d+\s*$/.test(text) && n >= SETTLE_SECONDS_RANGE.min && n <= SETTLE_SECONDS_RANGE.max) setWatch({ settleSeconds: n });
  };

  const addFolder = async () => {
    const folder = await api.chooseWatchFolder(watch.folders.at(-1));
    if (!folder) return;
    update((d) =>
      d.watch.folders.includes(folder) || d.watch.folders.length >= MAX_WATCH_FOLDERS
        ? d
        : { ...d, watch: { ...d.watch, folders: [...d.watch.folders, folder] } },
    );
  };
  const removeFolder = (folder: string) =>
    update((d) => ({ ...d, watch: { ...d.watch, folders: d.watch.folders.filter((f) => f !== folder) } }));

  return (
    <>
      <fieldset className="settings-section">
        <legend>Watch folders</legend>
        <p className="section-description">
          TidyTitles can notice new media files arriving in folders you choose, such as a downloads folder, and look
          them up for you. Watching runs only while TidyTitles is open: there is no background service or login item,
          and quitting the app stops it.
        </p>
        <label className="check check-block">
          <input
            type="checkbox"
            checked={watch.enabled}
            onChange={(e) => setWatch({ enabled: e.target.checked })}
            data-testid="watch-enabled"
          />
          <span>Watch these folders while TidyTitles is open</span>
        </label>
        <ul className="watch-folder-list" data-testid="watch-folders">
          {watch.folders.length === 0 && <li className="muted">No folders yet.</li>}
          {watch.folders.map((folder) => (
            <li key={folder}>
              <span className="mono selectable watch-folder-path" title={folder}>
                {folder}
              </span>
              <button type="button" className="btn btn-small" onClick={() => removeFolder(folder)} aria-label={`Stop watching ${folder}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="watch-folder-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void addFolder()}
            disabled={watch.folders.length >= MAX_WATCH_FOLDERS}
            data-testid="watch-add-folder"
          >
            Add Folder…
          </button>
        </div>
        <label className="check check-block">
          <input type="checkbox" checked={watch.recursive} onChange={(e) => setWatch({ recursive: e.target.checked })} data-testid="watch-recursive" />
          <span>Include subfolders</span>
        </label>
        <p className="form-hint">
          Files already in a folder when watching starts are left alone; you can process them from the watch activity
          in the status bar. Output folders inside a watched folder are never watched, and files TidyTitles renamed are
          never picked up again.
        </p>
      </fieldset>

      <fieldset className="settings-section">
        <legend>When a new file has arrived</legend>
        <div role="radiogroup" aria-label="When a new file has arrived" className="radio-group">
          {WATCH_MODE_CHOICES.map((mode) => (
            <label key={mode} className="check check-block">
              <input
                type="radio"
                name="watch-mode"
                value={mode}
                checked={watch.mode === mode}
                onChange={() => setWatch({ mode })}
                data-testid={`watch-mode-${mode}`}
              />
              <span>
                {MODE_LABELS[mode].label}
                <span className="form-hint block">{MODE_LABELS[mode].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="form-grid">
          <label htmlFor={settleId}>Wait until unchanged for</label>
          <span className="input-with-unit">
            <input
              id={settleId}
              type="number"
              min={SETTLE_SECONDS_RANGE.min}
              max={SETTLE_SECONDS_RANGE.max}
              step={1}
              value={settleText}
              aria-invalid={!settleValid}
              onChange={(e) => changeSettle(e.target.value)}
              className="input-number"
              data-testid="watch-settle"
            />
            <span className="muted">seconds</span>
          </span>
        </div>
        <p className={`form-hint${settleValid ? "" : " tone-text-error"}`}>
          {settleValid
            ? "A file is touched only after its size and modification time have stopped changing this long, so copies and downloads are complete. Temporary download names (.part, .crdownload, .download, .!qB, .tmp) are never touched. Use a longer wait for slow network shares."
            : `Enter a whole number of seconds from ${formatCount(SETTLE_SECONDS_RANGE.min)} to ${formatCount(SETTLE_SECONDS_RANGE.max)}. Until then, ${formatCount(watch.settleSeconds)} is used.`}
        </p>
      </fieldset>
    </>
  );
}
