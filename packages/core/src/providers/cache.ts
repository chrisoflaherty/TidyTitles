/**
 * API response caching: a simple file-based cache, one JSON file per entry.
 *
 * Entry files are compatible with the Python app's cache: keys are computed
 * the same way (first 16 hex chars of SHA-256 over
 * `provider:endpoint:json.dumps(params, sort_keys=True)`), and expiry
 * timestamps are naive local ISO strings like Python's `datetime.isoformat()`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isRecord, type QueryParams, type ResponseCache } from "./util";

/** Default time-to-live for cached responses: 24 hours. */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
      try {
        const data: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (!isRecord(data)) throw new Error("invalid entry");
        const expiresAt = parsePythonIsoDateTime(data.expires_at);
        if (expiresAt === undefined) throw new Error("invalid expiry");
        if (now > expiresAt) {
          rmSync(file, { force: true });
          count += 1;
        }
      } catch {
        rmSync(file, { force: true });
        count += 1;
      }
    }
    return count;
  }

  private entryFiles(): string[] {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(this.cacheDir, name))
      .filter((file) => statSync(file).isFile());
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
