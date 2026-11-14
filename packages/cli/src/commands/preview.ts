/** `preview PATH`: show how filenames parse, without lookups or renaming. */

import { collectMediaFiles, createParser } from "@tidytitles/core";
import type { CommandContext, GlobalOptions } from "../context";
import { EXIT_OK, raceAbort } from "../errors";
import { base } from "../format";
import { makeTable } from "../ui";
import { requireExistingPath } from "./shared";

export interface PreviewOptions extends GlobalOptions {
  recursive?: boolean;
  json?: boolean;
}

export async function previewCommand(
  ctx: CommandContext,
  rawPath: string,
  options: PreviewOptions,
): Promise<number> {
  const { ui } = ctx;
  const c = ui.c;
  const target = requireExistingPath(rawPath);

  // Video files only, as the Python `preview` (a file named directly is always included).
  const files = await raceAbort(
    collectMediaFiles([target], { mediaType: "movie", recursive: options.recursive ?? false }),
    ctx.signal,
  );

  const parser = ctx.deps.session?.parser ?? createParser();
  const rows = files.map((file) => {
    const parsed = parser.parse(base(file));
    return {
      path: file,
      filename: base(file),
      mediaType: parsed.mediaType,
      title: parsed.title,
      year: parsed.year ?? null,
      season: parsed.season ?? null,
      episode: parsed.episode ?? null,
    };
  });

  if (options.json) {
    ui.json({ command: "preview", path: target, files: rows });
    return EXIT_OK;
  }

  if (rows.length === 0) {
    ui.print(c.yellow("No video files found."));
    return EXIT_OK;
  }

  const dash = (v: number | null) => (v == null ? "-" : String(v));
  const table = makeTable(["Filename", "Type", "Title", "Year", "Season", "Episode"], c);
  for (const row of rows) {
    table.push([
      row.filename,
      row.mediaType,
      row.title,
      dash(row.year),
      dash(row.season),
      dash(row.episode),
    ]);
  }
  ui.print(c.bold("Parsed File Information"));
  ui.print(table.toString());
  return EXIT_OK;
}
