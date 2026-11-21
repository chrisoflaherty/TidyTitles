/**
 * Notices media files arriving in watch folders and hands each one on only
 * once it has finished arriving.
 *
 * How changes are found: every folder is **rescanned** (a directory listing,
 * no file contents) on a timer, and that rescan is the source of truth.
 * `fs.watch` (recursive where the platform supports it) only makes the next
 * rescan happen sooner. The reasons, from the Node documentation and from
 * what watch folders meet in practice:
 *
 * - On network file systems (SMB, NFS) and in VMs and containers, `fs.watch`
 *   is "unreliable, and in some cases impossible"; changes made by another
 *   computer are usually not reported at all. A rescan sees them.
 * - On Linux and macOS a watch follows the folder's inode: a folder that is
 *   deleted and recreated (or a drive that is unplugged and plugged back in)
 *   is not watched again. A rescan notices it went away and came back.
 * - The callback's file name is not guaranteed, and bursts of thousands of
 *   files can overflow the event queue. A rescan never misses a file.
 * - Recursive watching is native on macOS (FSEvents) and Windows; on Linux
 *   (Node 19.1 and later) Node adds one inotify watch per folder, which can
 *   fail with ENOSPC on a large tree. Any failure to watch falls back to
 *   rescanning more often (`pollingRescanMs`), never to not watching.
 *
 * When a file has finished arriving: its size and modification time have
 * not changed for `settleMs`, its name is not a temporary download name and
 * no companion such as `X.mkv.part` sits next to it (`watchNames.ts`), and,
 * on macOS, Finder is not still copying it (Finder's "busy" creation date).
 *
 * Files already in a folder when watching starts, or when a missing folder
 * comes back, are "existing": they are left alone unless `processExisting`
 * is called. Files whose identity (device, inode, size, modification time)
 * was already handled are never handed on again, under any name: that is
 * how a file renamed in place, by this watcher or by the user, is not picked
 * up a second time. Output folders inside a watched folder are not scanned.
 *
 * Everything that touches the disk or the clock is injected, so the watcher
 * is tested without real timers or file-system events.
 */

import { watch as fsWatch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WatchEvent, WatchFolderInfo } from "./watchEvents";
import {
  finalNameOf,
  hasCompanion,
  isFinderBusyDate,
  isInsideOrEqual,
  isSkippedFolderName,
  isTemporaryName,
} from "./watchNames";

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface WatchDirEntry {
  name: string;
  kind: "file" | "directory" | "other";
}

/** What the watcher needs to know about a file (bigint fields as decimal strings). */
export interface WatchStat {
  kind: "file" | "directory" | "other";
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  birthtimeMs?: number;
}

export interface WatchHandle {
  close(): void;
}

/** The file system as the watcher sees it. Errors carry a Node `code` (ENOENT, EACCES, ...). */
export interface WatchFileSystem {
  readdir(dir: string): Promise<WatchDirEntry[]>;
  stat(p: string): Promise<WatchStat>;
  /**
   * Start watching `dir`; `onChange` is called for any change inside it.
   * May throw when watching is not possible. `onError` reports a watch that
   * stopped working.
   */
  watch(
    dir: string,
    options: { recursive: boolean },
    onChange: () => void,
    onError: (error: unknown) => void,
  ): WatchHandle;
}

export interface WatchClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: WatchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean }): WatchDirEntry["kind"] {
  return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
}

/** The real file system (`node:fs`). */
export const nodeWatchFileSystem: WatchFileSystem = {
  async readdir(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, kind: kindOf(e) }));
  },
  async stat(p) {
    const s = await stat(p, { bigint: true });
    return {
      kind: kindOf(s),
      dev: String(s.dev),
      ino: String(s.ino),
      size: String(s.size),
      mtimeNs: String(s.mtimeNs),
      birthtimeMs: Number(s.birthtimeMs),
    };
  },
  watch(dir, options, onChange, onError) {
    const watcher = fsWatch(dir, { recursive: options.recursive, persistent: false }, () => onChange());
    watcher.on("error", onError);
    return { close: () => watcher.close() };
  },
};

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/** A file that finished arriving, with the identity it had then. */
export interface ReadyFile {
  path: string;
  /** `dev:ino:size:mtimeNs` when it was found finished. */
  identity: string;
}

