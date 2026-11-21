/**
 * The watch-folder pipeline: `FolderWatcher` finds files that finished
 * arriving, `WatchQueue` holds them (and holds back retries), and batches go
 * through `processWatchBatch`.
 *
 * `WatchService` puts the three together for a front end that renames
 * without a window (the CLI's `watch`): one batch at a time, a fresh
 * `RenameSession` per batch (so per-run caches such as season listings do
 * not go stale), every outcome reported as a `WatchEvent`. The desktop app
 * uses the pieces directly, because its batches must wait for the window.
 */

import { stat } from "node:fs/promises";
import type { ConfigService, HistoryEntry } from "./config";
import type { LookupErrorKind } from "./renameService";
import type { RenameSession } from "./session";
import { createdPaths, processWatchBatch, type WatchBatchResult, type WatchFileOutcome } from "./watchBatch";
import type { WatchMode } from "./watchConfig";
import type { WatchEvent } from "./watchEvents";
import {
  FolderWatcher,
  fileIdentity,
  systemClock,
  type ReadyFile,
  type WatchClock,
  type WatchFileSystem,
} from "./watcher";

// ---------------------------------------------------------------------------
// Queue with retry backoff
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_BACKOFF_MS = 30_000;
export const MAX_RETRY_BACKOFF_MS = 30 * 60_000;

export interface WatchQueueOptions {
  clock?: WatchClock;
  /** First wait after a lookup failure. Default 30 s; doubled after each failure in a row. */
  initialBackoffMs?: number;
  /** Longest wait. Default 30 min. */
  maxBackoffMs?: number;
  /** Called when files become available to take. */
  onAvailable?: () => void;
}

/**
 * Files waiting for a lookup. After a batch whose lookups failed, the queue
 * holds back those files and every later arrival until the backoff ends, so
 * a service that is down is asked again only once per backoff period, and
 * never in a loop. The backoff doubles with each failure in a row (30 s,
 * 1 min, 2 min, ... up to 30 min) and resets after a batch that worked.
 */
export class WatchQueue {
  private readonly clock: WatchClock;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onAvailable: (() => void) | undefined;
  private ready: ReadyFile[] = [];
  private held: ReadyFile[] = [];
  private backoffMs = 0;
  private holdUntil = 0;
  private timer: unknown;

  constructor(options: WatchQueueOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_RETRY_BACKOFF_MS;
    this.onAvailable = options.onAvailable;
  }

  /** Files that can be taken now. */
  get size(): number {
    return this.ready.length;
  }

  /** Files held back until `retryAt`. */
  get retrying(): number {
    return this.held.length;
  }

  /** When held files become available again (epoch ms), or undefined. */
  get retryAt(): number | undefined {
    return this.held.length > 0 ? this.holdUntil : undefined;
  }

  /** Every path in the queue, ready or held. */
  paths(): string[] {
    return [...this.ready, ...this.held].map((f) => f.path);
  }

  has(filePath: string): boolean {
    return this.ready.some((f) => f.path === filePath) || this.held.some((f) => f.path === filePath);
  }

  add(files: readonly ReadyFile[]): void {
    const fresh = files.filter((f) => !this.has(f.path));
    if (fresh.length === 0) return;
    if (this.clock.now() < this.holdUntil) {
      this.held.push(...fresh);
      return;
    }
    this.ready.push(...fresh);
    this.onAvailable?.();
  }

  /** Take up to `max` files, in arrival order. */
  take(max = Number.POSITIVE_INFINITY): ReadyFile[] {
    return this.ready.splice(0, Math.min(max, this.ready.length));
  }

  /** Put files back at the front (a batch could not run). */
  putBack(files: readonly ReadyFile[]): void {
    const fresh = files.filter((f) => !this.has(f.path));
    if (fresh.length === 0) return;
    this.ready.unshift(...fresh);
    this.onAvailable?.();
  }

  /** Hold these files (and later arrivals) back; returns when they come back (epoch ms). */
  retryLater(files: readonly ReadyFile[]): number {
    this.backoffMs = this.backoffMs === 0 ? this.initialBackoffMs : Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.holdUntil = this.clock.now() + this.backoffMs;
    for (const f of files) if (!this.has(f.path)) this.held.push(f);
    // Files already queued wait too: the service is down for them as well.
    this.held.push(...this.ready.splice(0));
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.release(), this.backoffMs);
    return this.holdUntil;
  }

  /** A batch's lookups worked: the next failure starts with a short wait again. */
  succeeded(): void {
    this.backoffMs = 0;
  }

  /** Try held files now (the user asked, or settings changed). */
  retryNow(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.release();
  }

  private release(): void {
    this.timer = undefined;
    this.holdUntil = 0;
    if (this.held.length === 0) return;
    this.ready.push(...this.held.splice(0));
    this.onAvailable?.();
  }

  remove(filePath: string): void {
    this.ready = this.ready.filter((f) => f.path !== filePath);
    this.held = this.held.filter((f) => f.path !== filePath);
  }

  clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.ready = [];
    this.held = [];
  }
}

