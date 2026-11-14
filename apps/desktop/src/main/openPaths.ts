/**
 * Files and folders opened with the app from outside the window: dropped on
 * the Dock icon or chosen in Finder's "Open With" (macOS `open-file`), or
 * named on the command line (Windows and Linux, including files dragged onto
 * the app's shortcut or exe), at first launch or by a second instance.
 *
 * Everything here is untrusted input. No Electron imports, so it is tested
 * in plain Node.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

/** At most this many paths per launch or `open-file` burst (the IPC limit for a drop). */
export const MAX_OPENED_PATHS = 10_000;
const MAX_PATH_LENGTH = 4_096;
const SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export interface ArgvContext {
  /**
   * `process.defaultApp`: true when Electron runs an app from a path
   * (`electron .`, `electron out/main/index.js`, Playwright), where the
   * arguments before the app's path are Electron's and Node's own.
   */
  defaultApp: boolean;
  /** `app.getAppPath()`, used to find the app's own path among the arguments. */
  appPath: string;
  /** The directory relative paths are resolved against. */
  cwd: string;
}

/** Whether `arg` names the app being run by a development Electron. */
function isAppArgument(arg: string, ctx: ArgvContext): boolean {
  const resolved = path.resolve(ctx.cwd, arg);
  const appPath = path.resolve(ctx.appPath);
  if (resolved === appPath) return true;
  return SCRIPT_EXTENSIONS.has(path.extname(resolved)) && path.dirname(resolved) === appPath;
}

/**
 * Candidate paths from a command line: every argument after the executable
 * (and, for a development Electron, after the app's own path) that is not a
 * switch. Switches start with "-" (Chromium and Electron's `--user-data-dir=…`,
 * `--inspect=0`, Node's `-r`, macOS's old `-psn_…`). Relative paths are
 * resolved against `ctx.cwd`. Nothing is checked on disk here.
 */
export function pathsFromArgv(argv: readonly string[], ctx: ArgvContext): string[] {
  let rest = argv.slice(1);
  if (ctx.defaultApp) {
    const appIndex = rest.findIndex((arg) => !arg.startsWith("-") && isAppArgument(arg, ctx));
    // Unknown layout: take nothing rather than mistake Electron's arguments for files.
    if (appIndex < 0) return [];
    rest = rest.slice(appIndex + 1);
  }
  const paths: string[] = [];
  for (const arg of rest) {
    if (arg === "" || arg.startsWith("-")) continue;
    if (arg.length > MAX_PATH_LENGTH || arg.includes("\0")) continue;
    paths.push(path.resolve(ctx.cwd, arg));
  }
  return paths;
}

/**
 * Keep the paths that are absolute, plausible, and exist as a file or a
 * folder, without duplicates, in their original order.
 */
export async function existingPaths(candidates: readonly unknown[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates.slice(0, MAX_OPENED_PATHS)) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) continue;
    if (candidate.includes("\0") || !path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) continue;
    try {
      const info = await stat(normalized);
      if (!info.isFile() && !info.isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Data a second instance hands the running one (`requestSingleInstanceLock`'s
 * `additionalData`): the files macOS gave it through `open-file`, which are
 * not in its command line. Untrusted: any process can claim the lock.
 */
export interface SecondInstanceData {
  openedPaths: string[];
}

export function openedPathsFromData(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const paths = (data as { openedPaths?: unknown }).openedPaths;
  return Array.isArray(paths) ? paths.slice(0, MAX_OPENED_PATHS) : [];
}

/**
 * Opened paths waiting for the renderer. Paths arrive before the window
 * exists (macOS sends `open-file` before the app is ready) and in bursts
 * (one `open-file` per file), so they collect here until the renderer takes
 * them, which it does only when it would accept a drop.
 */
export class OpenedPathsQueue {
  private paths: string[] = [];

  add(paths: readonly string[]): void {
    for (const p of paths) {
      if (this.paths.length >= MAX_OPENED_PATHS) break;
      if (!this.paths.includes(p)) this.paths.push(p);
    }
  }

  get size(): number {
    return this.paths.length;
  }

  /** Remove and return everything queued. */
  take(): string[] {
    const taken = this.paths;
    this.paths = [];
    return taken;
  }
}
