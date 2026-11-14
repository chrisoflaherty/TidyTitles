import { existsSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../errors";

/** The absolute path, or a usage error (exit 2) when it does not exist, as Click's `Path(exists=True)`. */
export function requireExistingPath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  if (!existsSync(resolved)) {
    throw new UsageError(`Invalid value for 'PATH': Path '${rawPath}' does not exist.`);
  }
  return resolved;
}
