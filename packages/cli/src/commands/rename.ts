/** `rename PATH`: look up metadata and rename media files. */

import { statSync } from "node:fs";
import path from "node:path";
import {
  createSession,
  summarizeOperations,
  type MediaTypeChoice,
  type PlannedOperation,
  type ProviderChoice,
  type SelectableOption,
  type SelectionCallback,
} from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { CancelledError, EXIT_ERROR, EXIT_OK, raceAbort } from "../errors";
import { base, capitalize, destinationLabel, describeOption, describeSkip, formatCount, operationToJson } from "../format";
import type { Ui } from "../ui";
import { makeTable } from "../ui";
import { requireExistingPath } from "./shared";

export interface RenameOptions extends GlobalOptions {
  type: MediaTypeChoice;
  recursive?: boolean;
  output?: string;
  dryRun?: boolean;
  yes?: boolean;
  autoSelect?: boolean;
  provider: ProviderChoice;
  coverArt?: boolean;
  json?: boolean;
}

const SCAN_TEXT: Record<MediaTypeChoice, { scanning: string; notFound: string }> = {
  music: { scanning: "Scanning for music files...", notFound: "No music files found." },
  movie: { scanning: "Scanning for video files...", notFound: "No video files found." },
  tv: { scanning: "Scanning for video files...", notFound: "No video files found." },
  auto: { scanning: "Scanning for media files...", notFound: "No media files found." },
};

/** Builds the selection callback and records files skipped because nothing could be asked. */
function createSelection(
  ctx: CommandContext,
  autoSelect: boolean,
): { callback: SelectionCallback; skippedNonInteractive: string[] } {
  const { ui, signal } = ctx;
  const skippedNonInteractive: string[] = [];

  const callback: SelectionCallback = async (options: SelectableOption[], filename: string) => {
    if (autoSelect) return 0;
    if (!ctx.stdinIsTTY) {
      skippedNonInteractive.push(filename);
      return undefined;
    }

    const ec = ui.ec;
    ui.note();
    ui.note(`${ec.yellow("Multiple matches found for:")} ${filename}`);
    ui.note();
    const table = makeTable(["#", "Title", "Artist/Year", "Type"], ec);
    options.forEach((option, i) => {
      const [title, info, kind] = describeOption(option);
      table.push([ec.cyan(String(i + 1)), ec.green(title), ec.yellow(info), ec.blue(kind)]);
    });
    ui.note(ec.bold("Select Match"));
    ui.note(table.toString());
    ui.note();

    const choices = options.map((option, i) => {
      const [title, info] = describeOption(option);
      return { name: `${i + 1}. ${title} (${info})`, value: i as number | undefined };
    });
    choices.push({ name: "Skip this file", value: undefined });
    return ctx.deps.prompter.select(`Select match (1-${options.length}) or skip:`, choices, {
      signal,
    });
  };

  return { callback, skippedNonInteractive };
}

function showPreview(ui: Ui, operations: PlannedOperation[], outputDir?: string): void {
  const c = ui.c;
  const table = makeTable(["Type", "Original", "New Name"], c);
  for (const op of operations) {
    const label = op.mediaFile.parsedInfo.mediaType === "music" ? "Music" : "Video";
    const baseDir = outputDir ?? path.dirname(op.source);
    const newName =
      op.status === "skipped"
        ? c.yellow(`(skipped: ${describeSkip(op)})`)
        : c.green(destinationLabel(op.destination, baseDir));
    table.push([c.cyan(label), c.red(base(op.source)), newName]);
    for (const assoc of op.associatedFiles) {
      table.push([
        c.cyan(`  └─ ${capitalize(assoc.fileType)}`),
        c.red(base(assoc.source)),
        c.green(destinationLabel(assoc.destination, baseDir)),
      ]);
    }
  }
  ui.print(c.bold("Rename Preview"));
  ui.print(table.toString());

  const summary = summarizeOperations(operations);
  if (summary.associatedFiles > 0) {
    ui.print();
    ui.print(
      c.dim(
        `Total: ${summary.total} video file(s) + ${summary.associatedFiles} associated file(s) = ${summary.totalFiles} file(s)`,
      ),
    );
  }
}

function showResults(ui: Ui, operations: PlannedOperation[]): void {
  const c = ui.c;
  const summary = summarizeOperations(operations);
  ui.print();
  ui.print(`${c.green("Completed:")} ${summary.completed}`);
  if (summary.failed) ui.print(`${c.red("Failed:")} ${summary.failed}`);
  if (summary.skipped) ui.print(`${c.yellow("Skipped:")} ${summary.skipped}`);
  for (const op of operations) {
    if (op.status === "failed") {
      ui.print(`  ${c.red("Error:")} ${base(op.source)}: ${op.errorMessage ?? "unknown error"}`);
    }
  }
}

