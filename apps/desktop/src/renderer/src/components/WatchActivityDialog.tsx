/**
 * What the watch folders did since the app started: files renamed
 * automatically, files added for review and why, files skipped, failed
 * lookups waiting to retry, and folders that went missing.
 */

import { useEffect, useMemo, useState } from "react";
import type { WatchActivityEntry, WatchViewState } from "../../../shared/ipc";
import { getApi } from "../api";
import { formatCount, plural } from "../format";
import { ACTIVITY_LABELS, formatActivityTime, watchDetails, watchHeadline } from "../watch";
import { Dialog } from "./Dialog";

type Filter = "all" | WatchActivityEntry["kind"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "renamed", label: "Renamed" },
  { id: "review", label: "For review" },
  { id: "skipped", label: "Skipped" },
  { id: "retry", label: "Retrying" },
  { id: "folder", label: "Folders" },
];

/** Shown at most; the log keeps more. */
const SHOWN = 500;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function WatchActivityDialog({
  state,
  onClose,
  onOpenSettings,
}: {
  state: WatchViewState | null;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const api = getApi();
  const [entries, setEntries] = useState<WatchActivityEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [note, setNote] = useState<string | null>(null);
  const activityCount = state?.activityCount ?? 0;

  useEffect(() => {
    let alive = true;
    void api.getWatchActivity().then((list) => {
      if (alive) setEntries(list);
    });
    return () => {
      alive = false;
    };
  }, [api, activityCount]);

  const shown = useMemo(
    () => (entries ?? []).filter((e) => filter === "all" || e.kind === filter).slice(0, SHOWN),
    [entries, filter],
  );

  const processExisting = async () => {
    const n = await api.processExistingWatchFiles();
    setNote(n > 0 ? `${plural(n, "file")} already in the folders will be processed once unchanged for the settle period.` : "There are no files left that were already in the folders.");
  };

  const headline = state ? watchHeadline(state) : null;
  return (
    <Dialog
      title="Watch Activity"
      className="dialog-watch"
      onCancel={onClose}
      onSubmit={onClose}
      testId="watch-activity"
      footer={
        <>
          <button type="button" className="btn" onClick={onOpenSettings} data-testid="watch-activity-settings">
            Watch Settings…
          </button>
          {state?.enabled && state.existing > 0 && (
            <button type="button" className="btn" onClick={() => void processExisting()} data-testid="watch-process-existing">
              Process {formatCount(state.existing)} Existing {state.existing === 1 ? "File" : "Files"}
            </button>
          )}
          {state && state.retrying > 0 && (
            <button type="button" className="btn" onClick={() => void api.retryWatchNow()} data-testid="watch-retry-now">
              Retry Lookups Now
            </button>
          )}
          <div className="toolbar-spacer" />
          <button type="submit" className="btn btn-primary" autoFocus>
            Done
          </button>
        </>
      }
    >
      {state && headline && (
        <div className="watch-overview" data-testid="watch-overview">
          <p>
            <strong>{headline.text}</strong>
            {state.enabled && (
              <span className="muted">
                {" "}
                · since the app started: {formatCount(state.totals.renamed)} renamed, {formatCount(state.totals.review)} for review,{" "}
                {formatCount(state.totals.skipped)} skipped
              </span>
            )}
          </p>
          <ul className="watch-details">
            {watchDetails(state).map((line) => (
              <li key={line} className="selectable">
                {line}
              </li>
            ))}
          </ul>
          <p className="form-hint">
            Watching runs only while TidyTitles is open; there is no background service or login item. Automatic renames
            are in History and can be undone there. This log is kept until you quit.
          </p>
        </div>
      )}
      {note && (
        <p className="notice tone-info" role="status" data-testid="watch-note">
          {note}
        </p>
      )}
      <div className="watch-filters" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="btn btn-small"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            data-testid={`watch-filter-${f.id}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {entries === null ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted" data-testid="watch-activity-empty">
          Nothing yet.
        </p>
      ) : (
        <ol className="watch-log" data-testid="watch-log">
          {shown.map((e) => (
            <li key={e.id} className={`watch-entry kind-${e.kind}`} data-kind={e.kind} data-reason={e.reason}>
              <span className="watch-entry-time">{formatActivityTime(e.time)}</span>
              <span className="watch-entry-kind">{ACTIVITY_LABELS[e.kind]}</span>
              <span className="watch-entry-body">
                {e.path && (
                  <span className="mono selectable watch-entry-name" title={e.path}>
                    {baseName(e.path)}
                  </span>
                )}
                <span className="watch-entry-text">{e.text}</span>
                {e.destination && e.kind !== "renamed" && (
                  <span className="form-hint block mono selectable" title={e.destination}>
                    → {baseName(e.destination)}
                  </span>
                )}
                {e.destination && e.kind === "renamed" && (
                  <span className="form-hint block mono selectable" title={e.destination}>
                    {e.destination}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {entries && entries.length > SHOWN && <p className="form-hint">Showing the latest {formatCount(SHOWN)}.</p>}
    </Dialog>
  );
}
