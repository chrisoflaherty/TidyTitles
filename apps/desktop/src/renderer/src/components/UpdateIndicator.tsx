import type { UpdateState } from "../../../shared/ipc";
import { manualReasonText, percentText, updateErrorText } from "../updates";
import { Icon } from "./Icon";

export interface UpdateIndicatorProps {
  state: UpdateState | null;
  /** A fetch, rename, or undo is running: restarting waits. */
  busy: boolean;
  /** The update dialog is open (it shows the check's outcome itself). */
  dialogOpen: boolean;
  dismissedCheckId: number;
  onRestart: () => void;
  onOpenReleasePage: () => void;
  onShowDetails: () => void;
  onDismiss: () => void;
}

/**
 * The quiet, persistent update control in the status bar: download progress,
 * "Restart to Update" when an update is ready, or "Download" when this copy
 * cannot install it. The outcome of a check the user asked for appears here
 * too when the update dialog could not be shown (another dialog was open).
 */
export function UpdateIndicator({
  state,
  busy,
  dialogOpen,
  dismissedCheckId,
  onRestart,
  onOpenReleasePage,
  onShowDetails,
  onDismiss,
}: UpdateIndicatorProps) {
  if (!state) return null;
  const s = state.status;
  const showManualNote = state.manual && !dialogOpen && state.checkId > dismissedCheckId;

  const dismiss = (
    <button type="button" className="update-dismiss" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" data-testid="update-dismiss">
      <Icon name="x" size={12} />
    </button>
  );

  switch (s.kind) {
    case "downloading":
      return (
        <button
          type="button"
          className="update-indicator"
          onClick={onShowDetails}
          title={`Downloading TidyTitles ${s.version}`}
          data-testid="update-indicator"
          data-status="downloading"
        >
          <Icon name="download" size={14} />
          <span>Downloading update</span>
          <progress className="update-mini-progress" max={100} value={s.percent ?? undefined} aria-label="Update download" />
          <span className="update-percent">{percentText(s.percent)}</span>
        </button>
      );
    case "ready":
      return (
        <div className="update-indicator is-ready" data-testid="update-indicator" data-status="ready">
          <span className="update-dot" aria-hidden="true" />
          <span>Update ready</span>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={onRestart}
            disabled={busy}
            title={
              busy
                ? "You can restart when the current task finishes"
                : `Restart to install TidyTitles ${s.version}. If you don’t, it installs when you quit.`
            }
            data-testid="update-indicator-restart"
          >
            <Icon name="restart" size={12} />
            <span>Restart to Update</span>
          </button>
        </div>
      );
    case "unsupported":
      return (
        <div className="update-indicator" data-testid="update-indicator" data-status="unsupported">
          <span className="update-dot" aria-hidden="true" />
          <span title={manualReasonText(s.reason)}>TidyTitles {s.version} is available</span>
          <button
            type="button"
            className="btn btn-small"
            onClick={onOpenReleasePage}
            title="Open the release page in your browser"
            data-testid="update-indicator-download"
          >
            <Icon name="download" size={12} />
            <span>Download</span>
          </button>
        </div>
      );
    case "checking":
      if (!showManualNote) return null;
      return (
        <div className="update-indicator" data-testid="update-indicator" data-status="checking">
          <span>Checking for updates…</span>
        </div>
      );
    case "upToDate":
      if (!showManualNote) return null;
      return (
        <div className="update-indicator" data-testid="update-indicator" data-status="upToDate">
          <Icon name="check" size={14} className="tone-text-success" />
          <span>TidyTitles {state.currentVersion} is up to date</span>
          {dismiss}
        </div>
      );
    case "error":
      if (!showManualNote) return null;
      return (
        <div className="update-indicator" data-testid="update-indicator" data-status="error">
          <Icon name="alert" size={14} className="tone-text-error" />
          <span title={updateErrorText(s.error)}>Couldn’t check for updates</span>
          <button type="button" className="btn btn-small" onClick={onShowDetails} data-testid="update-indicator-details">
            Details
          </button>
          {dismiss}
        </div>
      );
    case "idle":
      return null;
  }
}
