/**
 * `watch [FOLDERS...]`: a foreground process that watches folders for new
 * media files, looks them up, and (with --auto) renames the unambiguous
 * ones. It never prompts: in review mode it only reports, because nobody is
 * there to confirm. Ctrl+C stops it; renaming in progress finishes first.
 */

import { statSync } from "node:fs";
import path from "node:path";
import {
  HistoryIdentities,
  RenameSession,
  WATCH_REVIEW_TEXT,
  WatchService,
  applySessionOverrides,
  extensionsForMediaType,
  forceTypeForChoice,
  watchSessionSettings,
  type EpisodeOrder,
  type MediaTypeChoice,
  type ProviderChoice,
  type TransferMode,
  type WatchEvent,
  type WatchMode,
  type WatchServiceOptions,
} from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { EXIT_OK, UsageError, uninterruptible } from "../errors";
import { formatCount } from "../format";

export interface WatchCommandOptions extends GlobalOptions {
  type: MediaTypeChoice;
  provider: ProviderChoice;
  /** Undefined: `[watch] recursive`. */
  recursive?: boolean;
  /** --auto: rename unambiguous files without asking. */
  auto?: boolean;
  /** --existing: also process files already in the folders. */
  existing?: boolean;
  /** --settle SECONDS; default `[watch] settle_seconds`. */
  settle?: number;
  output?: string;
  transfer?: TransferMode;
  order?: EpisodeOrder;
  language?: string;
  json?: boolean;
}

/** Watcher pieces tests replace (real files, no events, short timings). */
export type WatchOverrides = Partial<
  Pick<WatchServiceOptions, "fs" | "clock" | "rescanMs" | "pollingRescanMs" | "checkMs" | "gatherMs" | "initialBackoffMs" | "settleMs">
>;

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

function folderArgument(raw: string): string {
  const resolved = path.resolve(raw);
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    throw new UsageError(`Invalid value for 'FOLDERS': Path '${raw}' does not exist.`);
  }
  if (!isDir) throw new UsageError(`Invalid value for 'FOLDERS': '${raw}' is not a folder.`);
  return resolved;
}

