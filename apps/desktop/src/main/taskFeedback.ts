/**
 * Feedback outside the window while a task runs: progress on the Dock or
 * taskbar icon, a system notification when a rename or undo finishes while
 * the window is in the background, and a request for attention when a
 * "which match?" question waits.
 *
 * No Electron imports: `app.ts` supplies the window operations through
 * `FeedbackSink`, and the tests use a fake.
 */

import type { AppState, BusyKind, ProgressEvent, RenameOutcome, UndoOutcome } from "../shared/ipc";

/** What the icon's progress bar shows. */
export type IconProgress =
  | { kind: "none" }
  /** Working, but how far along is unknown (before the first progress report). */
  | { kind: "indeterminate" }
  /** 0 to 1. */
  | { kind: "fraction"; value: number };

export interface FeedbackNotification {
  title: string;
  body: string;
}

/** The window operations, implemented with Electron in `app.ts`. */
export interface FeedbackSink {
  setProgress(progress: IconProgress): void;
  /** Whether the app's window has keyboard focus. */
  isFocused(): boolean;
  notify(notification: FeedbackNotification): void;
  /** Bounce the Dock icon once (macOS) or flash the taskbar button (Windows). */
  requestAttention(): void;
}

/** Tasks that show progress on the icon. Adding files and saving settings are too quick to bother. */
const PROGRESS_TASKS: ReadonlySet<BusyKind> = new Set(["fetching", "renaming", "undoing"]);

const COUNT = new Intl.NumberFormat("en-US");

function plural(n: number, one: string, many = `${one}s`): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The icon's progress for a task and its latest progress report.
 *
 * Every core callback reports item `current` just before working on it, so
 * `current - 1` items are done. Fetching has two phases: reading the names
 * (fast, the first tenth of the bar) and looking them up (the rest).
 */
export function iconProgress(busy: BusyKind | null, progress: ProgressEvent | null): IconProgress {
  if (busy === null || !PROGRESS_TASKS.has(busy)) return { kind: "none" };
  if (!progress || !(progress.total > 0)) return { kind: "indeterminate" };
  const done = clamp01((progress.current - 1) / progress.total);
  if (busy === "fetching") {
    if (progress.phase === "parse") return { kind: "fraction", value: 0.1 * done };
    if (progress.phase === "fetch") return { kind: "fraction", value: 0.1 + 0.9 * done };
  }
  return { kind: "fraction", value: done };
}

/**
 * `BrowserWindow.setProgressBar` arguments for a progress state. Windows has
 * a real indeterminate mode; elsewhere a value above 1 would show a full bar,
 * so an unknown amount shows as an empty one.
 */
export function electronProgressArgs(
  progress: IconProgress,
  platform: NodeJS.Platform,
): { value: number; mode?: "indeterminate" | "normal" | "none" } {
  switch (progress.kind) {
    case "none":
      return platform === "win32" ? { value: -1, mode: "none" } : { value: -1 };
    case "indeterminate":
      return platform === "win32" ? { value: 2, mode: "indeterminate" } : { value: 0 };
    case "fraction":
      return platform === "win32" ? { value: progress.value, mode: "normal" } : { value: progress.value };
  }
}

/** The notification for a finished rename, or null when there is nothing to report. */
export function renameNotification(outcome: RenameOutcome): FeedbackNotification | null {
  if (outcome.kind === "error") return { title: "Couldn’t Rename Files", body: outcome.message };
  if (outcome.kind !== "done") return null;
  const { completed, failed, skipped } = outcome.summary;
  const details: string[] = [];
  if (failed > 0) details.push(`${plural(failed, "file")} could not be renamed`);
  if (skipped > 0) details.push(`${COUNT.format(skipped)} skipped`);
  if (outcome.associatedRenamed > 0) details.push(`${plural(outcome.associatedRenamed, "associated file")} moved`);
  return {
    title: failed > 0 ? "Rename Finished with Errors" : "Rename Complete",
    body: `Renamed ${plural(completed, "file")}${details.length > 0 ? `; ${details.join(", ")}` : ""}.`,
  };
}

/** The notification for a finished undo, or null when there is nothing to report. */
export function undoNotification(outcome: UndoOutcome): FeedbackNotification | null {
  if (outcome.kind === "error") return { title: "Couldn’t Undo", body: outcome.message };
  if (outcome.kind !== "done") return null;
  if (!outcome.historyFound) return { title: "Undo Complete", body: "There is no rename to undo." };
  const details: string[] = [];
  if (outcome.missing > 0) details.push(`${COUNT.format(outcome.missing)} not found`);
  if (outcome.failed > 0) details.push(`${COUNT.format(outcome.failed)} failed`);
  return {
    title: outcome.failed > 0 ? "Undo Finished with Errors" : "Undo Complete",
    body: `Restored ${plural(outcome.undone, "file")}${details.length > 0 ? `; ${details.join(", ")}` : ""}.`,
  };
}

/**
 * Feeds state and progress events to the sink. The icon's progress follows
 * the task in `AppState.busy`, so it is cleared whenever the task ends,
 * however it ends (done, failed, canceled).
 */
export class TaskFeedback {
  private busy: BusyKind | null = null;
  private progress: ProgressEvent | null = null;
  private shown: IconProgress = { kind: "none" };
  private readonly asked = new Set<string>();

  constructor(private readonly sink: FeedbackSink) {}

  onState(state: Pick<AppState, "busy">): void {
    if (state.busy !== this.busy) {
      this.busy = state.busy;
      this.progress = null;
      if (state.busy !== "fetching") this.asked.clear();
    }
    this.update();
  }

  onProgress(progress: ProgressEvent | null): void {
    this.progress = progress;
    this.update();
  }

  /** A selection question was shown. Asks for attention at most once per question. */
  onSelectionRequest(id: string): void {
    if (this.asked.has(id)) return;
    this.asked.add(id);
    if (!this.sink.isFocused()) this.sink.requestAttention();
  }

  renameFinished(outcome: RenameOutcome): void {
    this.notifyInBackground(renameNotification(outcome));
  }

  undoFinished(outcome: UndoOutcome): void {
    this.notifyInBackground(undoNotification(outcome));
  }

  /** Clear the icon (the window is going away). */
  reset(): void {
    this.busy = null;
    this.progress = null;
    this.asked.clear();
    this.update();
  }

  /** Show the current progress again (a new window starts without it). */
  reapply(): void {
    this.sink.setProgress(this.shown);
  }

  private update(): void {
    const next = iconProgress(this.busy, this.progress);
    if (sameProgress(next, this.shown)) return;
    this.shown = next;
    this.sink.setProgress(next);
  }

  private notifyInBackground(notification: FeedbackNotification | null): void {
    if (notification && !this.sink.isFocused()) this.sink.notify(notification);
  }
}

function sameProgress(a: IconProgress, b: IconProgress): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "fraction" && b.kind === "fraction") return Math.abs(a.value - b.value) < 0.001;
  return true;
}