/** The identity used to recognize a file under any name: device, inode, size, modification time. */
export function fileIdentity(s: Pick<WatchStat, "dev" | "ino" | "size" | "mtimeNs">): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
}

export interface FolderWatcherOptions {
  folders: readonly string[];
  /** Files in subfolders count. */
  recursive: boolean;
  /** Media extensions to watch for (lowercase, with dot). */
  extensions: ReadonlySet<string>;
  /** How long a file must stay unchanged. */
  settleMs: number;
  /** Folders never scanned (output folders inside a watched folder). */
  excludedFolders?: readonly string[];
  /** Full rescan interval while file-system events work. Default 30 s. */
  rescanMs?: number;
  /** Full rescan interval when they do not. Default 10 s. */
  pollingRescanMs?: number;
  /** How often arriving files are checked. Default 1 s (at most settleMs / 2). */
  checkMs?: number;
  /** Delay between a file-system event and the rescan it causes. Default 500 ms. */
  eventDelayMs?: number;
  /** Files examined at once. Default 32. */
  statConcurrency?: number;
  /** Files known from elsewhere (the rename history): never handed on. */
  isKnown?: (identity: string, filePath: string) => boolean;
  /** Called before each rescan (to refresh what `isKnown` knows); errors are ignored. */
  beforeScan?: () => Promise<void>;
  fs?: WatchFileSystem;
  clock?: WatchClock;
  platform?: NodeJS.Platform;
  onEvent: (event: WatchEvent) => void;
  onReady: (files: ReadyFile[]) => void;
}

type Stage =
  /** Present at start (or when its folder came back): left alone. */
  | "existing"
  /** Noticed; waiting until it stops changing. */
  | "arriving"
  /** A temporary download name. */
  | "temporary"
  /** Handed on (`onReady`); the pipeline decides what happens. */
  | "queued"
  /** Done: renamed, waiting for review, or recognized as handled. */
  | "handled"
  /** Could not be examined. */
  | "unreadable";

interface Tracked {
  stage: Stage;
  root: string;
  size?: string;
  mtimeNs?: string;
  /** When its size or modification time last changed (or it was first seen). */
  changedAt: number;
}

interface RootState {
  folder: string;
  status: "pending" | "ok" | "missing" | "error";
  errorCode?: string;
  handle?: WatchHandle;
  polling: boolean;
  pollingReported: boolean;
  scanned: boolean;
  scanning: boolean;
  rescanAgain: boolean;
  timer?: unknown;
  timerAt?: number;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GONE = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Normalized, absolute, without duplicates; with `recursive`, a folder
 * inside another watched folder is dropped (it is watched through it).
 */
export function normalizeWatchFolders(
  folders: readonly string[],
  recursive: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  for (const folder of folders) {
    const f = path.resolve(folder);
    if (out.some((o) => isInsideOrEqual(f, o, platform) && (recursive || isInsideOrEqual(o, f, platform)))) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      if (recursive && isInsideOrEqual(out[i]!, f, platform)) out.splice(i, 1);
    }
    out.push(f);
  }
  return out;
}

export class FolderWatcher {
  private readonly options: FolderWatcherOptions;
  private readonly fs: WatchFileSystem;
  private readonly clock: WatchClock;
  private readonly platform: NodeJS.Platform;
  private readonly rescanMs: number;
  private readonly pollingRescanMs: number;
  private readonly checkMs: number;
  private readonly eventDelayMs: number;
  private readonly statConcurrency: number;
  private readonly roots: RootState[];
  private readonly files = new Map<string, Tracked>();
  /** Identities already handled, under any name. */
  private readonly handled = new Set<string>();
  /** Subfolders whose read error was reported (reported again only after they recover). */
  private readonly reportedErrors = new Set<string>();
  private excluded: string[];
  private running = false;
  private checkTimer: unknown;
  private checking = false;