export async function watchCommand(
  ctx: CommandContext,
  rawFolders: readonly string[],
  options: WatchCommandOptions,
  overrides: WatchOverrides = {},
): Promise<number> {
  const { ui, signal } = ctx;
  const c = ui.c;
  const json = options.json ?? false;
  const config = ctx.config(options);
  // Throws ConfigError for an unreadable config.toml (exit 1).
  const initial = await config.load();

  const configured = rawFolders.length === 0;
  const folders = configured
    ? initial.watch.folders.map((f) => path.resolve(f))
    : rawFolders.map(folderArgument);
  if (folders.length === 0) {
    throw new UsageError(
      `Name a folder to watch, or set folders in the [watch] table of ${config.configFile}.`,
    );
  }
  for (const f of folders) {
    if (!path.isAbsolute(f)) throw new UsageError(`Watch folders must be absolute paths: ${f}`);
  }

  const mode: WatchMode = options.auto ? "automatic" : "review";
  const recursive = options.recursive ?? initial.watch.recursive;
  const settleMs = overrides.settleMs ?? (options.settle ?? initial.watch.settleSeconds) * 1_000;
  const outputDir = options.output ? path.resolve(options.output) : undefined;
  const forceType = forceTypeForChoice(options.type);
  const sessionOptions = {
    config,
    provider: options.provider,
    mediaType: options.type,
    ...(outputDir ? { outputDir } : {}),
    ...(options.transfer ? { transferMode: options.transfer } : {}),
    ...(options.order ? { episodeOrder: options.order } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...ctx.deps.session,
  };

  // Missing API keys stop the command before anything is watched (exit 1).
  new RenameSession(initial, sessionOptions);

  /** Settings are read again for every batch, so an API key fixed meanwhile is used. */
  const createSession = async (): Promise<RenameSession> => {
    const settings = applySessionOverrides(await config.load(), sessionOptions);
    return new RenameSession(watchSessionSettings(settings, mode), { ...sessionOptions, requireApiKeys: false });
  };

  const outputFolders = outputDir ? [outputDir] : [initial.output.movie, initial.output.tv, initial.output.music];
  const label = (p: string): string => {
    const root = folders.find((f) => p === f || p.startsWith(f + path.sep));
    return root && p !== root ? path.relative(root, p) : p;
  };
  const time = (): string => TIME.format(new Date());

  const log = (text: string): void => ui.print(`${c.dim(time())}  ${text}`);
  const report = (event: WatchEvent): void => {
    if (json) {
      ui.stdout.write(JSON.stringify({ event: event.type, time: new Date().toISOString(), ...withoutType(event) }) + "\n");
      return;
    }
    switch (event.type) {
      case "started":
        for (const f of event.folders) {
          const state = f.status === "ok" ? "" : c.yellow(f.status === "missing" ? " (not there yet; checked again regularly)" : " (cannot be read)");
          const existing = f.existing > 0 ? c.dim(`, ${formatCount(f.existing)} media file(s) already there${options.existing ? "" : " left alone"}`) : "";
          log(`${c.bold("Watching")} ${f.folder}${state}${existing}${f.polling ? c.dim(" (rescanning)") : ""}`);
        }
        break;
      case "folder_missing":
        log(c.yellow(`Folder missing: ${event.folder}. Checking again regularly.`));
        break;
      case "folder_restored":
        log(
          c.green(`Folder back: ${event.folder}`) +
            (event.existing > 0 ? c.dim(` (${formatCount(event.existing)} media file(s) there are left alone, as at start)`) : ""),
        );
        break;
      case "folder_error":
        log(c.red(`Cannot read ${event.folder}: ${event.message}`));
        break;
      case "polling":
        log(c.dim(`No file-system events for ${event.folder}; rescanning it instead (${event.message})`));
        break;
      case "arriving":
        log(`New file: ${label(event.path)} ${c.dim("(waiting until it stops changing)")}`);
        break;
      case "temporary":
        log(c.dim(`Downloading: ${label(event.path)} (temporary name; waiting for ${event.finalName})`));
        break;
      case "gone":
        log(c.dim(`Gone before it was done: ${label(event.path)}`));
        break;
      case "unreadable":
        log(c.red(`Cannot read ${label(event.path)}: ${event.message}`));
        break;
      case "ready":
        break;
      case "looking_up":
        log(c.dim(`Looking up ${formatCount(event.count)} file(s)...`));
        break;
      case "renamed":
        log(`${c.green("Renamed:")} ${label(event.path)} → ${label(event.destination)}`);
        break;
      case "review":
        if (event.reason === "review_mode") {
          log(`${c.cyan("Ready for review:")} ${label(event.path)}${event.destination ? ` → ${label(event.destination)}` : ""}`);
        } else {
          const detail = event.reason === "rename_failed" && event.message ? `: ${event.message}` : "";
          log(`${c.yellow("Needs review:")} ${label(event.path)} ${c.dim(`(${WATCH_REVIEW_TEXT[event.reason]}${detail})`)}`);
        }
        break;
      case "unchanged":
        log(c.dim(`Already named: ${label(event.path)}`));
        break;
      case "retry":
        log(
          c.yellow(`Lookup failed for ${formatCount(event.paths.length)} file(s): ${event.message}. Trying again at ${TIME.format(new Date(event.retryAt))}.`),
        );
        break;
      case "changed":
        log(c.dim(`Changed again: ${label(event.path)} (waiting until it stops changing)`));
        break;
      case "history_saved":
        log(c.dim(`Saved ${formatCount(event.operations)} rename(s) to the history (undo with '${ctx.programName} undo').`));
        break;
      case "cover_art":
        log(c.dim(`Downloaded ${formatCount(event.files.length)} cover art file(s).`));
        break;
      case "stopped":
        break;
    }
  };

  const history = new HistoryIdentities(config);
  const service = new WatchService({
    folders,
    recursive,
    mode,
    settleMs,
    extensions: extensionsForMediaType(forceType),
    excludedFolders: outputFolders,
    createSession,
    onEvent: report,
    guard: uninterruptible,
    history,
    ...overrides,
  });

  if (!json) {
    ui.note(
      c.dim(
        mode === "automatic"
          ? "Automatic: files with exactly one match and a free new name are renamed; the rest are listed for review."
          : `Review: nothing is renamed. Rename the files listed as ready with '${ctx.programName} rename <folder>'.`,
      ),
    );
    ui.note(c.dim("Press Ctrl+C to stop."));
  }
  await service.start();
  if (options.existing) {
    const n = service.processExisting();
    if (!json && n > 0) log(`Processing ${formatCount(n)} file(s) that were already there.`);
  }

  // Run until Ctrl+C.
  await new Promise<void>((resolve) => {
    if (!signal) return; // embedded without a signal: runs until the process ends
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await service.stop();

  const t = service.totals;
  if (!json) {
    ui.note();
    ui.note(
      `Stopped watching. Renamed: ${formatCount(t.renamed)}, waiting for review: ${formatCount(t.review)}` +
        (t.retrying ? `, not looked up yet (lookups failing): ${formatCount(t.retrying)}` : ""),
    );
  } else {
    ui.stdout.write(JSON.stringify({ event: "summary", time: new Date().toISOString(), ...t }) + "\n");
  }
  return EXIT_OK;
}

function withoutType(event: WatchEvent): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  return rest;
}
