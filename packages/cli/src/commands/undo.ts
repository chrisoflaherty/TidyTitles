/** `undo`: move the files of the last rename back to their original names. */

import { undoLastRename } from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { EXIT_ERROR, EXIT_OK } from "../errors";
import { base, formatCount, formatHistoryTimestamp } from "../format";

export interface UndoCommandOptions extends GlobalOptions {
  yes?: boolean;
  json?: boolean;
}

export async function undoCommand(ctx: CommandContext, options: UndoCommandOptions): Promise<number> {
  const { ui, signal } = ctx;
  const c = ui.c;
  const json = options.json ?? false;
  const config = ctx.config(options);
  await config.load();

  const history = await config.loadHistory();
  const last = history[0];
  const operations = last?.operations ?? [];

  const result = {
    command: "undo",
    historyFound: operations.length > 0,
    timestamp: last?.timestamp ?? null,
    confirmed: null as boolean | null,
    items: [] as Record<string, unknown>[],
    undone: 0,
    missing: 0,
    failed: 0,
  };

  if (operations.length === 0) {
    if (json) ui.json(result);
    else ui.print(c.yellow("No rename history found."));
    return EXIT_OK;
  }

  if (!json) {
    ui.print(c.dim(`Last rename: ${formatHistoryTimestamp(last!.timestamp)}`));
    ui.print(c.bold(`Found ${formatCount(operations.length)} file(s) to undo:`));
    for (const op of operations) ui.print(`  ${base(op.destination)} → ${base(op.source)}`);
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
  const undo = await undoLastRename(config, {
    progressCallback: ui.progress.callback(),
    expectedTimestamp: last!.timestamp,
  });
  ui.progress.clear();
  Object.assign(result, {
    undone: undo.undone,
    missing: undo.missing,
    failed: undo.failed,
    items: undo.items.map((item) => ({
      source: item.operation.source,
      destination: item.operation.destination,
      status: item.status,
      errors: item.errors,
    })),
  });

  if (json) {
    ui.json(result);
  } else {
    for (const item of undo.items) {
      if (item.status === "failed") {
        ui.print(c.red(`Failed to undo ${base(item.operation.destination)}: ${item.errors.join("; ")}`));
      }
    }
    ui.print();
    ui.print(`${c.green("Undone:")} ${undo.undone}`);
    if (undo.missing) ui.print(`${c.yellow("Not found:")} ${undo.missing}`);
    if (undo.failed) ui.print(`${c.red("Failed:")} ${undo.failed}`);
  }
  return undo.failed > 0 ? EXIT_ERROR : EXIT_OK;
}
