import type { AppState, ProgressEvent, ProgressPhase } from "../../../shared/ipc";
import { formatCount, plural } from "../format";
import { listCounts } from "../state";
import { Icon, type IconName } from "./Icon";

const PHASE_LABEL: Record<ProgressPhase, string> = {
  parse: "Reading",
  fetch: "Fetching",
  rename: "Renaming",
  coverArt: "Downloading cover art",
  undo: "Undoing",
};

const TONE_ICON: Record<AppState["status"]["tone"], IconName> = {
  info: "info",
  success: "check",
  warning: "alert",
  error: "x",
};

export function StatusBar({
  app,
  progress,
  onCancelFetch,
}: {
  app: AppState;
  progress: ProgressEvent | null;
  onCancelFetch: () => void;
}) {
  const counts = listCounts(app);
  const parts = [plural(counts.files, "file")];
  if (app.plan === "planned") {
    parts.push(`${formatCount(counts.ready)} ready`);
    if (counts.skipped) parts.push(`${formatCount(counts.skipped)} skipped`);
  } else if (app.plan === "renamed") {
    parts.push(`${formatCount(counts.completed)} renamed`);
    if (counts.failed) parts.push(`${formatCount(counts.failed)} failed`);
  }

  const showProgress = app.busy !== null && app.busy !== "saving" && app.busy !== "adding";
  return (
    <footer className="status-bar">
      <div className={`status-message tone-text-${app.status.tone}`} role="status" aria-live="polite" data-testid="status-message">
        {!showProgress && <Icon name={TONE_ICON[app.status.tone]} size={14} />}
        <span className="status-text">
          {showProgress && progress ? `${PHASE_LABEL[progress.phase]} ${formatCount(progress.current)} of ${formatCount(progress.total)}: ${progress.message.replace(/^[A-Za-z ]+: /, "")}` : app.status.text}
        </span>
      </div>
      {showProgress && (
        <div className="status-progress">
          <progress
            max={progress?.total || 1}
            value={progress ? progress.current : undefined}
            aria-label={progress ? PHASE_LABEL[progress.phase] : "Working"}
          />
          {app.busy === "fetching" && (
            <button type="button" className="btn btn-small" onClick={onCancelFetch} data-testid="status-stop">
              Stop
            </button>
          )}
        </div>
      )}
      <div className="status-counts">{parts.join(" · ")}</div>
    </footer>
  );
}
