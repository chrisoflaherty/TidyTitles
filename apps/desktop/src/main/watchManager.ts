/**
 * Watch folders in the desktop app, while it is open (there is no
 * background service or login item).
 *
 * Core's `FolderWatcher` finds files that finished arriving; they wait in a
 * `WatchQueue` until the window takes them (`take`), which it does only when
 * it would accept a drop: the app is idle and no dialog is open, the same
 * rule as files opened from the Dock (`OpenedPathsQueue`). Then:
 *
 * - Review mode: the files are added to the list and fetched, exactly as if
 *   the user had added them and clicked Fetch (selection questions included).
 * - Automatic mode: they are looked up in batches (`runWatchBatch`, busy
 *   "watching"); unambiguous files are renamed and saved to the history,
 *   and the rest are added to the list and fetched for review.
 *
 * Lookups that fail (service down) wait with a growing delay. Everything the
 * watcher does is kept in an activity log (in memory, until the app quits).
 *
 * No Electron imports: `app.ts` supplies the state channel and notification.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  FolderWatcher,
  HistoryIdentities,
  WATCH_REVIEW_TEXT,
  WatchQueue,
  extensionsForMediaType,
  handledPaths,
  isInsideOrEqual,
  type PlannedOperation,
  type ReadyFile,
  type Settings,
  type WatchClock,
  type WatchEvent,
  type WatchFileSystem,
  type WatchSettings,
} from "@tidytitles/core";
import type { WatchActivityEntry, WatchTakeOutcome, WatchViewState } from "../shared/ipc";
import type { AppController } from "./controller";

/** Files per automatic batch. */
export const WATCH_BATCH_SIZE = 100;
/** At most this many files are added to the list at once (the limit of a drop). */
export const MAX_WATCH_ADD = 10_000;
/** Activity entries kept. */
export const MAX_ACTIVITY = 2_000;

export interface WatchManagerOptions {
  controller: AppController;
  /** Push the state to the window. */
  emit: (state: WatchViewState) => void;
  /** Files were renamed or added for review (the window decides whether to notify). */
  finished: (summary: { renamed: number; review: number }) => void;
  fs?: WatchFileSystem;
  clock?: WatchClock;
  /** Watcher timings (tests). */
  timings?: { rescanMs?: number; pollingRescanMs?: number; checkMs?: number; initialBackoffMs?: number };
  platform?: NodeJS.Platform;
}

const COUNT = new Intl.NumberFormat("en-US");

function plural(n: number, one: string, many = `${one}s`): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

/** What makes a running watcher obsolete when it changes. */
function watcherKey(watch: WatchSettings): string {
  return JSON.stringify([watch.enabled, watch.folders, watch.recursive, watch.settleSeconds]);
}

function outputFolders(settings: Settings): string[] {
  return [settings.output.movie, settings.output.tv, settings.output.music].filter((f) => f.trim() !== "");
}