// ---------------------------------------------------------------------------
// Files renamed before (the history)
// ---------------------------------------------------------------------------

/**
 * Identities of files the rename history says TidyTitles produced, in this
 * process or another (the other front end, an earlier run), so a watch
 * never treats them as new. Reloaded only when history.json changes.
 */
export class HistoryIdentities {
  private readonly config: ConfigService;
  private identities = new Set<string>();
  private loadedMtime: number | undefined;

  constructor(config: ConfigService) {
    this.config = config;
  }

  static fromEntries(entries: readonly HistoryEntry[]): Set<string> {
    const set = new Set<string>();
    for (const entry of entries) {
      for (const op of entry.operations) {
        if (op.fingerprint) set.add(fileIdentity(op.fingerprint));
        for (const assoc of op.associatedFiles) if (assoc.fingerprint) set.add(fileIdentity(assoc.fingerprint));
      }
    }
    return set;
  }

  has(identity: string): boolean {
    return this.identities.has(identity);
  }

  async refresh(): Promise<void> {
    let mtime: number;
    try {
      mtime = (await stat(this.config.historyFile)).mtimeMs;
    } catch {
      this.identities = new Set();
      this.loadedMtime = undefined;
      return;
    }
    if (mtime === this.loadedMtime) return;
    this.identities = HistoryIdentities.fromEntries(await this.config.loadHistory());
    this.loadedMtime = mtime;
  }
}

// ---------------------------------------------------------------------------
// Outcomes as events
// ---------------------------------------------------------------------------

/**
 * The events for a batch's outcomes (retries are reported separately,
 * with the time they are tried again).
 */
export function outcomeEvents(result: WatchBatchResult, transfer: RenameSession["transferMode"]): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const o of result.outcomes) {
    switch (o.result) {
      case "renamed":
        events.push({
          type: "renamed",
          path: o.path,
          destination: o.operation.destination,
          associatedFiles: o.operation.associatedFiles.length,
          transfer,
        });
        break;
      case "review": {
        const destination = o.operation && o.operation.status === "pending" ? o.operation.destination : undefined;
        events.push({
          type: "review",
          path: o.path,
          reason: o.reason,
          ...(destination && destination !== o.path ? { destination } : {}),
          ...(o.message ? { message: o.message } : {}),
        });
        break;
      }
      case "unchanged":
        events.push({ type: "unchanged", path: o.path });
        break;
      case "changed":
        events.push({ type: "changed", path: o.path });
        break;
      case "gone":
        events.push({ type: "gone", path: o.path });
        break;
      case "retry":
        break;
    }
  }
  if (result.historySaved > 0) events.push({ type: "history_saved", operations: result.historySaved });
  if (result.coverArt.length > 0) events.push({ type: "cover_art", files: result.coverArt });
  return events;
}

