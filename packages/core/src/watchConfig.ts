/**
 * `[watch]` in config.toml: watch folders for new media files.
 *
 * ```toml
 * [watch]
 * enabled = false            # the desktop app watches while it is open
 * folders = []               # absolute paths
 * recursive = true           # files in subfolders count too
 * mode = "review"            # "review" or "automatic"
 * settle_seconds = 10        # a file must stop changing this long first
 * ```
 *
 * A TidyTitles addition (the Python app had no watch folders). Every key is
 * optional; a config.toml without the table loads with these defaults.
 */

import { z } from "zod";

/**
 * What happens to a new file once it has finished arriving:
 * - "review": it is looked up and waits for the user to confirm
 * - "automatic": it is renamed without asking when its match is
 *   unambiguous (see `watchBatch.ts`); every other file waits for review
 */
export type WatchMode = "review" | "automatic";
export const WATCH_MODES: readonly WatchMode[] = ["review", "automatic"];

export function isWatchMode(value: unknown): value is WatchMode {
  return typeof value === "string" && (WATCH_MODES as readonly string[]).includes(value);
}

/** Seconds a file must stay unchanged (size and modification time) before it is touched. */
export const DEFAULT_SETTLE_SECONDS = 10;
export const SETTLE_SECONDS_RANGE = { min: 2, max: 3_600 } as const;

/** At most this many watch folders. */
export const MAX_WATCH_FOLDERS = 50;

/** `[watch]`: watch folders. */
export interface WatchSettings {
  /** Watch while the desktop app is open. Default false. */
  enabled: boolean;
  /** Folders to watch (absolute paths). */
  folders: string[];
  /** Files in subfolders count too. Default true. */
  recursive: boolean;
  /** Default "review". */
  mode: WatchMode;
  /** Default DEFAULT_SETTLE_SECONDS. */
  settleSeconds: number;
}

const TRUE_STRINGS = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_STRINGS = new Set(["0", "off", "f", "false", "n", "no"]);

function coerceBool(value: unknown): unknown {
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(s)) return true;
    if (FALSE_STRINGS.has(s)) return false;
  }
  return value;
}

function coerceInt(value: unknown): unknown {
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  if (typeof value === "bigint") return Number(value);
  return value;
}

/**
 * Folders from the environment arrive as one string: a JSON array
 * (`FILE_RENAMER_WATCH__FOLDERS='["/a","/b"]'`) or a single folder.
 */
function coerceFolders(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s === "") return [];
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return value;
    }
  }
  return [s];
}

/** Trimmed, without empty entries or duplicates, in their order. */
function cleanFolders(folders: string[]): string[] {
  const out: string[] = [];
  for (const folder of folders) {
    const f = folder.trim();
    if (f !== "" && !out.includes(f)) out.push(f);
  }
  return out;
}

/** The `[watch]` table on disk (snake_case keys). */
export const watchSchema = z.object({
  enabled: z.preprocess(coerceBool, z.boolean()).default(false),
  folders: z
    .preprocess(coerceFolders, z.array(z.string()).max(MAX_WATCH_FOLDERS))
    .transform(cleanFolders)
    .default([]),
  recursive: z.preprocess(coerceBool, z.boolean()).default(true),
  mode: z.enum(WATCH_MODES as [WatchMode, ...WatchMode[]]).default("review"),
  settle_seconds: z
    .preprocess(coerceInt, z.number().int().min(SETTLE_SECONDS_RANGE.min).max(SETTLE_SECONDS_RANGE.max))
    .default(DEFAULT_SETTLE_SECONDS),
});

export type RawWatchSettings = z.output<typeof watchSchema>;

export function watchFromRaw(raw: RawWatchSettings): WatchSettings {
  return {
    enabled: raw.enabled,
    folders: [...raw.folders],
    recursive: raw.recursive,
    mode: raw.mode,
    settleSeconds: raw.settle_seconds,
  };
}

/** config.toml lines for `[watch]`, given a TOML string quoting function. */
export function watchToTomlLines(watch: WatchSettings, quote: (s: string) => string): string[] {
  return [
    "[watch]",
    `enabled = ${watch.enabled}`,
    `folders = [${watch.folders.map(quote).join(", ")}]`,
    `recursive = ${watch.recursive}`,
    `mode = ${quote(watch.mode)}`,
    `settle_seconds = ${watch.settleSeconds}`,
  ];
}
