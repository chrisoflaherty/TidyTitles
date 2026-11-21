/**
 * Rename History: every recorded rename (from this app or the command-line
 * tool), most recent first, each with its own Undo. Undoing an older one
 * leaves later renames as they are; files they moved or replaced are left
 * in place and reported in the result.
 */

import { useEffect, useState } from "react";
import type { HistoryEntryView } from "../../../shared/ipc";
import { getApi } from "../api";
import { baseName, formatCount, formatTimestamp, plural } from "../format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

const HOW: Record<HistoryEntryView["transfer"], string> = {
  move: "Renamed",
  copy: "Copied",
  hardlink: "Hard linked",
  mixed: "Renamed and copied",
};

export function HistoryDialog({
  onClose,
  onUndo,
  busy,
}: {
  onClose: () => void;
  /** Undo the entry with this timestamp (the dialog closes first). */
  onUndo: (entry: HistoryEntryView) => void;
  busy: boolean;
}) {
  const api = getApi();
  const [entries, setEntries] = useState<HistoryEntryView[] | null>(null);
  const [confirming, setConfirming] = useState<HistoryEntryView | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getHistory().then((list) => {
      if (alive) setEntries(list);
    });
    return () => {
      alive = false;
    };
  }, [api]);

  const footer = confirming ? (
    <>
      <div className="toolbar-spacer" />
      <button type="button" className="btn" onClick={() => setConfirming(null)}>
        Back
      </button>
      <button type="submit" className="btn btn-primary" autoFocus disabled={busy} data-testid="history-confirm-undo">
        Undo Rename
      </button>
    </>
  ) : (
    <>
      <div className="toolbar-spacer" />
      <button type="submit" className="btn btn-primary" autoFocus data-testid="history-close">
        Close
      </button>
    </>
  );

  return (
    <Dialog
      title={confirming ? "Undo This Rename?" : "Rename History"}
      className="dialog-history"
      onCancel={confirming ? () => setConfirming(null) : onClose}
      onSubmit={() => (confirming ? onUndo(confirming) : onClose())}
      footer={footer}
      testId="history-dialog"
    >
      {confirming ? (
        <div data-testid="history-confirm">
          <p>
            {confirming.transfer === "copy" || confirming.transfer === "hardlink"
              ? `Delete the ${plural(confirming.files, confirming.transfer === "copy" ? "copy" : "link", confirming.transfer === "copy" ? "copies" : "links")} made`
              : `Move ${plural(confirming.files, "file")} back to their original names`}{" "}
            from {formatTimestamp(confirming.timestamp)}.
          </p>
          {confirming.position > 0 && (
            <p className="muted">
              {plural(confirming.position, "later rename")} will stay as {confirming.position === 1 ? "it is" : "they are"}. Files they
              moved or replaced are left in place, and you’ll see which.
            </p>
          )}
          {(confirming.transfer === "copy" || confirming.transfer === "hardlink" || confirming.transfer === "mixed") && (
            <p className="muted small">The originals are never touched. A copy that changed since is kept.</p>
          )}
        </div>
      ) : entries === null ? (
        <p className="muted">Loading history…</p>
      ) : entries.length === 0 ? (
        <p className="muted" data-testid="history-empty">
          There are no renames to undo yet.
        </p>
      ) : (
        <ol className="history-list" aria-label="Renames, most recent first">
          {entries.map((entry) => {
            const first = entry.samples[0];
            return (
              <li key={`${entry.position}-${entry.timestamp}`} className="history-item" data-testid="history-entry">
                <div className="history-main">
                  <span className="history-when">{formatTimestamp(entry.timestamp)}</span>
                  <span className="history-what muted">
                    {HOW[entry.transfer]} {plural(entry.operations, "file")}
                    {entry.files > entry.operations ? ` (${formatCount(entry.files)} with associated files)` : ""}
                  </span>
                  {first && (
                    <span className="history-sample" title={entry.samples.map((s) => `${baseName(s.source)} → ${baseName(s.destination)}`).join("\n")}>
                      {baseName(first.destination)}
                      {entry.operations > 1 ? <span className="muted"> and {formatCount(entry.operations - 1)} more</span> : null}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setConfirming(entry)}
                  data-testid="history-undo"
                  aria-label={`Undo the rename from ${formatTimestamp(entry.timestamp)}`}
                >
                  <Icon name="undo" size={14} />
                  <span>Undo…</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}
