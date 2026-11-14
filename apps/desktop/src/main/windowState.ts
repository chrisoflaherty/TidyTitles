/**
 * Remembering the main window's size and position between launches. The
 * state file lives in Electron's `userData` directory (not in the
 * TidyTitles config directory, which the CLI shares).
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1120, height: 720 } as const;
export const MIN_SIZE = { width: 760, height: 480 } as const;

/** How much of the title bar must be on a display for a saved position to be reused. */
const VISIBLE_MARGIN = { width: 120, height: 40 };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parse saved state; undefined when missing or malformed. */
export function parseWindowState(value: unknown): WindowState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!finite(v.width) || !finite(v.height)) return undefined;
  const state: WindowState = {
    width: Math.round(v.width),
    height: Math.round(v.height),
    maximized: v.maximized === true,
  };
  if (finite(v.x) && finite(v.y)) {
    state.x = Math.round(v.x);
    state.y = Math.round(v.y);
  }
  return state;
}

function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Fit saved state to the current displays: the size is clamped to the
 * minimum and to the largest work area, and the position is dropped (the
 * window is centered) unless the top of the window is visibly on a display.
 */
export function fitToDisplays(
  saved: WindowState | undefined,
  workAreas: readonly Rect[],
): WindowState {
  const largest = workAreas.reduce<Rect | undefined>(
    (best, area) => (!best || area.width * area.height > best.width * best.height ? area : best),
    undefined,
  );
  const maxWidth = largest ? largest.width : Number.POSITIVE_INFINITY;
  const maxHeight = largest ? largest.height : Number.POSITIVE_INFINITY;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

  const base = saved ?? { ...DEFAULT_SIZE, maximized: false };
  const result: WindowState = {
    width: clamp(base.width, MIN_SIZE.width, maxWidth),
    height: clamp(base.height, MIN_SIZE.height, maxHeight),
    maximized: base.maximized,
  };

  if (saved?.x !== undefined && saved.y !== undefined) {
    const titleBar: Rect = { x: saved.x, y: saved.y, width: result.width, height: VISIBLE_MARGIN.height };
    const visible = workAreas.some((area) => {
      const overlap = intersection(titleBar, area);
      return overlap !== undefined && overlap.width >= VISIBLE_MARGIN.width && overlap.height >= VISIBLE_MARGIN.height / 2;
    });
    if (visible) {
      result.x = saved.x;
      result.y = saved.y;
    }
  }
  return result;
}

export async function loadWindowState(file: string): Promise<WindowState | undefined> {
  try {
    return parseWindowState(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Save the window state. Synchronous and atomic (write a temp file, then
 * rename) because it runs while the window is closing: an async write could
 * be cut short when the app quits, leaving an empty or truncated file.
 */
export function saveWindowState(file: string, state: WindowState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(temp, file);
}
