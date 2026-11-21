/**
 * The "Output" tab of the Settings dialog: output folders per media type,
 * the default transfer mode, and how many renames the history keeps. Edits
 * the `output` and `history` parts of the dialog's draft.
 */

import { useId, useState } from "react";
import {
  HISTORY_LIMIT_RANGE,
  TRANSFER_MODE_CHOICES,
  type EditableSettings,
} from "../../../shared/ipc";
import { getApi } from "../api";
import { OUTPUT_KIND_LABELS, TRANSFER_LABELS, type OutputKindView } from "../destination";
import { formatCount } from "../format";

const KIND_HINTS: Record<OutputKindView, string> = {
  movie: "Matched movies",
  tv: "Matched TV episodes",
  music: "Matched music",
};

function FolderField({
  kind,
  value,
  onChange,
}: {
  kind: OutputKindView;
  value: string;
  onChange: (value: string) => void;
}) {
  const api = getApi();
  const id = useId();
  const choose = async () => {
    const folder = await api.chooseFolder(value || undefined);
    if (folder) onChange(folder);
  };
  return (
    <>
      <label htmlFor={id}>{OUTPUT_KIND_LABELS[kind]}</label>
      <div className="folder-field">
        <input
          id={id}
          type="text"
          className="mono"
          value={value}
          placeholder="Same folder as the original"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint`}
          data-testid={`output-${kind}`}
        />
        <button type="button" className="btn" onClick={() => void choose()} data-testid={`output-${kind}-choose`}>
          Choose…
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onChange("")}
          disabled={value === ""}
          title="Rename these files where they are"
          data-testid={`output-${kind}-clear`}
        >
          Clear
        </button>
        <span id={`${id}-hint`} className="visually-hidden">
          {KIND_HINTS[kind]} go here. Leave empty to rename them where they are.
        </span>
      </div>
    </>
  );
}

export function OutputSettings({
  draft,
  update,
}: {
  draft: EditableSettings;
  update: (fn: (d: EditableSettings) => EditableSettings) => void;
}) {
  const historyId = useId();
  const setOutput = (patch: Partial<EditableSettings["output"]>) =>
    update((d) => ({ ...d, output: { ...d.output, ...patch } }));
  // What is typed; the draft only takes valid numbers, so Save never sends a bad one.
  const [maxText, setMaxText] = useState(String(draft.history.maxEntries));
  const typed = Number(maxText);
  const maxValid =
    /^\s*\d+\s*$/.test(maxText) && typed >= HISTORY_LIMIT_RANGE.min && typed <= HISTORY_LIMIT_RANGE.max;
  const changeMax = (text: string) => {
    setMaxText(text);
    const n = Number(text);
    if (/^\s*\d+\s*$/.test(text) && n >= HISTORY_LIMIT_RANGE.min && n <= HISTORY_LIMIT_RANGE.max) {
      update((d) => ({ ...d, history: { maxEntries: n } }));
    }
  };

  return (
    <>
      <fieldset className="settings-section">
        <legend>Output folders</legend>
        <p className="section-description">
          Renamed files go into these folders, keeping any folders the template adds (such as “Artist/Album”). Leave
          one empty to rename those files where they are. If a folder is missing (for example, a drive isn’t
          connected), nothing is renamed.
        </p>
        <div className="form-grid">
          {(["movie", "tv", "music"] as const).map((kind) => (
            <FolderField key={kind} kind={kind} value={draft.output[kind]} onChange={(v) => setOutput({ [kind]: v })} />
          ))}
        </div>
      </fieldset>

      <fieldset className="settings-section">
        <legend>How files get their new names</legend>
        <p className="section-description">The default for the Transfer option in the main window.</p>
        <div role="radiogroup" aria-label="How files get their new names" className="radio-group">
          {TRANSFER_MODE_CHOICES.map((mode) => (
            <label key={mode} className="check check-block">
              <input
                type="radio"
                name="transfer-mode"
                value={mode}
                checked={draft.output.transferMode === mode}
                onChange={() => setOutput({ transferMode: mode })}
                data-testid={`transfer-${mode}`}
              />
              <span>
                {TRANSFER_LABELS[mode].label}
                <span className="form-hint block">{TRANSFER_LABELS[mode].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="form-hint">
          Undo removes copies and links it made, only if they are unchanged, and never touches the originals.
        </p>
      </fieldset>

      <fieldset className="settings-section">
        <legend>Rename history</legend>
        <div className="form-grid">
          <label htmlFor={historyId}>Renames to keep</label>
          <input
            id={historyId}
            type="number"
            min={HISTORY_LIMIT_RANGE.min}
            max={HISTORY_LIMIT_RANGE.max}
            step={1}
            value={maxText}
            aria-invalid={!maxValid}
            onChange={(e) => changeMax(e.target.value)}
            className="input-number"
            data-testid="history-limit"
          />
        </div>
        <p className={`form-hint${maxValid ? "" : " tone-text-error"}`}>
          {maxValid
            ? "Each rename you can undo from History. Older ones are dropped as new ones are added."
            : `Enter a whole number from ${formatCount(HISTORY_LIMIT_RANGE.min)} to ${formatCount(HISTORY_LIMIT_RANGE.max)}. Until then, ${formatCount(draft.history.maxEntries)} is kept.`}
        </p>
      </fieldset>
    </>
  );
}
