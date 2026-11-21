/**
 * The TidyTitles command-line program, with every dependency injectable.
 *
 * `runCli(argv, deps)` parses the arguments, runs the command, and resolves
 * to the exit code; it never calls `process.exit` and never throws.
 */

import { Argument, Command, CommanderError, InvalidArgumentError, Option } from "commander";
import {
  ConfigError,
  EPISODE_ORDERS,
  MEDIA_TYPE_CHOICES,
  MissingApiKeyError,
  PROVIDER_CHOICES,
  TRANSFER_MODES,
  normalizeMetadataLanguage,
} from "@tidytitles/core";
import pkg from "../package.json" with { type: "json" };
import { configInitCommand, configSetKeyCommand, configSetTemplateCommand, configShowCommand } from "./commands/config";
import { configPresetCommand, configPresetsCommand } from "./commands/presets";
import { previewCommand } from "./commands/preview";
import { renameCommand, type RenameOptions } from "./commands/rename";
import { undoCommand } from "./commands/undo";
import { watchCommand, type WatchCommandOptions } from "./commands/watch";
import { CONFIG_DIR_ENV, createContext, type CliDeps, type CommandContext, type GlobalOptions } from "./context";
import {
  CancelledError,
  EXIT_CANCELLED,
  EXIT_ERROR,
  EXIT_USAGE,
  PromptEofError,
  UsageError,
  isPromptInterrupt,
} from "./errors";
import { Ui } from "./ui";

export type { CliDeps } from "./context";
export const VERSION: string = pkg.version;

const ROOT_HELP = `
Environment:
  ${CONFIG_DIR_ENV}           Config directory (same as --config-dir; the option wins)
  FILE_RENAMER_API__TMDB_API_KEY  TMDB API key (used when config.toml has none)
  FILE_RENAMER_API__TVDB_API_KEY  TVDB API key (used when config.toml has none)
  NO_COLOR                        Disable colors (same as --no-color)
  DEBUG                           Print stack traces for errors

Exit codes:
  0    Success
  1    Error (configuration, metadata lookup, or rename failure)
  2    Usage error (bad option or argument, PATH does not exist)
  130  Canceled with Ctrl+C`;

const RENAME_HELP = `
Matches:
  When a search finds several results, you choose one from a list or skip
  the file. --auto-select takes the first result without asking.
  On a terminal, "Search with different words..." searches again with your
  words; files with no match are offered the same search after the lookup.
  When stdin is not a terminal, nothing is asked: files with several results
  are skipped (and reported) unless --auto-select is given.

Episode order and language:
  --order aired|dvd|absolute says how the season and episode numbers in the
  file names count, and how the new names count (default: [tv] episode_order,
  normally aired). TVDB has all three orders; TMDB has DVD order only for
  shows with a DVD episode group (files of other shows are left unmatched),
  and absolute order by counting the aired episodes. Files without a season ("[Group] Show - 123") are always read as
  absolute numbers; files named by date ("Show.2024.03.15") are found by
  their air date.
  --language CODE gets titles in that language, such as de-DE, pt-BR, or ja
  (default: [metadata] language, normally en-US). A title with no
  translation falls back to English, then to the original title.

Confirmation:
  Without --yes (or --dry-run) you are asked "Proceed with rename?". When stdin
  is not a terminal, a y/n answer is read from stdin; end of input aborts
  (exit 1). Use --yes in scripts.

Output folders and transfer:
  Files go to the [output] folders in config.toml (one per media type; empty
  keeps a file next to the original). --output sends every file to one folder
  instead and creates it when missing. A missing or unwritable [output] folder
  stops the run before anything is renamed (exit 1). --transfer copy or
  hardlink leaves the originals in place; a hard link to another volume is
  skipped and reported, never copied instead.

Tags and NFO files:
  --write-tags writes a MusicBrainz match's title, artist, album, album
  artist, track and disc numbers, year, and genre into renamed MP3, FLAC,
  M4A, Ogg Vorbis, and Opus files, only where they differ (default:
  [write_metadata] music_tags). Other formats are renamed and reported as
  "tags not written"; hard links are never written to. --write-nfo writes NFO
  files for Kodi, Jellyfin, and Emby next to renamed movies and episodes, and
  tvshow.nfo in a show's folder (default: [write_metadata] nfo). --no-write-tags
  and --no-write-nfo turn them off for one run. --dry-run lists what would be
  written. Undo puts the old tags back and removes unchanged NFO files.

Output:
  Results go to stdout, progress and prompts to stderr (progress only on a
  terminal). --json prints one JSON object: { command, path, dryRun, files,
  confirmed, operations: [{ source, destination, status, skipReason, error,
  lookupError, mediaType, match, correction, associatedFiles, tags, nfo }],
  summary, skippedSelections, coverArt, historySaved, transfer, outputFolders,
  writeMetadata }. tags is { status, reason, changes: [{ field, from, to }],
  format } and nfo is [{ kind, path, status, reason, replaced }] (null when off).

Examples:
  $ tidytitles rename ~/Downloads --type movie --dry-run
  $ tidytitles rename /media/shows -t tv -r -y --auto-select
  $ tidytitles rename /music -t music -p musicbrainz --json
  $ tidytitles rename ~/Downloads -t movie -o /Volumes/Media/Movies --transfer copy
  $ tidytitles rename /media/anime -t tv --order absolute --language ja-JP`;