  constructor(options: FolderWatcherOptions) {
    this.options = options;
    this.fs = options.fs ?? nodeWatchFileSystem;
    this.clock = options.clock ?? systemClock;
    this.platform = options.platform ?? process.platform;
    this.rescanMs = options.rescanMs ?? 30_000;
    this.pollingRescanMs = options.pollingRescanMs ?? 10_000;
    this.checkMs = options.checkMs ?? Math.max(100, Math.min(1_000, Math.floor(options.settleMs / 2)));
    this.eventDelayMs = options.eventDelayMs ?? 500;
    this.statConcurrency = options.statConcurrency ?? 32;
    this.roots = normalizeWatchFolders(options.folders, options.recursive, this.platform).map((folder) => ({
      folder,
      status: "pending",
      polling: false,
      pollingReported: false,
      scanned: false,
      scanning: false,
      rescanAgain: false,
    }));
    this.excluded = this.normalizeExcluded(options.excludedFolders ?? []);
  }

  /** The folders actually watched (normalized, nested ones dropped). */
  get folders(): string[] {
    return this.roots.map((r) => r.folder);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Output folders strictly inside a watched folder (a watched folder itself cannot be excluded). */
  private normalizeExcluded(folders: readonly string[]): string[] {
    return folders
      .filter((f) => f.trim() !== "" && path.isAbsolute(f))
      .map((f) => path.resolve(f))
      .filter((f) => this.roots.some((r) => isInsideOrEqual(f, r.folder, this.platform) && !isInsideOrEqual(r.folder, f, this.platform)));
  }

  /** Change the excluded folders (settings changed). */
  setExcludedFolders(folders: readonly string[]): void {
    this.excluded = this.normalizeExcluded(folders);
  }

  private isExcluded(dir: string): boolean {
    return this.excluded.some((e) => isInsideOrEqual(dir, e, this.platform));
  }

  private emit(event: WatchEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // A front end's logging must never stop the watcher.
    }
  }

  /**
   * Start watching. Files already there become "existing". Resolves once
   * every folder has been scanned the first time.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await Promise.all(this.roots.map((root) => this.scan(root)));
    if (!this.running) return;
    this.emit({ type: "started", folders: this.folderInfo() });
    this.scheduleCheck();
  }

  /** Stop watching. What was learned (existing and handled files) is kept, so `start` resumes. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const root of this.roots) {
      root.handle?.close();
      root.handle = undefined;
      if (root.timer !== undefined) this.clock.clearTimeout(root.timer);
      root.timer = undefined;
      root.timerAt = undefined;
    }
    if (this.checkTimer !== undefined) this.clock.clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.emit({ type: "stopped" });
  }

  folderInfo(): WatchFolderInfo[] {
    return this.roots.map((root) => ({
      folder: root.folder,
      status: root.status === "ok" || root.status === "pending" ? "ok" : root.status,
      existing: this.countStage("existing", root.folder),
      polling: root.polling,
    }));
  }

  private countStage(stage: Stage, root?: string): number {
    let n = 0;
    for (const t of this.files.values()) if (t.stage === stage && (root === undefined || t.root === root)) n += 1;
    return n;
  }

  /** Counts for a status display. */
  counts(): { arriving: number; temporary: number; existing: number; queued: number } {
    return {
      arriving: this.countStage("arriving"),
      temporary: this.countStage("temporary"),
      existing: this.countStage("existing"),
      queued: this.countStage("queued"),
    };
  }

  /**
   * Treat the files that were already there as new arrivals (they still
   * have to stay unchanged for the settle period). Returns how many.
   */
  processExisting(): number {
    let n = 0;
    const now = this.clock.now();
    for (const [p, t] of this.files) {
      if (t.stage !== "existing") continue;
      this.files.set(p, { stage: "arriving", root: t.root, changedAt: now });
      n += 1;
    }
    if (n > 0) this.scheduleCheck();
    return n;
  }

  /**
   * Remember files as handled (renamed, waiting for review, created by a
   * rename), so they are never handed on again under any name.
   */
  async markHandled(paths: readonly string[]): Promise<void> {
    await this.mapLimited(paths, async (p) => {
      const abs = path.resolve(p);
      try {
        const s = await this.fs.stat(abs);
        if (s.kind === "file") this.handled.add(fileIdentity(s));
      } catch {
        // Gone already: nothing to recognize later.
      }
      const root = this.roots.find((r) => isInsideOrEqual(abs, r.folder, this.platform));
      if (root) this.files.set(abs, { stage: "handled", root: root.folder, changedAt: this.clock.now() });
    });
  }

  /** Remember an identity as handled (from the rename history, for example). */
  addHandledIdentity(identity: string): void {
    this.handled.add(identity);
  }

