/**
 * Names a watch folder leaves alone: files that download tools and copy
 * programs are still writing, and folders that hold no finished media.
 *
 * Download tools write to a temporary name and rename the file when it is
 * complete. Those names are never touched; the finished file is noticed
 * under its final name. Some tools instead write the final name and keep a
 * companion file next to it while they work (Firefox's `X.mkv` plus
 * `X.mkv.part`, aria2's `X.mkv.aria2`): a file with such a companion is
 * still arriving.
 */

import path from "node:path";

/**
 * Suffixes of files that are still being written (lowercase):
 * - `.part`: Firefox, Transmission, wget2, curl's `-C`, many others
 * - `.partial`: Edge (older), Internet Download Manager
 * - `.crdownload`: Chrome, Edge, Brave, Vivaldi
 * - `.download`: Safari (a folder `X.mkv.download` holding the partial file)
 * - `.opdownload`: Opera
 * - `.!qb`: qBittorrent ("append .!qB to incomplete files")
 * - `.!ut`, `.!bt`: µTorrent and BitTorrent
 * - `.bc!`: BitComet; `.jc!`: FlashGet; `.dtapart`: DownThemAll
 * - `.aria2`: aria2's control file; `.xltd`, `.td`: Xunlei / Thunder
 * - `.filepart`: WinSCP; `.!sync`: Resilio Sync
 * - `.tmp`, `.temp`: generic temporary files (also Windows Explorer copies)
 * - `.crswap`: Chrome's File System Access writes
 */
export const TEMPORARY_SUFFIXES: readonly string[] = [
  ".part",
  ".partial",
  ".crdownload",
  ".download",
  ".opdownload",
  ".!qb",
  ".!ut",
  ".!bt",
  ".bc!",
  ".jc!",
  ".dtapart",
  ".aria2",
  ".xltd",
  ".td",
  ".filepart",
  ".!sync",
  ".tmp",
  ".temp",
  ".crswap",
];

/**
 * Companions that mark the file next to them as unfinished: `X` is still
 * arriving while `X<suffix>` exists.
 */
export const COMPANION_SUFFIXES: readonly string[] = [".part", ".aria2", ".crdownload", ".!qb", ".!ut", ".filepart"];

/** macOS "safe save" temporaries: `Name.sb-1a2b3c4d-XyZ123`. */
const SAFE_SAVE = /\.sb-[0-9a-f]+-[0-9a-z]+$/i;

/** Folder names that never hold finished media (lowercase). */
const SKIPPED_FOLDERS = new Set([
  "@eadir", // Synology thumbnails
  "#recycle", // Synology recycle bin
  "#snapshot",
  "$recycle.bin", // Windows recycle bin
  "system volume information",
  "lost+found",
]);

/**
 * True when `name` is a temporary name: hidden (starts with "." — this also
 * covers rsync's `.Name.XXXXXX`, Syncthing's `.syncthing.*.tmp`, and
 * TidyTitles' own `.…tidytitles-tmp` copies), an Office-style `~$` lock,
 * a backup ending in `~`, or one of `TEMPORARY_SUFFIXES`.
 */
export function isTemporaryName(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$") || name.endsWith("~")) return true;
  if (SAFE_SAVE.test(name)) return true;
  const lower = name.toLowerCase();
  return TEMPORARY_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
}

/**
 * The final name a temporary name will get (`Movie.mkv.part` → `Movie.mkv`),
 * or undefined when it does not end with a known suffix.
 */
export function finalNameOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const suffix of TEMPORARY_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) return name.slice(0, -suffix.length);
  }
  return undefined;
}

/** True when `name` (a folder) is skipped while scanning: temporary, hidden, or a system folder. */
export function isSkippedFolderName(name: string): boolean {
  return isTemporaryName(name) || SKIPPED_FOLDERS.has(name.toLowerCase());
}

/** The companion names whose presence means `name` is still arriving. */
export function companionNamesOf(name: string): string[] {
  return COMPANION_SUFFIXES.map((suffix) => `${name}${suffix}`);
}

/**
 * True when `names` (one folder's entries) holds a companion of `name`.
 * Compared without regard to case, since the suffixes vary in case
 * (qBittorrent writes `.!qB`).
 */
export function hasCompanion(name: string, names: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  for (const suffix of COMPANION_SUFFIXES) {
    if (names.has(`${lower}${suffix}`)) return true;
  }
  return false;
}

/**
 * The date Finder gives a file while it copies it (January 24, 1984,
 * 08:00 UTC, the "busy" creation date), so a half-copied file can be told
 * from a finished one on macOS.
 */
export const FINDER_BUSY_BIRTHTIME_MS = Date.UTC(1984, 0, 24, 8, 0, 0);

/** True when a creation time is Finder's "copy in progress" date (allowing a day for time zones). */
export function isFinderBusyDate(birthtimeMs: number | undefined): boolean {
  if (birthtimeMs === undefined) return false;
  return Math.abs(birthtimeMs - FINDER_BUSY_BIRTHTIME_MS) <= 24 * 60 * 60 * 1000;
}

/** True when `child` is `parent` or inside it (case-insensitive where the platform usually is). */
export function isInsideOrEqual(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === "darwin" || platform === "win32";
  const norm = (p: string) => {
    const n = path.resolve(p);
    return fold ? n.toLowerCase() : n;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
