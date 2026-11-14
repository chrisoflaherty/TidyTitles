import type { AppState } from "../../../shared/ipc";
import { shortcut } from "../format";
import { Icon } from "./Icon";

export function EmptyState({
  app,
  onAddFiles,
  onAddFolder,
  onSettings,
}: {
  app: AppState;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onSettings: () => void;
}) {
  const p = app.platform;
  const noKeys = !app.apiKeys.tmdb && !app.apiKeys.tvdb;
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-icon" aria-hidden="true">
        <Icon name="drop" size={40} />
      </div>
      <h1>Add media files to rename</h1>
      <p>
        Drag movies, TV episodes, or music (files or whole folders) into this window, or add them with the buttons
        below. TidyTitles looks up each file and shows the new name before anything changes.
      </p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={onAddFiles} disabled={app.busy !== null}>
          <Icon name="file-plus" />
          <span>Add Files…</span>
        </button>
        <button type="button" className="btn" onClick={onAddFolder} disabled={app.busy !== null}>
          <Icon name="folder-plus" />
          <span>Add Folder…</span>
        </button>
      </div>
      <ol className="empty-steps">
        <li>
          <strong>Add</strong> files ({shortcut(p, "O")}) or a folder ({shortcut(p, "O", { shift: true })}).
        </li>
        <li>
          <strong>Fetch metadata</strong> ({shortcut(p, "R")}) and pick the right match when asked.
        </li>
        <li>
          <strong>Review</strong> the new names, then <strong>Rename</strong>. You can undo the last rename.
        </li>
      </ol>
      {noKeys && (
        <p className="empty-note" data-testid="no-keys-note">
          <Icon name="info" size={14} />
          <span>
            No TMDB or TVDB API key is set, so only music can be looked up.{" "}
            <button type="button" className="link-button" onClick={onSettings}>
              Add API keys in Settings
            </button>
          </span>
        </p>
      )}
      {app.configError && (
        <p className="empty-note tone-text-error" role="alert">
          <Icon name="alert" size={14} />
          <span>{app.configError}</span>
        </p>
      )}
    </div>
  );
}
