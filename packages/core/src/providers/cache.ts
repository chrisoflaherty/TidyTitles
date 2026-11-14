/**
 * API response caching: a simple file-based cache, one JSON file per entry.
 *
 * Entry files are compatible with the Python app's cache: keys are computed
 * the same way (first 16 hex chars of SHA-256 over
 * `provider:endpoint:json.dumps(params, sort_keys=True)`), and expiry
 * timestamps are naive local ISO strings like Python's `datetime.isoformat()`.
 *
 * Expired entries are removed when read again, by `clearExpired()`, and by
 * `scheduleCleanup()`, which the session runs in the background at most
 * once a day (tracked by the modification time of `CLEANUP_STAMP_FILE`,
 * which is not a `.json` file, so the Python app ignores it).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { isRecord, type QueryParams, type ResponseCache } from "./util";

/** Default time-to-live for cached responses: 24 hours. */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** File in the cache directory whose modification time records the last cleanup. */
export const CLEANUP_STAMP_FILE = "last-cleanup";

/** Background cleanup runs at most this often: once a day. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ScheduleCleanupOptions {
  /** Wait before starting, so cleanup stays out of startup. Default 500 ms. */
  delayMs?: number;
  /** Minimum time since the last cleanup. Default `CLEANUP_INTERVAL_MS`. */
  intervalMs?: number;
  /** Entries examined per step; each step is one short synchronous burst. Default 25. */
  batchSize?: number;
}

/** What an entry file holds, for cleanup. */
type EntryState = "fresh" | "expired" | "invalid";

/**
 * An unreadable entry younger than this is left alone by the background
 * cleanup: another process (or the Python app) may be writing it.
 */
const UNREADABLE_GRACE_MS = 60 * 60 * 1000;

/** Cache directories with a background cleanup running in this process. */
const cleanupsRunning = new Set<string>();

export interface APICacheOptions {
  /** Directory to store cache files. Created (recursively) if missing. */
  cacheDir: string;
  /** Default time-to-live in milliseconds (default 24 hours). */
  defaultTtlMs?: number;
}

/** Simple file-based cache for API responses. */
export class APICache implements ResponseCache {
  readonly cacheDir: string;
  readonly defaultTtlMs: number;

  constructor(options: APICacheOptions) {
    this.cacheDir = options.cacheDir;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_CACHE_TTL_MS;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private cachePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  /** Retrieve a cached response if present and not expired; otherwise `undefined`. */
  get(provider: string, endpoint: string, params: QueryParams): unknown {
    const file = this.cachePath(cacheKey(provider, endpoint, params));
    if (!existsSync(file)) return undefined;

    try {
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(data) || !("response" in data)) throw new Error("invalid entry");
      const expiresAt = parsePythonIsoDateTime(data.expires_at);
      if (expiresAt === undefined) throw new Error("invalid expiry");

      if (Date.now() > expiresAt) {
        rmSync(file, { force: true });
        return undefined;
      }
      return data.response ?? undefined;
    } catch {
      // Invalid cache file: remove it.
      rmSync(file, { force: true });
      return undefined;
    }
  }

  /** Store a response. A `ttlMs` of 0 or `undefined` uses the default TTL. */
  set(
    provider: string,
    endpoint: string,
    params: QueryParams,
    response: unknown,
    ttlMs?: number,
  ): void {
    const file = this.cachePath(cacheKey(provider, endpoint, params));
    const now = Date.now();
    const entry = {
      response,
      expires_at: formatPythonIsoDateTime(now + (ttlMs || this.defaultTtlMs)),
      cached_at: formatPythonIsoDateTime(now),
      provider,
      endpoint,
    };
    writeFileSync(file, JSON.stringify(entry, null, 2));
  }

  /**
   * Clear cached responses, optionally only those for one provider.
   * Unreadable entries are always removed. Returns the number removed.
   */
  clear(provider?: string): number {
    let count = 0;
    for (const file of this.entryFiles()) {
      try {
        if (provider) {
          const data: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (!isRecord(data)) throw new Error("invalid entry");
          if (data.provider !== provider) continue;
        }
        rmSync(file, { force: true });
        count += 1;
      } catch {
        rmSync(file, { force: true });
        count += 1;
      }
    }
    return count;
  }

  /** Remove expired (and unreadable) entries. Returns the number removed. */
  clearExpired(): number {
    let count = 0;
    const now = Date.now();
    for (const file of this.entryFiles()) {
      if (entryState(file, now) !== "fresh") {
        rmSync(file, { force: true });
        count += 1;
      }
    }
    return count;
  }

