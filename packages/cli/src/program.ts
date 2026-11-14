/**
 * The TidyTitles command-line program, with every dependency injectable.
 *
 * `runCli(argv, deps)` parses the arguments, runs the command, and resolves
 * to the exit code; it never calls `process.exit` and never throws.
 */

import { Argument, Command, CommanderError, Option } from "commander";
import { ConfigError, MEDIA_TYPE_CHOICES, MissingApiKeyError, PROVIDER_CHOICES } from "@tidytitles/core";
import pkg from "../package.json" with { type: "json" };
import { configInitCommand, configSetKeyCommand, configSetTemplateCommand, configShowCommand } from "./commands/config";
import { previewCommand } from "./commands/preview";
import { renameCommand, type RenameOptions } from "./commands/rename";
import { undoCommand } from "./commands/undo";
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
  When stdin is not a terminal, nothing is asked: files with several results
  are skipped (and reported) unless --auto-select is given.

Confirmation:
  Without --yes (or --dry-run) you are asked "Proceed with rename?". When stdin
  is not a terminal, a y/n answer is read from stdin; end of input aborts
  (exit 1). Use --yes in scripts.

Output:
  Results go to stdout, progress and prompts to stderr (progress only on a
  terminal). --json prints one JSON object: { command, path, dryRun, files,
  confirmed, operations: [{ source, destination, status, skipReason, error,
  lookupError, mediaType, match, associatedFiles }], summary,
  skippedSelections, coverArt, historySaved }.

Examples:
  $ tidytitles rename ~/Downloads --type movie --dry-run
  $ tidytitles rename /media/shows -t tv -r -y --auto-select
  $ tidytitles rename /music -t music -p musicbrainz --json`;

/** Program name and options that matter before parsing (colors for error output). */
function preScan(argv: readonly string[]): { color: boolean } {
  let color = true;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--no-color") color = false;
  }
  return { color };
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
    .option("-o, --output <dir>", "Output directory for renamed files")
    .option("-n, --dry-run", "Preview changes without renaming")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-a, --auto-select", "Automatically select first match when multiple results found")
    .addOption(
      new Option("-p, --provider <provider>", "Metadata provider (tmdb, tvdb, musicbrainz, or auto based on config)")
        .choices(PROVIDER_CHOICES)
        .default("auto"),
    )
    .option("-c, --cover-art", "Download cover art (posters/album covers) after renaming")
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
    .option("--json", "Print the result as JSON: { command, path, files: [{ path, filename, mediaType, title, year, season, episode }] }")
    .action(run(async (p: string, _opts: unknown, cmd: Command) => previewCommand(ctx, p, globals(cmd))));

  program
    .command("undo")
    .description("Undo the last rename operation, using the saved history.")
    .option("-y, --yes", "Skip confirmation prompt")
    .option(
      "--json",
      "Print the result as JSON: { command, historyFound, timestamp, confirmed, items: [{ source, destination, status, errors }], undone, missing, failed }",
    )
    .addHelpText(
      "after",
      `
Without --yes you are asked "Proceed with undo?"; when stdin is not a terminal
the y/n answer is read from stdin. Exits 1 when any file could not be moved back
(the history then keeps only those files, so undo can be retried).`,
    )
    .action(run(async (_opts: unknown, cmd: Command) => undoCommand(ctx, globals(cmd))));

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