const WATCH_HELP = `
What it does:
  Watches FOLDERS (default: [watch] folders in config.toml) for new media
  files and looks each one up once it has finished arriving: its size and
  modification time have not changed for the settle period (--settle,
  default [watch] settle_seconds, normally 10), and it does not have a
  temporary download name (.part, .crdownload, .download, .!qB, .tmp, and
  similar) or a companion such as "Name.mkv.part" next to it. Nothing is ever
  asked: this command never prompts.

Review (the default):
  Nothing is renamed. Each file is reported as "Ready for review" with its new
  name, or "Needs review" with the reason (several matches, no match, ...).
  Rename them afterward with:  tidytitles rename <folder>
  which shows the preview and asks before renaming, as usual.

Automatic (--auto):
  A file is renamed without asking only when its lookup found exactly one
  match (never the first of several), its new name is free (nothing exists
  there, whatever [behavior] conflict_resolution says), and it is still the
  file that finished arriving. Everything else is reported as "Needs review"
  and left alone. Automatic renames use the [output] folders, --transfer,
  associated files, and cover art settings, and are saved to the history
  (undo with "tidytitles undo").

Files already there:
  Files in the folders when watching starts (or when a missing folder comes
  back) are left alone. --existing processes them too.

Folders that go away (an unplugged drive, a network share) are checked
again regularly and watched again when they return. Network shares are
rescanned, since they do not report changes reliably. When lookups fail
(service down, rate limits) the files are tried again later, waiting 30
seconds at first and up to 30 minutes.

Output:
  One line per event on stdout. --json prints one JSON object per line:
  { event, time, ... } with event one of started, arriving, temporary,
  ready, looking_up, renamed, review (reason: review_mode, several_matches,
  no_match, lookup_failed, unverified, conflict, template_error,
  transfer_unavailable, rename_failed, not_renamable), unchanged, retry,
  changed, gone, unreadable, folder_missing, folder_restored, folder_error,
  polling, history_saved, cover_art, stopped, and finally summary.

Ctrl+C stops watching (exit 0); a rename in progress finishes first.

Examples:
  $ tidytitles watch ~/Downloads
  $ tidytitles watch ~/Downloads --auto -o /Volumes/Media/Movies --transfer copy
  $ tidytitles watch /srv/incoming -t tv --auto --json`;

/** `--settle`: whole seconds from 2 to 3600. */
function parseSettleSeconds(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 2 || n > 3_600) {
    throw new InvalidArgumentError("Must be a whole number of seconds from 2 to 3600.");
  }
  return n;
}

/** `--language`: a language code such as "de-DE" or "de", normalized. */
function parseLanguageOption(value: string): string {
  const code = normalizeMetadataLanguage(value);
  if (!code) throw new InvalidArgumentError('Use a language code such as "en-US", "de-DE", or "ja".');
  return code;
}

/** Program name and options that matter before parsing (colors for error output). */
function preScan(argv: readonly string[]): { color: boolean } {
  let color = true;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--no-color") color = false;
  }
  return { color };
}

