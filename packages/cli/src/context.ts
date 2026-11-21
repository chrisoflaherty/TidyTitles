/** What every command receives. */

import path from "node:path";
import {
  ConfigService,
  type ConfigServiceOptions,
  type SessionOptions,
} from "@tidytitles/core";
import type { WatchOverrides } from "./commands/watch";
import type { Prompter } from "./prompts";
import type { Ui, Writer } from "./ui";

/** Environment variable that overrides the config directory (the --config-dir option wins). */
export const CONFIG_DIR_ENV = "TIDYTITLES_CONFIG_DIR";

/** Session options a caller (tests, embedders) may override. */
export type SessionOverrides = Pick<
  SessionOptions,
  "providers" | "fetch" | "parser" | "musicParser" | "cache"
>;

/** Injectable dependencies for `createProgram` / `runCli`. */
export interface CliDeps {
  stdout: Writer;
  stderr: Writer;
  /** Default false. */
  stdoutIsTTY?: boolean;
  /** Default false. Progress is shown only on a terminal. */
  stderrIsTTY?: boolean;
  /** Default false. Without a terminal, match selection never prompts. */
  stdinIsTTY?: boolean;
  /** Terminal width, for the progress line and help. Default 80. */
  columns?: number;
  /** Environment (NO_COLOR, DEBUG, TIDYTITLES_CONFIG_DIR, FILE_RENAMER_*). Default {}. */
  env?: Record<string, string | undefined>;
  /** Builds the config service. Default `new ConfigService(options)`. */
  createConfigService?: (options: ConfigServiceOptions) => ConfigService;
  /** Merged into the session options of `rename` (fake providers in tests). */
  session?: SessionOverrides;
  /** Prompts for confirmations and match selection. */
  prompter: Prompter;
  /** Aborted on Ctrl+C. */
  signal?: AbortSignal;
  /** Program name shown in help and hints. Default "tidytitles". */
  programName?: string;
  /** Tests only: watcher file system and timings for `watch`. */
  watch?: WatchOverrides;
}

/** Global options. */
export interface GlobalOptions {
  configDir?: string;
  color?: boolean;
}

export interface CommandContext {
  ui: Ui;
  deps: CliDeps;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  programName: string;
  signal: AbortSignal | undefined;
  /** The config service for the global options. */
  config(globals: GlobalOptions): ConfigService;
}

/** The config directory from --config-dir or TIDYTITLES_CONFIG_DIR, resolved; undefined for the default. */
export function resolveConfigDirOverride(
  globals: GlobalOptions,
  env: Record<string, string | undefined>,
): string | undefined {
  const dir = globals.configDir || env[CONFIG_DIR_ENV];
  return dir ? path.resolve(dir) : undefined;
}

export function createContext(deps: CliDeps, ui: Ui): CommandContext {
  const env = deps.env ?? {};
  const factory = deps.createConfigService ?? ((options) => new ConfigService(options));
  return {
    ui,
    deps,
    env,
    stdinIsTTY: deps.stdinIsTTY ?? false,
    programName: deps.programName ?? "tidytitles",
    signal: deps.signal,
    config(globals) {
      const dir = resolveConfigDirOverride(globals, env);
      return dir
        ? factory({ configDir: dir, cacheDir: path.join(dir, "cache"), env })
        : factory({ env });
    },
  };
}