/** Paths a batch leaves to the watcher as handled: renamed results, files waiting for review. */
export function handledPaths(outcomes: readonly WatchFileOutcome[]): string[] {
  const out: string[] = [];
  for (const o of outcomes) {
    if (o.result === "renamed") {
      out.push(...createdPaths(o.operation));
      // A copy or link leaves the original in place: it was handled too.
      out.push(o.path);
    } else if (o.result === "review" || o.result === "unchanged") {
      out.push(o.path);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// WatchService
// ---------------------------------------------------------------------------

export interface WatchServiceOptions {
  folders: readonly string[];
  recursive: boolean;
  mode: WatchMode;
  settleMs: number;
  extensions: ReadonlySet<string>;
  /** Output folders (never scanned when inside a watched folder). */
  excludedFolders?: readonly string[];
  /** A fresh session per batch (built with `watchSessionSettings`). */
  createSession: () => Promise<RenameSession>;
  onEvent: (event: WatchEvent) => void;
  /** Files per lookup batch. Default 100. */
  maxBatch?: number;
  /** How long to let more files gather before a batch starts. Default 2 s. */
  gatherMs?: number;
  /** Runs each batch's renaming and history save (see `WatchBatchOptions.guard`). */
  guard?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Files renamed before (the rename history). */
  history?: HistoryIdentities;
  fs?: WatchFileSystem;
  clock?: WatchClock;
  platform?: NodeJS.Platform;
  /** Watcher timing (tests). */
  rescanMs?: number;
  pollingRescanMs?: number;
  checkMs?: number;
  initialBackoffMs?: number;
}

/** Totals since the service started. */
export interface WatchTotals {
  renamed: number;
  review: number;
  unchanged: number;
  retrying: number;
}

export class WatchService {
  readonly watcher: FolderWatcher;
  readonly queue: WatchQueue;
  private readonly options: WatchServiceOptions;
  private readonly clock: WatchClock;
  private readonly maxBatch: number;
  private readonly gatherMs: number;
  private batchTimer: unknown;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopped = false;
  readonly totals: WatchTotals = { renamed: 0, review: 0, unchanged: 0, retrying: 0 };

  constructor(options: WatchServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.maxBatch = options.maxBatch ?? 100;
    this.gatherMs = options.gatherMs ?? 2_000;
    this.queue = new WatchQueue({
      clock: this.clock,
      ...(options.initialBackoffMs !== undefined ? { initialBackoffMs: options.initialBackoffMs } : {}),
      onAvailable: () => this.scheduleBatch(this.gatherMs),
    });
    const history = options.history;
    this.watcher = new FolderWatcher({
      folders: options.folders,
      recursive: options.recursive,
      extensions: options.extensions,
      settleMs: options.settleMs,
      excludedFolders: options.excludedFolders ?? [],
      ...(history ? { isKnown: (id: string) => history.has(id), beforeScan: () => history.refresh() } : {}),
      ...(options.fs ? { fs: options.fs } : {}),
      clock: this.clock,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.rescanMs !== undefined ? { rescanMs: options.rescanMs } : {}),
      ...(options.pollingRescanMs !== undefined ? { pollingRescanMs: options.pollingRescanMs } : {}),
      ...(options.checkMs !== undefined ? { checkMs: options.checkMs } : {}),
      onEvent: options.onEvent,
      onReady: (files) => this.queue.add(files),
    });
  }

  private emit(event: WatchEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // Logging never stops the watch.
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.history?.refresh().catch(() => undefined);
    await this.watcher.start();
  }

  /** Treat files already in the folders as new (see `FolderWatcher.processExisting`). */
  processExisting(): number {
    return this.watcher.processExisting();
  }

  /**
   * Stop watching. A lookup in progress is canceled (its files are not
   * touched); renaming in progress finishes and its history is saved first.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher.stop();
    if (this.batchTimer !== undefined) this.clock.clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    this.abort?.abort();
    await this.running?.catch(() => undefined);
    this.queue.clear();
  }

  /** Resolves when no batch is running or waiting to start (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  private scheduleBatch(delayMs: number): void {
    if (this.stopped || this.running || this.batchTimer !== undefined) return;
    this.batchTimer = this.clock.setTimeout(() => {
      this.batchTimer = undefined;
      this.running = this.runBatch().finally(() => {
        this.running = null;
        if (this.queue.size > 0) this.scheduleBatch(0);
      });
    }, delayMs);
  }

  private async runBatch(): Promise<void> {
    if (this.stopped) return;
    const files = this.queue.take(this.maxBatch);
    if (files.length === 0) return;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: "looking_up", count: files.length });
    let result: WatchBatchResult;
    let transfer: RenameSession["transferMode"] = "move";
    try {
      const session = await this.options.createSession();
      transfer = session.transferMode;
      result = await processWatchBatch(session, files, {
        mode: this.options.mode,
        settleMs: this.options.settleMs,
        signal: abort.signal,
        now: () => this.clock.now(),
        ...(this.options.guard ? { guard: this.options.guard } : {}),
        ...(this.options.fs ? { fs: this.options.fs } : {}),
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      // Building the session failed (config unreadable): try the files again later.
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = this.queue.retryLater(files);
      this.totals.retrying = this.queue.retrying;
      this.emit({ type: "retry", paths: files.map((f) => f.path), retryAt, message });
      return;
    } finally {
      this.abort = null;
    }

    const byPath = new Map(files.map((f) => [f.path, f]));
    await this.watcher.markHandled(handledPaths(result.outcomes));
    const retry: ReadyFile[] = [];
    let retryMessage = "";
    let retryKind: LookupErrorKind | undefined;
    for (const o of result.outcomes) {
      if (o.result === "renamed") this.totals.renamed += 1;
      else if (o.result === "review") this.totals.review += 1;
      else if (o.result === "unchanged") this.totals.unchanged += 1;
      else if (o.result === "changed") this.watcher.resettle(o.path);
      else if (o.result === "gone") this.watcher.forget(o.path);
      else if (o.result === "retry") {
        retry.push(byPath.get(o.path)!);
        retryMessage ||= o.message;
        retryKind ??= o.operation?.lookupError?.kind;
      }
    }
    for (const event of outcomeEvents(result, transfer)) this.emit(event);
    if (retry.length > 0) {
      const retryAt = this.queue.retryLater(retry);
      this.emit({ type: "retry", paths: retry.map((f) => f.path), retryAt, message: retryMessage, ...(retryKind ? { kind: retryKind } : {}) });
    } else {
      this.queue.succeeded();
    }
    this.totals.retrying = this.queue.retrying;
  }
}
