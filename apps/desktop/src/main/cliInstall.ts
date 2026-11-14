/**
 * "Install Command Line Tool…": put a `tidytitles` launcher on the PATH that
 * runs the bundled CLI (`<resources>/cli/tidytitles.mjs`) with the app's own
 * Electron binary in Node mode. No Electron imports, so it is testable.
 */

import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LAUNCHER_NAME = "tidytitles";
/** Marks launchers this app wrote, so reinstalling can replace them without asking. */
export const LAUNCHER_MARKER = "# Installed by TidyTitles: command-line tool launcher";

export interface CliLocations {
  /** The app's executable (Electron binary, or the AppImage file). */
  executable: string;
  /** The CLI bundle the launcher runs. */
  bundle: string;
  /** Set when the bundle must be copied out first (AppImage mounts change each run). */
  copyBundleFrom?: string;
}

export type CliAvailability =
  | { available: true; locations: CliLocations }
  | { available: false; reason: string };

export interface CliEnvironment {
  platform: NodeJS.Platform;
  execPath: string;
  resourcesPath: string;
  env: Record<string, string | undefined>;
  homedir: string;
}

export function defaultCliEnvironment(): CliEnvironment {
  return {
    platform: process.platform,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    env: process.env,
    homedir: os.homedir(),
  };
}

/** Where the bundled CLI is, or why the menu item is unavailable. */
export function resolveCliAvailability(ctx: CliEnvironment): CliAvailability {
  const bundled = path.join(ctx.resourcesPath ?? "", "cli", "tidytitles.mjs");
  if (!ctx.resourcesPath || !existsSync(bundled)) {
    return {
      available: false,
      reason: "The command-line tool is not bundled with this build. Build packages/cli and package the app to include it.",
    };
  }
  const appImage = ctx.platform === "linux" ? ctx.env.APPIMAGE : undefined;
  if (appImage) {
    // The AppImage is mounted at a new path on every launch: run the AppImage
    // file itself, with a copy of the bundle in a stable place.
    const dataHome = ctx.env.XDG_DATA_HOME?.trim() || path.join(ctx.homedir, ".local", "share");
    return {
      available: true,
      locations: {
        executable: appImage,
        bundle: path.join(dataHome, "TidyTitles", "cli", "tidytitles.mjs"),
        copyBundleFrom: bundled,
      },
    };
  }
  return { available: true, locations: { executable: ctx.execPath, bundle: bundled } };
}

/** Quote a string for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The launcher script for macOS and Linux. */
export function launcherScript(locations: CliLocations): string {
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    "# Runs the TidyTitles CLI with the app's bundled runtime.",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(locations.executable)} ${shellQuote(locations.bundle)} "$@"`,
    "",
  ].join("\n");
}

/** PowerShell command for Windows users (no installer changes yet). */
export function windowsCommand(locations: CliLocations): string {
  // PowerShell ends a single-quoted string on "'" and on the typographic
  // single quotes U+2018 to U+201B; each is escaped by doubling it.
  const q = (s: string) => `'${s.replace(/['\u2018-\u201B]/g, "$&$&")}'`;
  return (
    `function tidytitles { $env:ELECTRON_RUN_AS_NODE = '1'; ` +
    `& ${q(locations.executable)} ${q(locations.bundle)} @args; ` +
    `Remove-Item Env:ELECTRON_RUN_AS_NODE }`
  );
}

async function isWritableDir(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return false;
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `/usr/local/bin` when it exists and is writable, else `~/.local/bin`. */
export async function chooseBinDir(homedir: string, systemDir = "/usr/local/bin"): Promise<string> {
  if (await isWritableDir(systemDir)) return systemDir;
  return path.join(homedir, ".local", "bin");
}

export type ExistingLauncher = "none" | "ours" | "other";

export async function inspectExisting(target: string): Promise<ExistingLauncher> {
  try {
    await lstat(target);
  } catch {
    return "none";
  }
  try {
    const text = await readFile(target, "utf8");
    return text.includes(LAUNCHER_MARKER) ? "ours" : "other";
  } catch {
    return "other";
  }
}

/** Write the launcher (and copy the bundle when needed). Returns the launcher path. */
export async function installLauncher(locations: CliLocations, binDir: string): Promise<string> {
  if (locations.copyBundleFrom) {
    await mkdir(path.dirname(locations.bundle), { recursive: true });
    await copyFile(locations.copyBundleFrom, locations.bundle);
  }
  await mkdir(binDir, { recursive: true });
  const target = path.join(binDir, LAUNCHER_NAME);
  await writeFile(target, launcherScript(locations), { encoding: "utf8", mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

/** True when `dir` is one of the entries of a PATH string. */
export function pathContains(pathValue: string, dir: string, delimiter = path.delimiter): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\/+$/, "");
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => norm(entry) === norm(dir));
}

const PATH_START = "__TIDYTITLES_PATH_START__";
const PATH_END = "__TIDYTITLES_PATH_END__";

/**
 * The PATH a new terminal would have. Apps launched from the Finder or a
 * desktop launcher get a minimal PATH, so ask the user's login shell; fall
 * back to this process's PATH.
 */
export function loginShellPath(env: Record<string, string | undefined>, timeoutMs = 5_000): Promise<string> {
  const fallback = env.PATH ?? "";
  const shell = env.SHELL;
  if (!shell || !path.isAbsolute(shell)) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${PATH_START}' "$PATH" '${PATH_END}'`],
      { timeout: timeoutMs, env: { ...env, ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv },
      (error, stdout) => {
        const text = String(stdout ?? "");
        const start = text.lastIndexOf(PATH_START);
        const end = text.lastIndexOf(PATH_END);
        if (!error && start >= 0 && end > start) resolve(text.slice(start + PATH_START.length, end));
        else resolve(fallback);
      },
    );
  });
}
