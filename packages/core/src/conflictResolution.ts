/**
 * Conflict resolution strategies for file renaming.
 *
 * Ported from the original Python app's `core/conflict_resolution.py`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathStem, pathSuffix } from "./associatedFiles";
import { willOverwrite, type RenameOperation } from "./models";

/**
 * Strategy for handling filename conflicts. The values match the Python enum
 * values and the `conflict_resolution` setting in config.toml.
 * - "skip": skip files that would overwrite
 * - "overwrite": overwrite existing files
 * - "auto_version": auto-increment a version number, "Movie (1).mkv"
 */
export type ConflictStrategy = "skip" | "overwrite" | "auto_version";

export const CONFLICT_STRATEGIES: readonly ConflictStrategy[] = [
  "skip",
  "overwrite",
  "auto_version",
];

/** True when `value` is a valid ConflictStrategy. */
export function isConflictStrategy(value: unknown): value is ConflictStrategy {
  return CONFLICT_STRATEGIES.includes(value as ConflictStrategy);
}

/**
 * Convert a string to a ConflictStrategy (Python: `ConflictStrategy(value)`).
 * @throws RangeError when the value is not a valid strategy.
 */
export function parseConflictStrategy(value: string): ConflictStrategy {
  if (isConflictStrategy(value)) return value;
  throw new RangeError(`'${value}' is not a valid ConflictStrategy`);
}

/**
 * Find an available path by appending " (1)", " (2)", ... before the
 * extension. Returns the original path when it does not exist.
 *
 * @throws Error when no available path is found within `maxAttempts`.
 */
export function findAvailablePath(filePath: string, maxAttempts = 1000): string {
  if (!existsSync(filePath)) return filePath;

  const parent = path.dirname(filePath);
  const stem = pathStem(filePath);
  const suffix = pathSuffix(filePath);

  for (let version = 1; version <= maxAttempts; version++) {
    const versioned = path.join(parent, `${stem} (${version})${suffix}`);
    if (!existsSync(versioned)) return versioned;
  }

  throw new Error(
    `Could not find available path after ${maxAttempts} attempts: ${filePath}`,
  );
}

export interface ResolvedConflict {
  /** The path to use (changed only for auto-versioning). */
  path: string;
  /** True when the path differs from the requested destination. */
  wasModified: boolean;
}

/**
 * Resolve a filename conflict using the given strategy. For "skip" and
 * "overwrite" the original path is returned and the caller decides what to do.
 */
export function resolveConflict(
  destination: string,
  strategy: ConflictStrategy,
): ResolvedConflict {
  if (!existsSync(destination)) return { path: destination, wasModified: false };

  switch (strategy) {
    case "skip":
    case "overwrite":
      return { path: destination, wasModified: false };
    case "auto_version": {
      const newPath = findAvailablePath(destination);
      return { path: newPath, wasModified: newPath !== destination };
    }
    default:
      throw new RangeError(`Unknown conflict strategy: ${String(strategy)}`);
  }
}

export interface ConflictPreview {
  /** Operations that would overwrite an existing file. */
  willOverwrite: RenameOperation[];
  /** Operations without conflicts. */
  noConflict: RenameOperation[];
}

/** Preview which operations will have conflicts. */
export function previewConflicts(operations: RenameOperation[]): ConflictPreview {
  const preview: ConflictPreview = { willOverwrite: [], noConflict: [] };
  for (const op of operations) {
    if (willOverwrite(op)) preview.willOverwrite.push(op);
    else preview.noConflict.push(op);
  }
  return preview;
}
