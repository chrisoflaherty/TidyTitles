/**
 * Formatting for display. Every Intl call passes "en-US" explicitly: dates
 * are month-first, times use the 12-hour clock, numbers use comma grouping.
 */

const NUMBER = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return NUMBER.format(n);
}

/** "1 file", "1,204 files". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${NUMBER.format(n)} ${n === 1 ? one : many}`;
}

/** Parse a history timestamp ("2026-11-14T19:05:42.123000", local time, no offset). */
export function parseLocalTimestamp(timestamp: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(timestamp);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const DAY_TIME = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const DAY_TIME_YEAR = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "Saturday, November 14 at 7:05 PM" (with the year when it is not this year). */
export function formatTimestamp(timestamp: string, now: Date = new Date()): string {
  const date = parseLocalTimestamp(timestamp);
  if (!date) return timestamp;
  return (date.getFullYear() === now.getFullYear() ? DAY_TIME : DAY_TIME_YEAR).format(date);
}

const RELEASE_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "1999-03-31" -> "March 31, 1999". */
export function formatReleaseDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return RELEASE_DATE.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/** 355000 -> "5:55". */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${NUMBER.format(minutes)}:${String(seconds).padStart(2, "0")}`;
}

/** The last path component, for either separator. */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** The directory part of a path, for either separator. */
export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

/**
 * `target` relative to `dir` when it is inside it ("Queen/A Night at the
 * Opera (1975)/11 - Bohemian Rhapsody.mp3"), else the full path.
 */
export function relativeTo(dir: string, target: string): string {
  for (const sep of ["/", "\\"]) {
    const prefix = dir.endsWith(sep) ? dir : dir + sep;
    if (target.startsWith(prefix)) return target.slice(prefix.length);
  }
  return target;
}

/** Keyboard shortcut text for the platform: "⌘O" on macOS, "Ctrl+O" elsewhere. */
export function shortcut(platform: string, key: string, { shift = false } = {}): string {
  if (platform === "darwin") return `${shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${shift ? "Shift+" : ""}${key}`;
}
