import { useEffect, useRef, type ReactNode } from "react";
import type { UpdateState } from "../../../shared/ipc";
import { dialogStatus, manualReasonText, percentText, updateErrorText, updatesOffText } from "../updates";
import { Dialog } from "./Dialog";
import { Icon, type IconName } from "./Icon";

export interface UpdateDialogProps {
  state: UpdateState;
  sinceCheckId: number;
  /** A fetch, rename, or undo is running: restarting waits. */
  busy: boolean;
  onClose: () => void;
  onRestart: () => void;
  onOpenReleasePage: () => void;
  onCheckAgain: () => void;
}

function Lead({ icon, tone, children }: { icon: IconName; tone?: string; children: ReactNode }) {
  return (
    <p className="result-lead update-lead">
      <Icon name={icon} className={tone ? `tone-text-${tone}` : undefined} />
      <span>{children}</span>
    </p>
  );
}

/** "Check for Updates…": live feedback for every outcome of the check it started. */
export function UpdateDialog({ state, sinceCheckId, busy, onClose, onRestart, onOpenReleasePage, onCheckAgain }: UpdateDialogProps) {
  const status = dialogStatus(state, sinceCheckId);
  const current = state.currentVersion;
  const bodyRef = useRef<HTMLDivElement>(null);

  // showModal() focuses the first button; move focus to this state's main action.
  useEffect(() => {
    bodyRef.current?.closest("dialog")?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")?.focus();
  }, [status.kind, busy]);

  let body: ReactNode;
  let actions: ReactNode;
  const close = (label: string, primary = false) => (
    <button
      type={primary ? "submit" : "button"}
      className={`btn${primary ? " btn-primary" : ""}`}
      onClick={primary ? undefined : onClose}
      data-autofocus={primary ? "" : undefined}
      data-testid="update-close"
    >
      {label}
    </button>
  );
  const releases = (label: string, primary = false) => (
    <button
      type="button"
      className={`btn${primary ? " btn-primary" : ""}`}
      onClick={onOpenReleasePage}
      data-autofocus={primary ? "" : undefined}
      data-testid="update-download"
    >
      <Icon name={primary ? "download" : "external"} size={14} />
      <span>{label}</span>
    </button>
  );

  switch (status.kind) {
    case "idle":
    case "checking":
      body = (
        <>
          <Lead icon="search">Checking for updates…</Lead>
          <div className="update-indeterminate" role="progressbar" aria-label="Checking for updates">
            <span />
          </div>
        </>
      );
      actions = close("Cancel", true);
      break;
    case "upToDate":
      body = (
        <>
          <Lead icon="check" tone="success">
            TidyTitles is up to date.
          </Lead>
          <p className="muted">
            You have version <span className="selectable">{current}</span>, the newest version available.
          </p>
        </>
      );
      actions = close("OK", true);
      break;
    case "downloading":
      body = (
        <>
          <Lead icon="download">Downloading TidyTitles {status.version}…</Lead>
          <div className="update-progress-row">
            <progress
              className="update-progress"
              max={100}
              value={status.percent ?? undefined}
              aria-label={`Downloading TidyTitles ${status.version}`}
            />
            <span className="update-percent" data-testid="update-percent">
              {percentText(status.percent)}
            </span>
          </div>
          <p className="muted small">You can keep working. TidyTitles shows a Restart to Update button when the update is ready.</p>
        </>
      );
      actions = close("Hide", true);
      break;
    case "ready":
      body = (
        <>
          <Lead icon="check" tone="success">
            TidyTitles {status.version} is ready to install.
          </Lead>
          <p className="muted">Restart now to update, or the update installs the next time you quit TidyTitles.</p>
          {busy && (
            <p className="notice tone-info" role="status">
              <Icon name="info" size={14} />
              <span>You can restart when the current task finishes.</span>
            </p>
          )}
        </>
      );
      actions = (
        <>
          {close("Later")}
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRestart}
            disabled={busy}
            data-autofocus=""
            data-testid="update-restart"
          >
            <Icon name="restart" size={14} />
            <span>Restart to Update</span>
          </button>
        </>
      );
      break;
    case "unsupported":
      body = (
        <>
          <Lead icon="info" tone="info">
            TidyTitles {status.version} is available.
          </Lead>
          <p>{manualReasonText(status.reason)} Download the new version from the releases page and install it over this one.</p>
          <p className="muted small">
            You have version <span className="selectable">{current}</span>.
          </p>
        </>
      );
      actions = (
        <>
          {close("Close")}
          {releases("Download", true)}
        </>
      );
      break;
    case "error":
      body = (
        <>
          <Lead icon="alert" tone="error">
            Couldn’t check for updates.
          </Lead>
          <p>{updateErrorText(status.error)}</p>
          <p className="muted small">
            You have version <span className="selectable">{current}</span>.
          </p>
        </>
      );
      actions = (
        <>
          <button type="button" className="btn" onClick={onCheckAgain} data-testid="update-retry">
            Try Again
          </button>
          {releases("Open Releases Page")}
          {close("Close", true)}
        </>
      );
      break;
    case "off":
      body = (
        <>
          <Lead icon="info">Updates are turned off.</Lead>
          <p>{state.capability.kind === "off" ? updatesOffText(state.capability.reason) : ""}</p>
          <p className="muted small">
            You have version <span className="selectable">{current}</span>.
          </p>
        </>
      );
      actions = (
        <>
          {releases("Open Releases Page")}
          {close("OK", true)}
        </>
      );
      break;
  }

  return (
    <Dialog
      title="Software Update"
      className="dialog-small"
      onCancel={onClose}
      onSubmit={onClose}
      testId="update-dialog"
      footer={
        <>
          <div className="toolbar-spacer" />
          {actions}
        </>
      }
    >
      <div ref={bodyRef} className="update-body" data-status={status.kind} aria-live="polite">
        {body}
      </div>
    </Dialog>
  );
}
