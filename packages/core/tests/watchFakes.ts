/** A fake clock and an in-memory file system for watch-folder tests (no real timers or events). */

import path from "node:path";
import type { WatchClock, WatchDirEntry, WatchFileSystem, WatchHandle, WatchStat } from "../src/watcher";

/** Let pending promise chains run (in-memory file operations resolve at once). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements WatchClock {
  private time: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start = Date.UTC(2026, 10, 21, 17, 0, 0)) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.time + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward, running every timer that falls due (and what it schedules). */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.time = Math.max(this.time, next.at);
      next.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

interface MemFile {
  size: number;
  mtimeNs: bigint;
  ino: number;
  birthtimeMs: number;
}

function enoent(p: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, '${p}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function coded(code: string, p: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: operation not permitted, '${p}'`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** An in-memory file system with absolute POSIX-style or native paths. */
export class MemoryFs implements WatchFileSystem {
  readonly files = new Map<string, MemFile>();
  readonly dirs = new Set<string>();
  /** Paths whose readdir/stat fail with this code. */
  readonly errors = new Map<string, string>();
  readonly watchers: Array<{ dir: string; onChange: () => void; onError: (e: unknown) => void; closed: boolean }> = [];
  /** When set, `watch` throws this code (e.g. ENOSPC for the inotify limit). */
  watchThrows: string | undefined;
  /** Counts of calls, to check that a big folder is not examined over and over. */
  statCalls = 0;
  readdirCalls = 0;
  private nextIno = 100;
  private clock: { now(): number };

  constructor(clock: { now(): number }) {
    this.clock = clock;
  }

  private norm(p: string): string {
    return path.resolve(p);
  }

  mkdir(dir: string): void {
    let d = this.norm(dir);
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }

  /** Create or replace a file (new inode), or grow/touch it with `append`. */
  write(p: string, size = 0): string {
    const full = this.norm(p);
    this.mkdir(path.dirname(full));
    this.files.set(full, {
      size,
      mtimeNs: BigInt(this.clock.now()) * 1_000_000n,
      ino: this.nextIno++,
      birthtimeMs: this.clock.now(),
    });
    return full;
  }

  /** Append bytes (same inode, new size and modification time). */
  append(p: string, bytes: number): void {
    const f = this.files.get(this.norm(p));
    if (!f) throw enoent(p);
    f.size += bytes;
    f.mtimeNs = BigInt(this.clock.now()) * 1_000_000n + 1n * BigInt(f.size);
  }

  setBirthtime(p: string, ms: number): void {
    this.files.get(this.norm(p))!.birthtimeMs = ms;
  }

  rename(from: string, to: string): void {
    const f = this.files.get(this.norm(from));
    if (!f) throw enoent(from);
    this.files.delete(this.norm(from));
    this.mkdir(path.dirname(this.norm(to)));
    this.files.set(this.norm(to), f);
  }

  remove(p: string): void {
    this.files.delete(this.norm(p));
  }

  /** Remove a folder and everything in it (an unplugged drive). */
  removeDir(dir: string): void {
    const d = this.norm(dir);
    const inside = (p: string) => p === d || p.startsWith(d + path.sep);
    for (const p of [...this.files.keys()]) if (inside(p)) this.files.delete(p);
    for (const p of [...this.dirs]) if (inside(p)) this.dirs.delete(p);
  }

  /** Simulate a file-system event for watchers of `dir` (or a folder above it). */
  fire(p: string): void {
    const full = this.norm(p);
    for (const w of this.watchers) {
      if (!w.closed && (full === w.dir || full.startsWith(w.dir + path.sep))) w.onChange();
    }
  }

  failWatchers(error: unknown): void {
    for (const w of this.watchers) if (!w.closed) w.onError(error);
  }

  async readdir(dir: string): Promise<WatchDirEntry[]> {
    this.readdirCalls += 1;
    const d = this.norm(dir);
    const code = this.errors.get(d);
    if (code) throw coded(code, d);
    if (!this.dirs.has(d)) throw enoent(d);
    const out: WatchDirEntry[] = [];
    for (const sub of this.dirs) if (path.dirname(sub) === d && sub !== d) out.push({ name: path.basename(sub), kind: "directory" });
    for (const file of this.files.keys()) if (path.dirname(file) === d) out.push({ name: path.basename(file), kind: "file" });
    return out;
  }

  async stat(p: string): Promise<WatchStat> {
    this.statCalls += 1;
    const full = this.norm(p);
    const code = this.errors.get(full);
    if (code) throw coded(code, full);
    if (this.dirs.has(full)) return { kind: "directory", dev: "1", ino: "1", size: "0", mtimeNs: "0" };
    const f = this.files.get(full);
    if (!f) throw enoent(full);
    return {
      kind: "file",
      dev: "1",
      ino: String(f.ino),
      size: String(f.size),
      mtimeNs: String(f.mtimeNs),
      birthtimeMs: f.birthtimeMs,
    };
  }

  watch(dir: string, _options: { recursive: boolean }, onChange: () => void, onError: (e: unknown) => void): WatchHandle {
    if (this.watchThrows) throw coded(this.watchThrows, dir);
    const w = { dir: this.norm(dir), onChange, onError, closed: false };
    this.watchers.push(w);
    return { close: () => void (w.closed = true) };
  }
}
