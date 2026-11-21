/** Watch folders in the window: the state from main, and how it is described. */

import { useEffect, useState } from "react";
import type { TidyTitlesApi, WatchActivityEntry, WatchViewState } from "../../shared/ipc";
import { formatCount, plural } from "./format";

/** The watch state pushed by main (null until the first one arrives). */
export function useWatchState(api: TidyTitlesApi): WatchViewState | null {
  const [state, setState] = useState<WatchViewState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = api.onWatchState((s) => setState(s));
    void api.getWatchState().then((s) => {
      if (alive) setState((current) => current ?? s);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return state;
}

export type WatchTone = "off" | "on" | "paused" | "problem";

/** The headline of the status-bar indicator and its tone. */
export function watchHeadline(state: WatchViewState): { text: string; tone: WatchTone } {
  if (!state.enabled) return { text: "Not watching", tone: "off" };
  if (state.paused) return { text: "Watching paused", tone: "paused" };
  const missing = state.folders.filter((f) => f.status !== "ok").length;
  if (missing > 0 && missing === state.folders.length) {
    return { text: state.folders.length === 1 ? "Watch folder missing" : "Watch folders missing", tone: "problem" };
  }
  const mode = state.mode === "automatic" ? "Automatic" : "Review";
  return { text: `Watching · ${mode}`, tone: missing > 0 ? "problem" : "on" };
}

/** What is going on right now, for the indicator's tooltip and the activity dialog. */
export function watchDetails(state: WatchViewState): string[] {
  const lines: string[] = [];
  if (!state.enabled) return ["Turn on watch folders in Settings → Watch."];
  for (const f of state.folders) {
    const status = f.status === "missing" ? " (missing)" : f.status === "error" ? " (can’t be read)" : "";
    lines.push(`${f.folder}${status}`);
  }
  if (state.arriving > 0) lines.push(`${plural(state.arriving, "file")} still arriving`);
  if (state.temporary > 0) lines.push(`${plural(state.temporary, "download")} in progress`);
  if (state.waiting > 0) lines.push(`${plural(state.waiting, "file")} waiting for the current task to finish`);
  if (state.retrying > 0) {
    lines.push(`${plural(state.retrying, "file")} waiting to retry the lookup${state.retryAt ? ` at ${formatClock(state.retryAt)}` : ""}`);
  }
  return lines;
}

/** Short counts next to the headline ("2 arriving"). */
export function watchBadge(state: WatchViewState): string | null {
  if (!state.enabled || state.paused) return null;
  const busy = state.arriving + state.temporary + state.waiting;
  if (busy > 0) return `${formatCount(busy)} arriving`;
  if (state.retrying > 0) return `${formatCount(state.retrying)} to retry`;
  return null;
}

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY_CLOCK = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

/** "3:05 PM" */
export function formatClock(epochMs: number): string {
  return CLOCK.format(new Date(epochMs));
}

/** "Nov 21, 3:05:12 PM" */
export function formatActivityTime(epochMs: number): string {
  return DAY_CLOCK.format(new Date(epochMs));
}

export const ACTIVITY_LABELS: Record<WatchActivityEntry["kind"], string> = {
  renamed: "Renamed",
  review: "For review",
  skipped: "Skipped",
  retry: "Retrying",
  folder: "Folder",
  info: "Watching",
};
