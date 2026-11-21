/**
 * The status bar's watch-folder indicator: whether watching is on, what is
 * arriving, a Pause/Resume button, and the way to the activity log.
 */

import type { WatchViewState } from "../../../shared/ipc";
import { watchBadge, watchDetails, watchHeadline } from "../watch";
import { Icon } from "./Icon";

export function WatchIndicator({
  state,
  unseen,
  onTogglePause,
  onShowActivity,
}: {
  state: WatchViewState | null;
  /** Activity entries not seen yet in the log. */
  unseen: number;
  onTogglePause: () => void;
  onShowActivity: () => void;
}) {
  if (!state || (!state.enabled && state.activityCount === 0)) return null;
  const headline = watchHeadline(state);
  const badge = watchBadge(state);
  return (
    <div className={`watch-indicator watch-tone-${headline.tone}`} data-testid="watch-indicator" data-status={headline.tone}>
      <button
        type="button"
        className="watch-summary"
        onClick={onShowActivity}
        title={[...watchDetails(state), "Watching runs only while TidyTitles is open.", "Click to see what the watcher did."].join("\n")}
        data-testid="watch-activity-open"
      >
        <span className="watch-dot" aria-hidden="true" />
        <span data-testid="watch-headline">{headline.text}</span>
        {badge && <span className="watch-badge">{badge}</span>}
        {unseen > 0 && (
          <span className="watch-unseen" aria-label={`${unseen} new in the watch activity`} data-testid="watch-unseen">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>
      {state.enabled && (
        <button
          type="button"
          className="btn btn-small"
          onClick={onTogglePause}
          aria-pressed={state.paused}
          data-testid="watch-pause"
        >
          {state.paused ? (
            <>
              <Icon name="restart" size={12} />
              <span>Resume</span>
            </>
          ) : (
            <span>Pause</span>
          )}
        </button>
      )}
    </div>
  );
}