  /** A queued file changed again: wait until it stops changing. */
  resettle(filePath: string): void {
    const t = this.files.get(path.resolve(filePath));
    if (!t) return;
    t.stage = "arriving";
    t.size = undefined;
    t.mtimeNs = undefined;
    t.changedAt = this.clock.now();
    this.scheduleCheck();
  }

  /** A queued file disappeared: forget it (it is noticed again if it comes back). */
  forget(filePath: string): void {
    this.files.delete(path.resolve(filePath));
  }

  /** Rescan every folder now (also used by tests). */
  async rescanNow(): Promise<void> {
    await Promise.all(this.roots.map((root) => this.scan(root)));
  }

  /** Check arriving files now (also used by tests). */
  async checkNow(): Promise<void> {
    await this.check();
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  private scheduleScan(root: RootState, delayMs: number): void {
    if (!this.running) return;
    const at = this.clock.now() + delayMs;
    if (root.timer !== undefined) {
      if (root.timerAt !== undefined && root.timerAt <= at) return;
      this.clock.clearTimeout(root.timer);
    }
    root.timerAt = at;
    root.timer = this.clock.setTimeout(() => {
      root.timer = undefined;
      root.timerAt = undefined;
      void this.scan(root);
    }, delayMs);
  }

  private nextRescan(root: RootState): void {
    this.scheduleScan(root, root.polling || !root.handle ? this.pollingRescanMs : this.rescanMs);
  }

  private onFsEvent(root: RootState): void {
    this.scheduleScan(root, this.eventDelayMs);
  }

  private ensureWatch(root: RootState): void {
    if (root.handle || !this.running) return;
    try {
      root.handle = this.fs.watch(
        root.folder,
        { recursive: this.options.recursive },
        () => this.onFsEvent(root),
        (error) => {
          // The watch stopped (folder deleted, Windows EPERM, inotify limits):
          // rescans continue; the next one tries to watch again.
          root.handle?.close();
          root.handle = undefined;
          if (errorCode(error) !== "EPERM" && !GONE.has(errorCode(error))) this.reportPolling(root, errorMessage(error));
          this.scheduleScan(root, this.eventDelayMs);
        },
      );
      root.polling = false;
    } catch (error) {
      root.polling = true;
      this.reportPolling(root, errorMessage(error));
    }
  }

  private reportPolling(root: RootState, message: string): void {
    root.polling = true;
    if (root.pollingReported) return;
    root.pollingReported = true;
    this.emit({ type: "polling", folder: root.folder, message });
  }

  private async scan(root: RootState): Promise<void> {
    if (!this.running) return;
    if (root.scanning) {
      root.rescanAgain = true;
      return;
    }
    root.scanning = true;
    try {
      await this.scanRoot(root);
    } catch (error) {
      // Never let an unexpected error end the watch: report it and try again later.
      this.emit({ type: "folder_error", folder: root.folder, code: errorCode(error), message: errorMessage(error) });
    } finally {
      root.scanning = false;
    }
    if (!this.running) return;
    if (root.rescanAgain) {
      root.rescanAgain = false;
      this.scheduleScan(root, this.eventDelayMs);
    } else {
      this.nextRescan(root);
    }
    this.scheduleCheck();
  }

  private async scanRoot(root: RootState): Promise<void> {
    try {
      await this.options.beforeScan?.();
    } catch {
      // Only a hint: scanning goes on without it.
    }
    let rootStat: WatchStat | undefined;
    let problem: unknown;
    try {
      rootStat = await this.fs.stat(root.folder);
    } catch (error) {
      problem = error;
    }
    if (!this.running) return;

    if (!rootStat || rootStat.kind !== "directory") {
      const code = rootStat ? "ENOTDIR" : errorCode(problem);
      root.handle?.close();
      root.handle = undefined;
      if (GONE.has(code)) {
        if (root.status !== "missing") {
          root.status = "missing";
          this.emit({ type: "folder_missing", folder: root.folder });
        }
      } else if (root.status !== "error" || root.errorCode !== code) {
        root.status = "error";
        root.errorCode = code;
        this.emit({ type: "folder_error", folder: root.folder, code, message: errorMessage(problem) });
      }
      return;
    }

    const wasAway = root.status === "missing" || root.status === "error";
    // Files found at the first scan, or when a folder comes back, are existing.
    const baseline = !root.scanned || wasAway;

    const seen = new Set<string>();
    const fresh: string[] = [];
    const dirs = [root.folder];
    let rootReadable = true;
    while (dirs.length > 0) {
      const dir = dirs.shift()!;
      let entries: WatchDirEntry[];
      try {
        entries = await this.fs.readdir(dir);
        this.reportedErrors.delete(dir);
      } catch (error) {
        const code = errorCode(error);
        if (dir === root.folder) {
          rootReadable = false;
          if (GONE.has(code)) {
            if (root.status !== "missing") {
              root.status = "missing";
              this.emit({ type: "folder_missing", folder: root.folder });
            }
          } else if (root.status !== "error" || root.errorCode !== code) {
            root.status = "error";
            root.errorCode = code;
            this.emit({ type: "folder_error", folder: root.folder, code, message: errorMessage(error) });
          }
          break;
        }
        if (!GONE.has(code) && !this.reportedErrors.has(dir)) {
          this.reportedErrors.add(dir);
          this.emit({ type: "folder_error", folder: dir, code, message: errorMessage(error) });
        }
        // Keep tracking what was known inside an unreadable subfolder.
        for (const [p, t] of this.files) if (t.root === root.folder && isInsideOrEqual(p, dir, this.platform)) seen.add(p);
        continue;
      }
      if (!this.running) return;

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.kind === "directory") {
          if (this.options.recursive && !isSkippedFolderName(entry.name) && !this.isExcluded(full)) dirs.push(full);
          continue;
        }
        if (entry.kind !== "file") continue;
        if (isTemporaryName(entry.name)) {
          const finalName = finalNameOf(entry.name);
          if (!finalName || !this.isMedia(finalName)) continue;
          seen.add(full);
          if (!this.files.has(full)) {
            this.files.set(full, { stage: baseline ? "existing" : "temporary", root: root.folder, changedAt: this.clock.now() });
            if (!baseline) this.emit({ type: "temporary", path: full, finalName });
          }
          continue;
        }
        if (!this.isMedia(entry.name)) continue;
        seen.add(full);
        if (this.files.has(full)) continue;
        if (baseline) {
          this.files.set(full, { stage: "existing", root: root.folder, changedAt: this.clock.now() });
          continue;
        }
        fresh.push(full);
      }
    }
    if (!this.running) return;
    // New files are examined together, a few at a time (thousands may arrive at once).
    await this.mapLimited(fresh, (full) => this.noticeNewFile(full, root.folder));
    if (!this.running) return;

