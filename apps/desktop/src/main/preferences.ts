/**
 * Desktop-only preferences, stored in Electron's `userData` directory next
 * to the window state. They are not in config.toml: that file is shared with
 * the command-line tool and the Python app, which have no use for them.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AppPreferences {
  /** "Check for updates automatically". */
  autoCheckForUpdates: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = { autoCheckForUpdates: true };

export const PREFERENCES_FILE = "preferences.json";

export function parsePreferences(value: unknown): AppPreferences {
  const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    autoCheckForUpdates:
      typeof v.autoCheckForUpdates === "boolean" ? v.autoCheckForUpdates : DEFAULT_PREFERENCES.autoCheckForUpdates,
  };
}

export async function loadPreferences(file: string): Promise<AppPreferences> {
  try {
    return parsePreferences(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Atomic write (temp file, then rename), like the window state. */
export function savePreferences(file: string, preferences: AppPreferences): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(preferences, null, 2) + "\n", "utf8");
  renameSync(temp, file);
}