/** `--entry`: a positive whole number. */
function parseEntryNumber(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError("Must be a positive whole number (1 is the most recent rename).");
  }
  return n;
}

function missingKeyMessage(error: MissingApiKeyError, name: string): string {
  if (error.reason === "no_keys") {
    return `No API keys configured. Run '${name} config set-key tmdb YOUR_API_KEY' (or 'tvdb') to configure, or use --type music.`;
  }
  const provider = error.providers[0] ?? "tmdb";
  return `${provider.toUpperCase()} API key not configured. Run '${name} config set-key ${provider} YOUR_API_KEY' to set one.`;
}

/**
 * Build the commander program. Actions store their exit code in
 * `state.exitCode`; errors propagate to `runCli`.
 */
export function createProgram(
  deps: CliDeps,
  ui: Ui = createUi(deps, preScan([]).color),
): { program: Command; state: { exitCode: number }; ctx: CommandContext } {
  const ctx = createContext(deps, ui);
  const state = { exitCode: 0 };
  const name = ctx.programName;
  const columns = deps.columns ?? 80;

  const program = new Command(name)
    .description("TidyTitles - Rename media files using TMDB/TVDB/MusicBrainz metadata.")
    .version(VERSION, "--version", "Show the version and exit")
    .helpOption("-h, --help", "Show this message and exit")
    .helpCommand("help [command]", "Show help for a command")
    .option("--config-dir <dir>", `Config directory (default: the user config directory; env ${CONFIG_DIR_ENV})`)
    .option("--no-color", "Disable colors")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
      outputError: (s, write) => write(ui.ec.red(s)),
      getOutHelpWidth: () => columns,
      getErrHelpWidth: () => columns,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    })
    .showHelpAfterError(`Run '${name} --help' for usage.`)
    .addHelpText("after", ROOT_HELP);

  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      state.exitCode = await fn(...args);
    };
  const globals = (cmd: Command) => cmd.optsWithGlobals<GlobalOptions & Record<string, unknown>>();

  program
    .command("rename")
    .description("Rename media files in PATH (a file or directory).")
    .argument("<path>", "File or directory to process")
    .addOption(
      new Option("-t, --type <type>", "Media type (movie, tv, music, or auto-detect)")
        .choices(MEDIA_TYPE_CHOICES)
        .default("auto"),
    )
    .option("-r, --recursive", "Scan directories recursively")
    .option("-o, --output <dir>", "Output directory for renamed files (overrides the [output] folders)")
    .addOption(
      new Option("--transfer <mode>", "How files get their new names: move, copy, or hardlink (default: [output] transfer_mode)")
        .choices(TRANSFER_MODES),
    )
    .option("-n, --dry-run", "Preview changes without renaming")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-a, --auto-select", "Automatically select first match when multiple results found")
    .addOption(
      new Option("-p, --provider <provider>", "Metadata provider (tmdb, tvdb, musicbrainz, or auto based on config)")
        .choices(PROVIDER_CHOICES)
        .default("auto"),
    )
    .option("-c, --cover-art", "Download cover art (posters/album covers) after renaming")
    .addOption(
      new Option("--order <order>", "Episode order of season/episode numbers (default: [tv] episode_order)").choices(
        EPISODE_ORDERS,
      ),
    )
    .addOption(
      new Option("--language <code>", "Metadata language, e.g. en-US, de-DE, ja (default: [metadata] language)").argParser(
        parseLanguageOption,
      ),
    )
    .option("--write-tags", "Write the match's tags into renamed music files (default: [write_metadata] music_tags)")
    .option("--no-write-tags", "Do not write tags into music files in this run")
    .option("--write-nfo", "Write NFO files for Kodi, Jellyfin, and Emby (default: [write_metadata] nfo)")
    .option("--no-write-nfo", "Do not write NFO files in this run")
    .option("--json", "Print the result as JSON")
    .addHelpText("after", RENAME_HELP)
    .action(
      run(async (p: string, _opts: unknown, cmd: Command) =>
        renameCommand(ctx, p, globals(cmd) as unknown as RenameOptions),
      ),
    );

  program
    .command("preview")
    .description("Preview how files in PATH parse, without looking up metadata or renaming.")
    .argument("<path>", "File or directory to process")
    .option("-r, --recursive", "Scan directories recursively")
    .option("--json", "Print the result as JSON: { command, path, files: [{ path, filename, mediaType, title, year, season, episode, episodes, airDate }] }")
    .action(run(async (p: string, _opts: unknown, cmd: Command) => previewCommand(ctx, p, globals(cmd))));

  program
    .command("undo")
    .description("Undo the last rename operation (or an older one), using the saved history.")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-l, --list", "List the rename history (most recent first) instead of undoing")
    .option("-e, --entry <number>", "Undo this entry of --list instead of the most recent (1 is the most recent)", parseEntryNumber)
    .option(
      "--json",
      "Print the result as JSON: { command, historyFound, timestamp, confirmed, items: [{ source, destination, status, errors, kept }], undone, missing, kept, failed }; with --list: { command, history: [{ entry, timestamp, operations, files, transfer, samples }] }",
    )
    .addHelpText(
      "after",
      `
Without --yes you are asked "Proceed with undo?"; when stdin is not a terminal
the y/n answer is read from stdin. Exits 1 when any file could not be moved back
(the history then keeps only those files, so undo can be retried).

Copies and hard links are undone by deleting them; the originals are never
touched. A file is moved back or deleted only if it is still the file the
rename produced: one that was replaced or edited since, a copy whose original
is gone, or (in entries from older versions) a file a later rename touched is
left in place and reported as "left in place".

Examples:
  $ tidytitles undo --list
  $ tidytitles undo --entry 3`,
    )
    .action(run(async (_opts: unknown, cmd: Command) => undoCommand(ctx, globals(cmd))));

  program
    .command("watch")
    .description("Watch folders for new media files; report them, or with --auto rename the unambiguous ones.")
    .argument("[folders...]", "Folders to watch (default: [watch] folders in config.toml)")
    .addOption(
      new Option("-t, --type <type>", "Media type (movie, tv, music, or auto-detect)")
        .choices(MEDIA_TYPE_CHOICES)
        .default("auto"),
    )
    .option("-r, --recursive", "Include subfolders (default: [watch] recursive)")
    .option("--no-recursive", "Only the folders themselves, not their subfolders")
    .option("--auto", "Automatic mode: rename files with exactly one match without asking")
    .option("--existing", "Also process the files already in the folders")
    .option("--settle <seconds>", "Seconds a file must stay unchanged (default: [watch] settle_seconds)", parseSettleSeconds)
    .option("-o, --output <dir>", "Output directory for renamed files (overrides the [output] folders)")
    .addOption(
      new Option("--transfer <mode>", "How files get their new names: move, copy, or hardlink (default: [output] transfer_mode)")
        .choices(TRANSFER_MODES),
    )
    .addOption(
      new Option("-p, --provider <provider>", "Metadata provider (tmdb, tvdb, musicbrainz, or auto based on config)")
        .choices(PROVIDER_CHOICES)
        .default("auto"),
    )
    .addOption(
      new Option("--order <order>", "Episode order of season/episode numbers (default: [tv] episode_order)").choices(
        EPISODE_ORDERS,
      ),
    )
    .addOption(
      new Option("--language <code>", "Metadata language, e.g. en-US, de-DE, ja (default: [metadata] language)").argParser(
        parseLanguageOption,
      ),
    )
    .option("--json", "Print one JSON object per line")
    .addHelpText("after", WATCH_HELP)
    .action(
      run(async (folders: string[], _opts: unknown, cmd: Command) => {
        const opts = globals(cmd) as unknown as WatchCommandOptions & { recursive?: boolean };
        // Neither -r nor --no-recursive given: commander leaves its default (true); use the config.
        const source = cmd.getOptionValueSource("recursive");
        if (source !== "cli") delete opts.recursive;
        return watchCommand(ctx, folders, opts, deps.watch ?? {});
      }),
    );

  const config = program.command("config").description("Manage configuration settings.");

  config
    .command("show")
    .description("Show current configuration (API keys are shown only as configured / not set).")
    .option("--json", "Print the configuration as JSON")
    .action(run(async (_opts: unknown, cmd: Command) => configShowCommand(ctx, globals(cmd))));

  config
    .command("set-key")
    .description("Set an API key for a provider (tmdb or tvdb).")
    .addArgument(new Argument("<provider>", "tmdb or tvdb").choices(["tmdb", "tvdb"]))
    .argument("<key>", "Your API key")
    .action(
      run(async (provider: "tmdb" | "tvdb", key: string, _opts: unknown, cmd: Command) =>
        configSetKeyCommand(ctx, provider, key, globals(cmd)),
      ),
    );

  config
    .command("set-template")
    .description("Set a naming template.")
    .addArgument(new Argument("<type>", "movie, tv, or music").choices(["movie", "tv", "music"]))
    .argument("<template>", "Template string with placeholders")
    .addHelpText(
      "after",
      `
Example templates:
  movie: "{title} ({year})"
  tv:    "{title} - S{season2}E{episode2} - {episode_title}"
  music: "{artist}/{album} ({year})/{track2} - {title}"`,
    )
    .action(
      run(async (type: "movie" | "tv" | "music", template: string, _opts: unknown, cmd: Command) =>
        configSetTemplateCommand(ctx, type, template, globals(cmd)),
      ),
    );

  config
    .command("presets")
    .description("List the naming presets (Plex, Jellyfin, Kodi, TidyTitles) and which one is in effect.")
    .option("--json", "Print the presets as JSON")
    .action(run(async (_opts: unknown, cmd: Command) => configPresetsCommand(ctx, globals(cmd))));

  config
    .command("preset")
    .description("Set the movie, TV, and music templates from a naming preset.")
    .argument("<name>", "Preset id: default, plex, jellyfin, or kodi")
    .addHelpText(
      "after",
      `
Presets only fill in the three templates; change any of them afterward with
set-template. Run "config presets" to see each preset's templates.`,
    )
    .action(
      run(async (name: string, _opts: unknown, cmd: Command) => configPresetCommand(ctx, name, globals(cmd))),
    );

  config
    .command("init")
    .description("Initialize configuration file with defaults (asks before overwriting).")
    .action(run(async (_opts: unknown, cmd: Command) => configInitCommand(ctx, globals(cmd))));

  return { program, state, ctx };
}

