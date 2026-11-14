import path from "node:path";
import { ConfigService } from "@tidytitles/core";

/** Environment variable that points the app (and the CLI) at another config directory. */
export const CONFIG_DIR_ENV = "TIDYTITLES_CONFIG_DIR";

/**
 * The config service: the platform config directory, or `$TIDYTITLES_CONFIG_DIR`
 * (with its cache in `<dir>/cache`) when that variable is set.
 */
export function createConfigService(env: Record<string, string | undefined> = process.env): ConfigService {
  const dir = env[CONFIG_DIR_ENV]?.trim();
  if (dir) {
    const resolved = path.resolve(dir);
    return new ConfigService({ configDir: resolved, cacheDir: path.join(resolved, "cache"), env });
  }
  return new ConfigService({ env });
}