export class WatchManager {
  private readonly controller: AppController;
  private readonly options: WatchManagerOptions;
  private readonly queue: WatchQueue;
  private readonly history: HistoryIdentities;
  private watcher: FolderWatcher | null = null;
  private key = "";
  private paused = false;
  private taking = false;
  private disposed = false;
  private readonly activity: WatchActivityEntry[] = [];
  private nextActivityId = 1;
  private readonly totals = { renamed: 0, review: 0, skipped: 0 };
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(options: WatchManagerOptions) {
    this.options = options;
    this.controller = options.controller;
    this.history = new HistoryIdentities(options.controller.configService);
    this.queue = new WatchQueue({
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.timings?.initialBackoffMs !== undefined ? { initialBackoffMs: options.timings.initialBackoffMs } : {}),
      onAvailable: () => this.changed(),
    });
  }

  private get settings(): Settings {
    return this.controller.currentSettings;
  }

  /** Start, restart, or stop watching to match the settings. */
  async apply(): Promise<void> {
    if (this.disposed) return;
    const watch = this.settings.watch;
    this.watcher?.setExcludedFolders(outputFolders(this.settings));
    const key = watcherKey(watch);
    if (key === this.key) {
      this.changed();
      return;
    }
    this.key = key;
    this.stopWatcher();
    this.queue.clear();
    if (watch.enabled && watch.folders.length > 0) {
      this.watcher = new FolderWatcher({
        folders: watch.folders,
        recursive: watch.recursive,
        extensions: extensionsForMediaType(undefined),
        settleMs: watch.settleSeconds * 1_000,
        excludedFolders: outputFolders(this.settings),
        isKnown: (identity) => this.history.has(identity),
        beforeScan: () => this.history.refresh(),
        ...(this.options.fs ? { fs: this.options.fs } : {}),
        ...(this.options.clock ? { clock: this.options.clock } : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        ...this.options.timings,
        onEvent: (event) => this.onEvent(event),
        onReady: (files) => this.queue.add(files),
      });
      if (!this.paused) await this.startWatcher();
    }
    this.changed();
  }

  private async startWatcher(): Promise<void> {
    const watcher = this.watcher;
    if (!watcher) return;
    await this.history.refresh().catch(() => undefined);
    if (watcher === this.watcher) await watcher.start();
  }

  private stopWatcher(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  /** Pause or resume. Files that arrived while paused are picked up on resume. */
  async setPaused(paused: boolean): Promise<void> {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.watcher?.stop();
      this.log({ kind: "info", path: "", text: "Watching paused" });
    } else {
      this.log({ kind: "info", path: "", text: "Watching resumed" });
      await this.startWatcher();
    }
    this.changed();
  }

  /** Treat the files already in the folders as new arrivals. */
  processExisting(): number {
    const n = this.watcher?.processExisting() ?? 0;
    if (n > 0) this.log({ kind: "info", path: "", text: `Processing ${plural(n, "file")} that ${n === 1 ? "was" : "were"} already in the watch folders` });
    this.changed();
    return n;
  }

  retryNow(): void {
    this.queue.retryNow();
    this.changed();
  }

  getActivity(): WatchActivityEntry[] {
    return [...this.activity].reverse();
  }

  getState(): WatchViewState {
    const watch = this.settings.watch;
    const counts = this.watcher?.counts() ?? { arriving: 0, temporary: 0, existing: 0, queued: 0 };
    return {
      enabled: watch.enabled && watch.folders.length > 0,
      paused: this.paused,
      mode: watch.mode,
      folders: this.watcher?.folderInfo() ?? [],
      arriving: counts.arriving,
      temporary: counts.temporary,
      waiting: this.queue.size,
      retrying: this.queue.retrying,
      retryAt: this.queue.retryAt ?? null,
      existing: counts.existing,
      totals: { ...this.totals },
      activityCount: this.nextActivityId - 1,
      latest: this.activity.at(-1) ?? null,
    };
  }

  /**
   * Files the user renamed from the list: never pick them up again (a copy
   * or a link in a watched folder is a new file otherwise).
   */
  async noteRenamed(operations: readonly PlannedOperation[] | null): Promise<void> {
    if (!this.watcher || !operations) return;
    const paths: string[] = [];
    for (const op of operations) {
      if (op.status !== "completed") continue;
      paths.push(op.source, op.destination, ...op.associatedFiles.map((a) => a.destination));
    }
    await this.watcher.markHandled(paths);
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatcher();
    this.queue.clear();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  // -------------------------------------------------------------------------
  // Taking arrivals
  // -------------------------------------------------------------------------

  /**
   * Called by the window when it would accept a drop. Waiting files go into
   * the list (review) or through automatic batches.
   */
  async take(accept: boolean): Promise<WatchTakeOutcome> {
    if (this.queue.size === 0) return { kind: "nothing" };
    if (!accept || this.taking || this.controller.isBusy || this.paused) return { kind: "busy" };
    this.taking = true;
    try {
      return this.settings.watch.mode === "automatic" ? await this.takeAutomatic() : await this.takeForReview(this.queue.take(MAX_WATCH_ADD));
    } finally {
      this.taking = false;
      this.changed();
    }
  }

  /** Add files to the list and fetch, as if the user had dropped them and clicked Fetch. */
  private async takeForReview(files: readonly ReadyFile[], renamed = 0, logged = false): Promise<WatchTakeOutcome> {
    const listed = this.controller.listedPaths();
    const paths: string[] = [];
    for (const f of files) {
      try {
        await stat(f.path);
      } catch {
        this.watcher?.forget(f.path);
        continue;
      }
      if (!listed.has(f.path)) paths.push(f.path);
    }
    // Known from now on: renamed later from the list, they are not new files.
    await this.watcher?.markHandled(paths);
    let review = 0;
    if (paths.length > 0) {
      const added = await this.controller.addPaths(paths, { filterExplicitFiles: true });
      review = added.added;
      // Automatic batches already logged why each file waits for review.
      if (!logged) for (const p of paths) this.log({ kind: "review", path: p, reason: "review_mode", text: "Added to the list for review" });
      this.totals.review += review;
      if (added.added > 0) await this.controller.fetch();
    }
    if (renamed > 0 || review > 0) this.options.finished({ renamed, review });
    return { kind: "done", renamed, review };
  }

  private async takeAutomatic(): Promise<WatchTakeOutcome> {
    let renamed = 0;
    const forReview: ReadyFile[] = [];
    while (this.queue.size > 0 && !this.disposed) {
      const batch = this.queue.take(WATCH_BATCH_SIZE);
      const result = await this.controller.runWatchBatch(batch, "automatic");
      if (!result) {
        this.queue.putBack(batch);
        break;
      }
      const byPath = new Map(batch.map((f) => [f.path, f]));
      await this.watcher?.markHandled(handledPaths(result.outcomes));
      const retry: ReadyFile[] = [];
      let retryMessage = "";
      for (const o of result.outcomes) {
        switch (o.result) {
          case "renamed":
            renamed += 1;
            this.totals.renamed += 1;
            this.log({
              kind: "renamed",
              path: o.path,
              destination: o.operation.destination,
              text: `Renamed to ${path.basename(o.operation.destination)}`,
            });
            break;
          case "review":
            forReview.push(byPath.get(o.path)!);
            this.log({
              kind: "review",
              path: o.path,
              reason: o.reason,
              ...(o.operation?.status === "pending" && o.operation.destination !== o.path ? { destination: o.operation.destination } : {}),
              text: `Waiting for review: ${WATCH_REVIEW_TEXT[o.reason]}${o.reason === "rename_failed" && o.message ? ` (${o.message})` : ""}`,
            });
            break;
          case "unchanged":
            this.log({ kind: "skipped", path: o.path, text: "Already has its new name" });
            break;
          case "changed":
            this.watcher?.resettle(o.path);
            break;
          case "gone":
            this.watcher?.forget(o.path);
            this.totals.skipped += 1;
            this.log({ kind: "skipped", path: o.path, text: "Gone before it could be renamed" });
            break;
          case "retry":
            retry.push(byPath.get(o.path)!);
            retryMessage ||= o.message;
            break;
        }
      }
      if (retry.length > 0) {
        const at = this.queue.retryLater(retry);
        for (const f of retry) {
          this.log({ kind: "retry", path: f.path, text: `Lookup failed (${retryMessage}); trying again at ${timeText(at)}` });
        }
      } else {
        this.queue.succeeded();
      }
      this.changed();
    }
    // Files that need the user: into the list, fetched for review.
    const outcome = await this.takeForReview(forReview, renamed, true);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Events and state
  // -------------------------------------------------------------------------

  private onEvent(event: WatchEvent): void {
    switch (event.type) {
      case "started":
        this.log({
          kind: "info",
          path: "",
          text: `Watching ${plural(event.folders.length, "folder")}${event.folders.some((f) => f.existing > 0) ? `; ${plural(event.folders.reduce((n, f) => n + f.existing, 0), "file")} already there left alone` : ""}`,
        });
        break;
      case "folder_missing":
        this.log({ kind: "folder", path: event.folder, text: "Folder missing; checking again regularly" });
        break;
      case "folder_restored":
        this.log({
          kind: "folder",
          path: event.folder,
          text: `Folder back${event.existing > 0 ? `; ${plural(event.existing, "file")} there left alone` : ""}`,
        });
        break;
      case "folder_error":
        this.log({ kind: "folder", path: event.folder, text: `Can’t read this folder: ${event.message}` });
        break;
      case "polling":
        this.log({ kind: "folder", path: event.folder, text: "No change notifications here; rescanning it regularly instead" });
        break;
      case "gone":
        this.totals.skipped += 1;
        this.log({ kind: "skipped", path: event.path, text: "Gone before it finished arriving" });
        break;
      case "unreadable":
        this.totals.skipped += 1;
        this.log({ kind: "skipped", path: event.path, text: `Can’t read this file: ${event.message}` });
        break;
      default:
        break;
    }
    this.changed();
  }

  private log(entry: Omit<WatchActivityEntry, "id" | "time">): void {
    const now = this.options.clock?.now() ?? Date.now();
    this.activity.push({ ...entry, id: this.nextActivityId++, time: now });
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
  }

  /** Push the state, at most every 200 ms (thousands of files can arrive at once). */
  private changed(): void {
    if (this.disposed || this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.disposed) this.options.emit(this.getState());
    }, 200);
  }

  /** True when `p` is inside a watch folder (tests). */
  isWatched(p: string): boolean {
    return this.settings.watch.folders.some((f) => isInsideOrEqual(p, f, this.options.platform));
  }
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function timeText(epochMs: number): string {
  return TIME.format(new Date(epochMs));
}