    if (!rootReadable) {
      root.handle?.close();
      root.handle = undefined;
      return;
    }

    // Forget what is no longer there.
    for (const [p, t] of this.files) {
      if (t.root !== root.folder || seen.has(p)) continue;
      if (t.stage === "queued") continue; // the pipeline finds out itself
      this.files.delete(p);
      if (t.stage === "arriving") this.emit({ type: "gone", path: p });
    }

    root.scanned = true;
    root.status = "ok";
    root.errorCode = undefined;
    if (wasAway) {
      this.emit({ type: "folder_restored", folder: root.folder, existing: this.countStage("existing", root.folder) });
    }
    this.ensureWatch(root);
  }

  private isMedia(name: string): boolean {
    return this.options.extensions.has(path.extname(name).toLowerCase());
  }

  /** A media file not seen before: examine it and start waiting for it to finish. */
  private async noticeNewFile(full: string, root: string): Promise<void> {
    let s: WatchStat;
    try {
      s = await this.fs.stat(full);
    } catch (error) {
      const code = errorCode(error);
      if (GONE.has(code)) return;
      this.files.set(full, { stage: "unreadable", root, changedAt: this.clock.now() });
      this.emit({ type: "unreadable", path: full, code, message: errorMessage(error) });
      return;
    }
    if (s.kind !== "file") return;
    const identity = fileIdentity(s);
    if (this.handled.has(identity) || this.options.isKnown?.(identity, full)) {
      // Renamed by TidyTitles (here, in the other front end, or by undo): not new.
      this.handled.add(identity);
      this.files.set(full, { stage: "handled", root, changedAt: this.clock.now() });
      return;
    }
    this.files.set(full, { stage: "arriving", root, size: s.size, mtimeNs: s.mtimeNs, changedAt: this.clock.now() });
    this.emit({ type: "arriving", path: full });
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  private scheduleCheck(): void {
    if (!this.running || this.checkTimer !== undefined || this.checking) return;
    if (this.countStage("arriving") === 0) return;
    this.checkTimer = this.clock.setTimeout(() => {
      this.checkTimer = undefined;
      void this.check();
    }, this.checkMs);
  }

  private rootOk(folder: string): boolean {
    return this.roots.find((r) => r.folder === folder)?.status === "ok";
  }

  private async check(): Promise<void> {
    if (!this.running || this.checking) return;
    this.checking = true;
    try {
      const now = this.clock.now();
      const candidates: string[] = [];
      const arriving = [...this.files].filter(([, t]) => t.stage === "arriving" && this.rootOk(t.root));
      await this.mapLimited(arriving, async ([p, t]) => {
        let s: WatchStat;
        try {
          s = await this.fs.stat(p);
        } catch (error) {
          const code = errorCode(error);
          if (this.files.get(p) !== t) return;
          if (GONE.has(code)) {
            // The whole folder may be gone (unplugged): keep the file and let the rescan decide.
            if (!(await this.rootPresent(t.root))) {
              const root = this.roots.find((r) => r.folder === t.root);
              if (root) this.scheduleScan(root, 0);
              return;
            }
            this.files.delete(p);
            this.emit({ type: "gone", path: p });
          } else {
            t.stage = "unreadable";
            this.emit({ type: "unreadable", path: p, code, message: errorMessage(error) });
          }
          return;
        }
        if (this.files.get(p) !== t || t.stage !== "arriving") return;
        if (s.size !== t.size || s.mtimeNs !== t.mtimeNs || isFinderBusyDate(s.birthtimeMs)) {
          t.size = s.size;
          t.mtimeNs = s.mtimeNs;
          t.changedAt = now;
          return;
        }
        if (now - t.changedAt >= this.options.settleMs) candidates.push(p);
      });
      if (!this.running) return;

      // A companion such as "X.mkv.part" next to the file: still arriving.
      const ready: ReadyFile[] = [];
      const byDir = new Map<string, string[]>();
      for (const p of candidates) {
        const dir = path.dirname(p);
        byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
      }
      for (const [dir, paths] of byDir) {
        let names: Set<string>;
        try {
          names = new Set((await this.fs.readdir(dir)).map((e) => e.name.toLowerCase()));
        } catch {
          continue; // checked again next time
        }
        for (const p of paths) {
          const t = this.files.get(p);
          if (!t || t.stage !== "arriving") continue;
          if (hasCompanion(path.basename(p), names)) {
            t.changedAt = now;
            continue;
          }
          t.stage = "queued";
          ready.push({ path: p, identity: fileIdentity({ dev: "", ino: "", size: t.size!, mtimeNs: t.mtimeNs! }) });
        }
      }
      if (ready.length > 0) {
        // The full identity (with device and inode) is read once more on hand-over.
        const full = await this.withIdentity(ready);
        if (full.length > 0 && this.running) {
          this.emit({ type: "ready", paths: full.map((f) => f.path) });
          this.options.onReady(full);
        }
      }
    } finally {
      this.checking = false;
    }
    this.scheduleCheck();
  }

  private async rootPresent(folder: string): Promise<boolean> {
    try {
      return (await this.fs.stat(folder)).kind === "directory";
    } catch {
      return false;
    }
  }

  private async withIdentity(files: ReadyFile[]): Promise<ReadyFile[]> {
    const out: ReadyFile[] = [];
    await this.mapLimited(files, async (f) => {
      const t = this.files.get(f.path);
      try {
        const s = await this.fs.stat(f.path);
        if (t && (s.size !== t.size || s.mtimeNs !== t.mtimeNs)) {
          this.resettle(f.path);
          return;
        }
        out.push({ path: f.path, identity: fileIdentity(s) });
      } catch {
        this.files.delete(f.path);
        this.emit({ type: "gone", path: f.path });
      }
    });
    // Hand files on in a stable order.
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async mapLimited<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < items.length; i += this.statConcurrency) {
      await Promise.all(items.slice(i, i + this.statConcurrency).map(fn));
    }
  }
}
