import type { ReactNode } from "react";
import type { UndoKeptReason } from "@tidytitles/core";
import type { RenameOutcome, UndoOutcome } from "../../../shared/ipc";
import { formatCount, plural } from "../format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  testId,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  return (
    <Dialog
      title={title}
      className="dialog-small"
      onCancel={onCancel}
      onSubmit={onConfirm}
      testId={testId}
      footer={
        <>
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" autoFocus data-testid="confirm">
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/** OK submits the dialog's form, whose onSubmit closes it. */
function OkFooter() {
  return (
    <>
      <div className="toolbar-spacer" />
      <button type="submit" className="btn btn-primary" autoFocus data-testid="ok">
        OK
      </button>
    </>
  );
}

function SummaryRow({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`summary-row${tone ? ` tone-text-${tone}` : ""}`}>
      <dt>{label}</dt>
      <dd>{formatCount(value)}</dd>
    </div>
  );
}

export function RenameResultDialog({
  outcome,
  onClose,
}: {
  outcome: Extract<RenameOutcome, { kind: "done" }>;
  onClose: () => void;
}) {
  const { summary } = outcome;
  const allGood = summary.failed === 0;
  const verb = { move: "Renamed", copy: "Copied", hardlink: "Linked" }[outcome.transferMode ?? "move"];
  const assocVerb = { move: "moved", copy: "copied", hardlink: "linked" }[outcome.transferMode ?? "move"];
  return (
    <Dialog title="Rename Complete" className="dialog-small" onCancel={onClose} onSubmit={onClose} footer={<OkFooter />} testId="rename-result">
      <p className="result-lead">
        <Icon name={allGood ? "check" : "alert"} className={allGood ? "tone-text-success" : "tone-text-warning"} />
        <span>
          {allGood
            ? `${verb} ${plural(summary.completed, "file")}.`
            : `${verb} ${plural(summary.completed, "file")}; ${plural(summary.failed, "file")} could not be renamed.`}
        </span>
      </p>
      <dl className="summary">
        <SummaryRow label={verb} value={summary.completed} tone="success" />
        {outcome.associatedRenamed > 0 && <SummaryRow label={`Associated files ${assocVerb}`} value={outcome.associatedRenamed} />}
        {summary.failed > 0 && <SummaryRow label="Failed" value={summary.failed} tone="error" />}
        {summary.skipped > 0 && <SummaryRow label="Skipped" value={summary.skipped} />}
        {outcome.coverArtAttempted && <SummaryRow label="Cover art downloaded" value={outcome.coverArtDownloaded} />}
      </dl>
      {outcome.failures.length > 0 && (
        <ul className="failure-list">
          {outcome.failures.map((f) => (
            <li key={f.name}>
              <strong>{f.name}</strong>: {f.message}
            </li>
          ))}
        </ul>
      )}
      {outcome.historySaved > 0 && <p className="muted small">You can undo this with Undo Last Rename.</p>}
    </Dialog>
  );
}

export function UndoResultDialog({
  outcome,
  onClose,
}: {
  outcome: Extract<UndoOutcome, { kind: "done" }>;
  onClose: () => void;
}) {
  const failures = outcome.items.filter((i) => i.status === "failed");
  const kept = outcome.items.flatMap((i) => i.kept ?? []);
  return (
    <Dialog title="Undo Complete" className="dialog-small" onCancel={onClose} onSubmit={onClose} footer={<OkFooter />} testId="undo-result">
      {!outcome.historyFound ? (
        <p>There is no rename to undo.</p>
      ) : (
        <>
          <dl className="summary">
            <SummaryRow label="Restored" value={outcome.undone} tone="success" />
            {outcome.missing > 0 && <SummaryRow label="Not found (moved or deleted since)" value={outcome.missing} tone="warning" />}
            {(outcome.kept ?? 0) > 0 && <SummaryRow label="Left in place" value={outcome.kept} tone="warning" />}
            {outcome.failed > 0 && <SummaryRow label="Failed" value={outcome.failed} tone="error" />}
          </dl>
          {failures.length > 0 && (
            <ul className="failure-list">
              {failures.map((f) => (
                <li key={f.name}>
                  <strong>{f.name}</strong>: {f.errors.join("; ")}
                </li>
              ))}
            </ul>
          )}
          {kept.length > 0 && (
            <ul className="failure-list" data-testid="undo-kept">
              {kept.map((k) => (
                <li key={k.name}>
                  <strong>{k.name}</strong>: {KEPT_TEXT[k.reason]}
                </li>
              ))}
            </ul>
          )}
          {outcome.failed > 0 && <p className="muted small">The files that could not be restored stay in the history; you can try Undo again.</p>}
        </>
      )}
    </Dialog>
  );
}

const KEPT_TEXT: Record<UndoKeptReason, string> = {
  changed: "left in place, because it was replaced or changed after the rename.",
  original_missing: "left in place, because the original is gone and this may be the only copy.",
  renamed_later: "left in place, because a later rename touched it. Undo that one first.",
};

export function ErrorDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <Dialog title={title} className="dialog-small" onCancel={onClose} onSubmit={onClose} footer={<OkFooter />} testId="error-dialog">
      <p className="result-lead">
        <Icon name="alert" className="tone-text-error" />
        <span className="selectable">{message}</span>
      </p>
    </Dialog>
  );
}
