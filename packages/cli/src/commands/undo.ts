/**
 * `undo`: move the files of the last rename back to their original names
 * (or remove the copies and links it made). `--list` shows the history;
 * `--entry N` undoes an older entry instead.
 */

import {
  listHistory,
  undoHistoryEntry,
  undoLastRename,
  type HistoryEntry,
  type TransferMode,
  type UndoKeptReason,
  type UndoResult,
} from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { EXIT_ERROR, EXIT_OK, UsageError } from "../errors";
import { base, formatCount, formatHistoryTimestamp } from "../format";
import { makeTable } from "../ui";

export interface UndoCommandOptions extends GlobalOptions {
  yes?: boolean;
  json?: boolean;
  list?: boolean;
  /** 1-based position in `--list` (1 is the most recent). */
  entry?: number;
}

const KEPT_TEXT: Record<UndoKeptReason, string> = {
  changed: "it was replaced or changed since the rename",
  original_missing: "the original is gone, so this may be the only copy",
  renamed_later: "a later rename touched it; undo that one first",
};

const TRANSFER_LABEL: Record<TransferMode | "mixed", string> = {
  move: "Moved",
  copy: "Copied",
  hardlink: "Hard linked",
  mixed: "Mixed",
};

async function listCommand(ctx: CommandContext, options: UndoCommandOptions): Promise<number> {
  const { ui } = ctx;
  const c = ui.c;
  const config = ctx.config(options);
  await config.load();
  const history = await listHistory(config);

  if (options.json) {
    ui.json({
      command: "undo",
      history: history.map((e) => ({
        entry: e.position + 1,
        timestamp: e.timestamp,
        operations: e.operations,
        files: e.files,
        transfer: e.transfer,
        samples: e.samples,
      })),
    });
    return EXIT_OK;
  }
  if (history.length === 0) {
    ui.print(c.yellow("No rename history found."));
    return EXIT_OK;
  }
  const table = makeTable(["#", "Renamed", "Files", "How", "First file"], c);
  for (const e of history) {
    const first = e.samples[0];
    table.push([
      c.cyan(String(e.position + 1)),
      formatHistoryTimestamp(e.timestamp),
      formatCount(e.files),
      TRANSFER_LABEL[e.transfer],
      first ? `${base(first.destination)}${e.operations > 1 ? c.dim(` and ${formatCount(e.operations - 1)} more`) : ""}` : "",
    ]);
  }
  ui.print(c.bold("Rename History"));
  ui.print(table.toString());
  ui.print();
  ui.print(c.dim(`Undo one with '${ctx.programName} undo --entry <#>'.`));
  return EXIT_OK;
}

export async function undoCommand(ctx: CommandContext, options: UndoCommandOptions): Promise<number> {
  if (options.list) {
    if (options.entry !== undefined) throw new UsageError("--list and --entry can't be used together.");
    return listCommand(ctx, options);
  }

  const { ui, signal } = ctx;
  const c = ui.c;
  const json = options.json ?? false;
  const config = ctx.config(options);
  await config.load();

  const history = (await config.loadHistory()).filter((e) => e.operations.length > 0);
  const position = (options.entry ?? 1) - 1;
  const target: HistoryEntry | undefined = history[position];
  const operations = target?.operations ?? [];

  const result = {
    command: "undo",
    historyFound: operations.length > 0,
    timestamp: target?.timestamp ?? null,
    confirmed: null as boolean | null,
    items: [] as Record<string, unknown>[],
    undone: 0,
    missing: 0,
    kept: 0,
    failed: 0,
  };

  if (operations.length === 0) {
    if (options.entry !== undefined && history.length > 0) {
      throw new UsageError(
        `There is no entry ${options.entry} in the rename history (it has ${formatCount(history.length)}). See '${ctx.programName} undo --list'.`,
      );
    }
    if (json) ui.json(result);
    else ui.print(c.yellow("No rename history found."));
    return EXIT_OK;
  }

  if (!json) {
    const label = position === 0 ? "Last rename" : `Rename #${position + 1}`;
    ui.print(c.dim(`${label}: ${formatHistoryTimestamp(target!.timestamp)}`));
    if (position > 0) {
      ui.print(c.dim(`${formatCount(position)} later rename(s) stay as they are; files they changed are left in place.`));
    }
    ui.print(c.bold(`Found ${formatCount(operations.length)} file(s) to undo:`));
    for (const op of operations) {
      const action = op.transfer ? ` ${c.dim(`(delete the ${op.transfer === "copy" ? "copy" : "hard link"})`)}` : "";
      ui.print(`  ${base(op.destination)} → ${base(op.source)}${action}`);
    }
  }

  if (!options.yes) {
    ui.note();
    const ok = await ctx.deps.prompter.confirm("Proceed with undo?", { default: false, signal });
    result.confirmed = ok;
    if (!ok) {
      if (json) ui.json(result);
      else ui.print(c.yellow("Aborted."));
      return EXIT_OK;
    }
  } else {
    result.confirmed = true;
  }

  // Undo exactly the entry that was listed and confirmed: if another rename
  // was recorded meanwhile, this throws instead of reversing that one.
  const progressCallback = ui.progress.callback();
  const undo: UndoResult =
    position === 0
      ? await undoLastRename(config, { progressCallback, expectedTimestamp: target!.timestamp })
      : await undoHistoryEntry(config, target!.timestamp, { progressCallback });
  ui.progress.clear();
  Object.assign(result, {
    undone: undo.undone,
    missing: undo.missing,
    kept: undo.kept,
    failed: undo.failed,
    items: undo.items.map((item) => ({
      source: item.operation.source,
      destination: item.operation.destination,
      status: item.status,
      errors: item.errors,
      kept: item.kept,
    })),
  });

  if (json) {
    ui.json(result);
  } else {
    for (const item of undo.items) {
      if (item.status === "failed") {
        ui.print(c.red(`Failed to undo ${base(item.operation.destination)}: ${item.errors.join("; ")}`));
      }
      for (const kept of item.kept) {
        ui.print(c.yellow(`Left in place: ${base(kept.path)} (${KEPT_TEXT[kept.reason]})`));
      }
    }
    ui.print();
    ui.print(`${c.green("Undone:")} ${undo.undone}`);
    if (undo.missing) ui.print(`${c.yellow("Not found:")} ${undo.missing}`);
    if (undo.kept) ui.print(`${c.yellow("Left in place:")} ${undo.kept}`);
    if (undo.failed) ui.print(`${c.red("Failed:")} ${undo.failed}`);
  }
  return undo.failed > 0 ? EXIT_ERROR : EXIT_OK;
}