/** One stderr line per distinct lookup failure. Returns the number of files affected. */
function reportLookupFailures(ctx: CommandContext, operations: PlannedOperation[]): number {
  const failed = operations.filter((op) => op.lookupError);
  if (failed.length === 0) return 0;
  const byMessage = new Map<string, number>();
  for (const op of failed) {
    const message = op.lookupError!.message;
    byMessage.set(message, (byMessage.get(message) ?? 0) + 1);
  }
  for (const [message, count] of byMessage) {
    ctx.ui.error(`Metadata lookup failed for ${count} file(s): ${message}`);
  }
  if (failed.some((op) => op.lookupError!.kind === "authentication")) {
    ctx.ui.note(
      `Check your API keys with '${ctx.programName} config show' and set one with '${ctx.programName} config set-key <tmdb|tvdb> YOUR_API_KEY'.`,
    );
  }
  return failed.length;
}

export async function renameCommand(
  ctx: CommandContext,
  rawPath: string,
  options: RenameOptions,
): Promise<number> {
  const { ui, signal } = ctx;
  const c = ui.c;
  const json = options.json ?? false;
  const dryRun = options.dryRun ?? false;
  const target = requireExistingPath(rawPath);

  const config = ctx.config(options);
  const selection = createSelection(ctx, options.autoSelect ?? false);
  // Throws MissingApiKeyError / ConfigError before any file is touched.
  const session = await createSession(config, {
    provider: options.provider,
    mediaType: options.type,
    dryRun,
    selectionCallback: selection.callback,
    ...ctx.deps.session,
  });

  const text = SCAN_TEXT[options.type];
  if (!statSync(target).isFile()) ui.progress.update(text.scanning);
  const files = await raceAbort(
    session.collectFiles([target], { recursive: options.recursive ?? false }),
    signal,
  );
  ui.progress.clear();

  const result = {
    command: "rename",
    path: target,
    dryRun,
    files: files.length,
    confirmed: null as boolean | null,
    operations: [] as Record<string, unknown>[],
    summary: summarizeOperations([]),
    skippedSelections: selection.skippedNonInteractive,
    coverArt: [] as string[],
    historySaved: 0,
  };
  const finish = (ops: PlannedOperation[], code: number): number => {
    if (json) {
      result.operations = ops.map(operationToJson);
      result.summary = summarizeOperations(ops);
      ui.json(result);
    }
    return code;
  };

  if (files.length === 0) {
    if (!json) ui.print(c.yellow(text.notFound));
    return finish([], EXIT_OK);
  }
  if (!json) ui.print(`Found ${c.cyan(formatCount(files.length))} file(s) to process.`);

  const progress = ui.progress;
  const operations = await raceAbort(
    session.plan(files, {
      destinationDir: options.output ? path.resolve(options.output) : undefined,
      signal,
      progressCallback: (current, total, message) => progress.update(message, current, total),
    }),
    signal,
  );
  progress.clear();

  if (!json) showPreview(ui, operations, options.output ? path.resolve(options.output) : undefined);
  if (selection.skippedNonInteractive.length > 0) {
    ui.note(
      ui.ec.yellow(
        `${selection.skippedNonInteractive.length} file(s) had several matches and were skipped because stdin is not a terminal. Use --auto-select to take the first match.`,
      ),
    );
  }
  const lookupFailures = reportLookupFailures(ctx, operations);
  const failureCode = () =>
    lookupFailures > 0 || operations.some((op) => op.status === "failed") ? EXIT_ERROR : EXIT_OK;

  if (!operations.some((op) => op.status === "pending")) {
    if (!json) ui.print(c.yellow("No matches found."));
    return finish(operations, failureCode());
  }

  if (dryRun) {
    if (!json) {
      ui.print();
      ui.print(c.yellow("Dry run - no files were renamed."));
    }
    return finish(operations, failureCode());
  }

  if (!options.yes) {
    ui.note();
    const ok = await ctx.deps.prompter.confirm("Proceed with rename?", { default: false, signal });
    result.confirmed = ok;
    if (!ok) {
      if (!json) ui.print(c.yellow("Canceled."));
      return finish(operations, failureCode());
    }
  } else {
    result.confirmed = true;
  }

  // Renaming is not interrupted halfway: Ctrl+C takes effect once it is done
  // and the history (for undo) has been saved.
  await session.execute(operations, progress.callback());
  progress.clear();
  result.historySaved = await session.saveHistory(operations);

  if (!json) showResults(ui, operations);
  if (signal?.aborted) throw new CancelledError();

  const completed = operations.some((op) => op.status === "completed");
  if ((options.coverArt || session.coverArtEnabled) && completed) {
    if (!json) {
      ui.print();
      ui.print(c.dim("Downloading cover art..."));
    }
    result.coverArt = await raceAbort(
      session.downloadCoverArt(operations, progress.callback()),
      signal,
    );
    progress.clear();
    if (!json && result.coverArt.length > 0) {
      ui.print(c.green(`Downloaded ${result.coverArt.length} cover art file(s)`));
    }
  }

  return finish(operations, failureCode());
}
