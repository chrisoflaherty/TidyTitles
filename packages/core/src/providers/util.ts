/**
 * Shared helpers for the metadata providers: HTTP plumbing on top of `fetch`,
 * and small parsers that reproduce the Python built-ins the original providers
 * relied on (`int()`, `date.fromisoformat()`).
 */

import { ProviderError } from "../errors";
import type { FetchFn } from "./base";

/** Default per-request timeout, matching the Python httpx clients (30 s). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Query parameters for a provider request. Values keep their JSON type for cache keys. */
export type QueryParams = Record<string, string | number>;

/** Minimal cache interface the providers use. `APICache` implements it. */
export interface ResponseCache {
  get(provider: string, endpoint: string, params: QueryParams): unknown;
  set(
    provider: string,
    endpoint: string,
    params: QueryParams,
    response: unknown,
  ): void;
}

/** A JSON object (not an array, not null). */
export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build `base + endpoint` with URL-encoded query parameters (insertion order). */
export function buildUrl(
  baseUrl: string,
  endpoint: string,
  params?: QueryParams,
): string {
  const url = `${baseUrl}${endpoint}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

/**
 * Send a request with a timeout. Network failures and timeouts are rethrown
 * as `ProviderError` (with the original error as `cause`).
 */
export async function sendRequest(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ProviderError(`${label} request failed: ${reason}`, {
      cause: error,
    });
  }
}

/**
 * Shares one promise among identical requests that are in flight at the
 * same time. With concurrent lookups, every episode of a show asks for the
 * same search before the first response reaches the cache; this makes them
 * one network call. A settled request is forgotten (the cache takes over).
 */
export class InflightRequests<T> {
  private readonly pending = new Map<string, Promise<T>>();

  /** The in-flight promise for `key`, or a new one from `start`. */
  run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = start();
    this.pending.set(key, promise);
    const forget = (): void => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    };
    promise.then(forget, forget);
    return promise;
  }

  /** Number of requests in flight (for tests). */
  get size(): number {
    return this.pending.size;
  }
}

/** A stable in-memory key for a request (not the on-disk cache key). */
export function requestKey(endpoint: string, params: QueryParams): string {
  return JSON.stringify([endpoint, Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
}

/** Retries for HTTP 429 (TMDB and TVDB only; MusicBrainz is never retried). */
export interface RateLimitRetryOptions {
  /** Retries after the first 429 (default 2, so at most 3 attempts). */
  retries?: number;
  /**
   * Longest wait honored, in milliseconds (default 10,000). A `Retry-After`
   * longer than this is not waited out: the 429 is reported at once.
   */
  maxDelayMs?: number;
}

export const DEFAULT_RATE_LIMIT_RETRIES = 2;
export const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
/** Wait used when a 429 carries no usable `Retry-After`. */
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Milliseconds to wait from a `Retry-After` header: delay-seconds or an
 * HTTP date. `undefined` when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP date always has a weekday or month name.
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Send a request, retrying a bounded number of times while the server
 * answers 429, waiting as `Retry-After` asks (or 1 s without one). Returns
 * the last response, which may still be a 429 for the caller to report.
 */
export async function sendWithRateLimitRetry(
  send: () => Promise<Response>,
  options: RateLimitRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RATE_LIMIT_RETRIES;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 429 || attempt >= retries) return response;
    const delay = parseRetryAfter(response.headers.get("Retry-After")) ?? DEFAULT_RETRY_DELAY_MS;
    if (delay > maxDelayMs) return response;
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Parse a response body as JSON, rethrowing parse failures as `ProviderError`. */
export async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError(`${label} returned invalid JSON`, { cause: error });
  }
}

/** Raise a `ProviderError` describing a malformed payload. */
export function malformed(label: string, detail: string): never {
  throw new ProviderError(`Malformed ${label} response: ${detail}`);
}

/** Require a JSON object (Python code would have raised on anything else). */
export function requireObject(value: unknown, label: string, what: string): JsonObject {
  if (!isRecord(value)) malformed(label, `expected ${what} to be an object`);
  return value;
}

/**
 * Read an array that may be absent. Missing or null means empty; any other
 * non-array value is malformed.
 */
export function optionalArray(value: unknown, label: string, what: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) malformed(label, `expected ${what} to be an array`);
  return value;
}

/** Require a key to be present and non-null (Python `obj["key"]`). */
export function requireKey(obj: JsonObject, key: string, label: string): unknown {
  const value = obj[key];
  if (value == null) malformed(label, `missing "${key}"`);
  return value;
}

export function requireString(obj: JsonObject, key: string, label: string): string {
  const value = requireKey(obj, key, label);
  if (typeof value !== "string") malformed(label, `"${key}" is not a string`);
  return value;
}

export function requireNumber(obj: JsonObject, key: string, label: string): number {
  const value = requireKey(obj, key, label);
  if (typeof value !== "number") malformed(label, `"${key}" is not a number`);
  return value;
}

/** A string value, or `undefined` for anything else (absent, null, wrong type). */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A number value, or `undefined` for anything else. */
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Python truthiness for JSON values. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

const PY_INT_STRING = /^\s*[+-]?\d(?:_?\d)*\s*$/;

/**
 * Python `int(value)` for JSON values: integers and numeric strings convert,
 * floats truncate toward zero, booleans become 0/1. Returns `undefined` where
 * Python would raise `ValueError` or `TypeError`.
 */
export function pyInt(value: unknown): number | undefined {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value === "string" && PY_INT_STRING.test(value)) {
    return Number.parseInt(value.replace(/_/g, "").trim(), 10);
  }
  return undefined;
}

/**
 * Python `int(value[:4])`: the leading four characters of a string as an
 * integer, or `undefined` if that fails (including non-string input).
 */
export function yearPrefix(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  return pyInt(value.slice(0, 4));
}

const ISO_EXTENDED = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_BASIC = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * Python `date.fromisoformat(value)` for calendar dates ("YYYY-MM-DD" or
 * "YYYYMMDD"). Returns the normalized "YYYY-MM-DD" string, or `undefined`
 * where Python would raise `ValueError`.
 */
export function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_EXTENDED.exec(value) ?? ISO_BASIC.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return undefined;
  const daysInMonth = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 ? (isLeap ? 29 : 28) : daysInMonth;
  if (day > maxDay) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** The year of an ISO "YYYY-MM-DD" date string. */
export function isoDateYear(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}