  /**
   * Remove expired entries in the background, at most once per
   * `intervalMs` across processes (the stamp file records the last
   * completed run). Returns at once; never throws.
   *
   * The work is split into small synchronous steps on unref'd timers, so
   * it never blocks for long and never keeps a process alive: a CLI run
   * that ends first simply leaves the rest (and the stamp) for next time.
   * Unreadable entries are removed only when older than an hour, in case
   * another process is writing them.
   *
   * The promise resolves with the number of entries removed, or
   * `undefined` when cleanup was not due or already running. It may never
   * resolve if the process exits first.
   */
  scheduleCleanup(options: ScheduleCleanupOptions = {}): Promise<number | undefined> {
    const delayMs = options.delayMs ?? 500;
    const intervalMs = options.intervalMs ?? CLEANUP_INTERVAL_MS;
    const batchSize = Math.max(1, options.batchSize ?? 25);
    const stamp = path.join(this.cacheDir, CLEANUP_STAMP_FILE);
    const dirKey = path.resolve(this.cacheDir);

    try {
      if (cleanupsRunning.has(dirKey)) return Promise.resolve(undefined);
      const last = statIfExists(stamp)?.mtimeMs;
      // A stamp far in the future (clock changes) does not block cleanup forever.
      if (last !== undefined && Math.abs(Date.now() - last) < intervalMs) {
        return Promise.resolve(undefined);
      }
    } catch {
      return Promise.resolve(undefined);
    }

    cleanupsRunning.add(dirKey);
    return new Promise<number | undefined>((resolve) => {
      let files: string[] | undefined;
      let next = 0;
      let removed = 0;
      const finish = (result: number | undefined): void => {
        cleanupsRunning.delete(dirKey);
        resolve(result);
      };
      const step = (): void => {
        try {
          files ??= readdirSync(this.cacheDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => path.join(this.cacheDir, name));
          const now = Date.now();
          const end = Math.min(files.length, next + batchSize);
          for (; next < end; next++) {
            const file = files[next]!;
            const state = entryState(file, now);
            if (state === "fresh") continue;
            if (state === "invalid") {
              const stat = statIfExists(file);
              if (!stat || !stat.isFile() || now - stat.mtimeMs < UNREADABLE_GRACE_MS) continue;
            }
            rmSync(file, { force: true });
            removed += 1;
          }
          if (next < files.length) {
            setTimeout(step, 0).unref();
            return;
          }
          touchStamp(stamp);
          finish(removed);
        } catch {
          // Cleanup is best effort; try again next time.
          finish(undefined);
        }
      };
      setTimeout(step, delayMs).unref();
    });
  }

  private entryFiles(): string[] {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(this.cacheDir, name))
      .filter((file) => statSync(file).isFile());
  }
}

/** Whether an entry file is still valid. Missing files count as fresh (nothing to do). */
function entryState(file: string, now: number): EntryState {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "fresh" : "invalid";
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!isRecord(data)) return "invalid";
    const expiresAt = parsePythonIsoDateTime(data.expires_at);
    if (expiresAt === undefined) return "invalid";
    return now > expiresAt ? "expired" : "fresh";
  } catch {
    return "invalid";
  }
}

function statIfExists(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

function touchStamp(stamp: string): void {
  const now = new Date();
  try {
    utimesSync(stamp, now, now);
  } catch {
    writeFileSync(stamp, "");
  }
}

/** The cache key for a request: identical to the Python `_get_cache_key`. */
export function cacheKey(
  provider: string,
  endpoint: string,
  params: QueryParams,
): string {
  const content = `${provider}:${endpoint}:${pythonJsonDumps(params)}`;
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Python `json.dumps(value, sort_keys=True)` with its default separators
 * (", " and ": ") and `ensure_ascii=True`.
 */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u007f-￿]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) {
    return `[${value.map(pythonJsonDumps).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${pythonJsonDumps(k)}: ${pythonJsonDumps(v)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(String(value));
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Format epoch milliseconds as a naive local timestamp, the way Python's
 * `datetime.now().isoformat()` does ("YYYY-MM-DDTHH:MM:SS[.ffffff]").
 */
export function formatPythonIsoDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const base =
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ms = d.getMilliseconds();
  return ms === 0 ? base : `${base}.${pad(ms * 1000, 6)}`;
}

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Parse a Python `datetime.isoformat()` string into epoch milliseconds.
 * Naive timestamps are local time; "Z" or an offset is honored. Returns
 * `undefined` for anything unparseable.
 */
export function parsePythonIsoDateTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = ISO_DATETIME.exec(value);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  const ms = m[7] ? Math.floor(Number(m[7].padEnd(6, "0")) / 1000) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  const tz = m[8];
  if (tz === undefined) {
    const local = new Date(year, month - 1, day, hour, minute, second, ms);
    if (local.getDate() !== day) return undefined;
    return local.getTime();
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (tz === "Z") return utc;
  const sign = tz.startsWith("-") ? -1 : 1;
  const digits = tz.slice(1).replace(":", "");
  const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0);
  return utc - sign * offsetMinutes * 60_000;
}
