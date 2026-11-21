import { useEffect, useState } from "react";
import type { MediaTypeChoice, ProviderChoice, TransferMode } from "@tidytitles/core";
import { TRANSFER_MODE_CHOICES, type AppState, type RunOptions } from "../../../shared/ipc";
import { TRANSFER_LABELS, outputSummary } from "../destination";
import { formatTimestamp, shortcut } from "../format";
import { availability } from "../state";
import { MEDIA_TYPE_LABELS, MEDIA_TYPE_ORDER, providerLabel } from "../status";
import { Icon, type IconName } from "./Icon";

export interface ToolbarHandlers {
  onAddFiles: () => void;
  onAddFolder: () => void;
  onClear: () => void;
  onSettings: () => void;
  onUndo: () => void;
  onFetch: () => void;
  onCancelFetch: () => void;
  onRename: () => void;
  onOptions: (options: Partial<RunOptions>) => void;
  /** Open the rename history. */
  onHistory?: () => void;
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  compact,
  title,
  testId,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  /** Hide the label at narrow widths (it stays as the accessible name). */
  compact?: boolean;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`btn${primary ? " btn-primary" : ""}${compact ? " btn-compact" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={compact ? label : undefined}
      data-testid={testId}
    >
      <Icon name={icon} />
      <span className="btn-label">{label}</span>
    </button>
  );
}

export function Toolbar({ app, handlers }: { app: AppState; handlers: ToolbarHandlers }) {
  const can = availability(app);
  const p = app.platform;
  const fetching = app.busy === "fetching";
  const planned = app.plan === "planned";
  const ready = app.operations?.filter((op) => op.status === "pending").length ?? 0;
  const undoTitle = app.lastRename
    ? `Undo the rename from ${formatTimestamp(app.lastRename.timestamp)}`
    : "Nothing to undo";

  return (
    <div className="toolbar" role="toolbar" aria-label="Main">
      <div className="toolbar-group">
        <ToolButton icon="file-plus" label="Add Files…" compact onClick={handlers.onAddFiles} disabled={!can.add} title={`Add files (${shortcut(p, "O")})`} testId="add-files" />
        <ToolButton icon="folder-plus" label="Add Folder…" compact onClick={handlers.onAddFolder} disabled={!can.add} title={`Add a folder (${shortcut(p, "O", { shift: true })})`} testId="add-folder" />
        <ToolButton icon="trash" label="Clear" compact onClick={handlers.onClear} disabled={!can.clear} title="Clear the list" testId="clear" />
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-group">
        <ToolButton icon="gear" label="Settings" compact onClick={handlers.onSettings} disabled={!can.settings} title={`Settings (${shortcut(p, ",")})`} testId="settings" />
        <ToolButton icon="undo" label="Undo" compact onClick={handlers.onUndo} disabled={!can.undo} title={undoTitle} testId="undo" />
        {handlers.onHistory && (
          <ToolButton icon="history" label="History" compact onClick={handlers.onHistory} disabled={!can.history} title="Rename history: undo an earlier rename" testId="history" />
        )}
        {fetching ? (
          <ToolButton icon="stop" label="Stop" onClick={handlers.onCancelFetch} title={`Stop fetching (${p === "darwin" ? "⌘." : "Esc"})`} testId="stop-fetch" />
        ) : (
          <ToolButton
            icon="search"
            label="Fetch Metadata"
            onClick={handlers.onFetch}
            disabled={!can.fetch}
            primary={!planned}
            title={`Look up metadata for the list (${shortcut(p, "R")})`}
            testId="fetch"
          />
        )}
        <ToolButton
          icon="rename"
          label={ready > 0 && planned ? `${TRANSFER_LABELS[app.options.transferMode].verb} ${ready}` : TRANSFER_LABELS[app.options.transferMode].verb}
          onClick={handlers.onRename}
          disabled={!can.rename}
          primary={planned}
          title={`Rename the files (${shortcut(p, p === "darwin" ? "↩" : "Enter")})`}
          testId="rename"
        />
      </div>
    </div>
  );
}

export function OptionsBar({
  app,
  onOptions,
  onOutputSettings,
}: {
  app: AppState;
  onOptions: (options: Partial<RunOptions>) => void;
  /** Open the output folder settings. */
  onOutputSettings?: () => void;
}) {
  const disabled = app.busy !== null;
  // Show a change at once; main's state (which may adjust it) replaces it.
  const [options, setLocal] = useState(app.options);
  const { mediaType, provider, recursive, coverArt, transferMode } = app.options;
  useEffect(
    () => setLocal({ mediaType, provider, recursive, coverArt, transferMode }),
    [mediaType, provider, recursive, coverArt, transferMode],
  );
  const output = outputSummary(app.output);
  const change = (next: Partial<RunOptions>) => {
    setLocal((current) => ({ ...current, ...next }));
    onOptions(next);
  };
  return (
    <div className="options-bar">
      <label className="field-inline">
        <span>Type</span>
        <select
          value={options.mediaType}
          disabled={disabled}
          onChange={(e) => change({ mediaType: e.target.value as MediaTypeChoice })}
          data-testid="media-type"
        >
          {MEDIA_TYPE_ORDER.map((choice) => (
            <option key={choice} value={choice}>
              {MEDIA_TYPE_LABELS[choice]}
            </option>
          ))}
        </select>
      </label>
      <label className="field-inline">
        <span>Provider</span>
        <select
          value={options.provider}
          disabled={disabled}
          onChange={(e) => change({ provider: e.target.value as ProviderChoice })}
          data-testid="provider"
        >
          {app.providerChoices.map((choice) => (
            <option key={choice} value={choice}>
              {providerLabel(choice, app.apiKeys)}
            </option>
          ))}
        </select>
      </label>
      <label className="check" title="Scan subfolders when adding folders">
        <input
          type="checkbox"
          checked={options.recursive}
          disabled={disabled}
          onChange={(e) => change({ recursive: e.target.checked })}
          data-testid="recursive"
        />
        <span>Include subfolders</span>
      </label>
      <label className="check" title="Download movie posters and album covers after renaming">
        <input
          type="checkbox"
          checked={options.coverArt}
          disabled={disabled}
          onChange={(e) => change({ coverArt: e.target.checked })}
          data-testid="cover-art"
        />
        <span>Download cover art</span>
      </label>
      <label className="field-inline" title={TRANSFER_LABELS[options.transferMode].hint}>
        <span>Transfer</span>
        <select
          value={options.transferMode}
          disabled={disabled}
          onChange={(e) => change({ transferMode: e.target.value as TransferMode })}
          data-testid="transfer-mode"
        >
          {TRANSFER_MODE_CHOICES.map((mode) => (
            <option key={mode} value={mode}>
              {TRANSFER_LABELS[mode].label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={`output-chip${output ? " is-set" : ""}`}
        onClick={onOutputSettings}
        disabled={disabled || !onOutputSettings}
        title={output ? `Renamed files go to:\n${output.detail}\n\nClick to change.` : "Renamed files stay in their folders. Click to choose output folders."}
        data-testid="output-chip"
      >
        <Icon name="folder-out" size={13} />
        <span className="output-chip-label">Output</span>
        <span className="output-chip-value">{output ? output.text : "Same folders"}</span>
      </button>
    </div>
  );
}