function createUi(deps: CliDeps, color: boolean): Ui {
  return new Ui({
    stdout: deps.stdout,
    stderr: deps.stderr,
    stdoutIsTTY: deps.stdoutIsTTY ?? false,
    stderrIsTTY: deps.stderrIsTTY ?? false,
    color,
    env: deps.env ?? {},
    columns: deps.columns,
  });
}

/** Run the CLI with `argv` (the arguments after the program name). Resolves to the exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const ui = createUi(deps, preScan(argv).color);
  const { program, state, ctx } = createProgram(deps, ui);
  const env = deps.env ?? {};

  try {
    await program.parseAsync([...argv], { from: "user" });
    return state.exitCode;
  } catch (error) {
    ui.progress.clear();
    if (env.DEBUG && error instanceof Error && !(error instanceof CommanderError)) {
      deps.stderr.write(`${error.stack ?? String(error)}\n`);
    }
    if (error instanceof CommanderError) {
      // Help and version exit with commander's code (0); usage errors with 2, as Click.
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      if (error.code === "commander.help") return error.exitCode;
      return EXIT_USAGE;
    }
    if (error instanceof CancelledError || isPromptInterrupt(error)) {
      ui.note(ui.ec.yellow("Canceled."));
      return EXIT_CANCELLED;
    }
    if (error instanceof PromptEofError) {
      ui.note("Aborted!");
      return EXIT_ERROR;
    }
    if (error instanceof UsageError) {
      ui.error(error.message);
      ui.note(`Run '${ctx.programName} --help' for usage.`);
      return EXIT_USAGE;
    }
    if (error instanceof MissingApiKeyError) {
      ui.error(missingKeyMessage(error, ctx.programName));
      return EXIT_ERROR;
    }
    if (error instanceof ConfigError) {
      ui.error(error.message);
      return EXIT_ERROR;
    }
    ui.error(error instanceof Error ? error.message : String(error));
    return EXIT_ERROR;
  }
}
