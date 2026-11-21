/**
 * Searching with different words in `rename` (interactive terminals only).
 *
 * - In the prompt that asks which match to use, "Search with different
 *   words..." asks for new words and lists what they find. A pick that was
 *   among the original options is answered right away; any other pick is
 *   applied after the lookup with core's PlanCorrector (marked
 *   "manual_selection"), and a TV show can be given to the other files with
 *   the same parsed show title.
 * - After the lookup, each file without a match is offered the same search.
 *
 * Nothing here runs when stdin is not a terminal or with --auto-select.
 */

import path from "node:path";
import {
  describeLookupError,
  defaultMatchQuery,
  queryTypesFor,
  searchMatches,
  type MatchQuery,
  type MatchQueryType,
  type PlannedOperation,
  type RenameSession,
  type SelectableOption,
} from "@tidytitles/core";
import type { CommandContext } from "../context";
import { describeOption } from "../format";
import { makeTable } from "../ui";

/** The search prompt's choice to search with other words. */
export const SEARCH_CHOICE = "search" as const;

interface Chosen {
  query: MatchQuery;
  option: SelectableOption;
}

type MenuValue = number | "words" | "kind" | "skip" | "skipAll";

const KIND_LABEL: Record<MatchQueryType, string> = { movie: "movie", tv_episode: "TV episode", music: "music" };

function sameOption(a: SelectableOption, b: SelectableOption): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function optionTitle(option: SelectableOption): string {
  return option.kind === "track" ? `${option.artist.name} - ${option.title}` : option.title;
}

export class CliCorrections {
  /** Picks made in the selection prompt that were not among its options, by file path. */
  private readonly chosen = new Map<string, Chosen>();

  constructor(
    private readonly ctx: CommandContext,
    private readonly session: RenameSession,
  ) {}

  /** The query the lookup used for the file at `filePath`. */
  private async queryFor(filePath: string): Promise<MatchQuery> {
    const [file] = await this.session.service.parseFiles([filePath]);
    return defaultMatchQuery(file!, this.session.forceType);
  }

  /**
   * "Search with different words..." chosen in the selection prompt for
   * `filePath`. Returns the index of the pick among `options`, or undefined
   * (the pick, if any, is applied after the lookup).
   */
  async searchFromSelection(options: readonly SelectableOption[], filePath: string): Promise<number | undefined> {
    const picked = await this.searchLoop(await this.queryFor(filePath), path.basename(filePath), true);
    if (!picked) return undefined;
    const index = options.findIndex((o) => sameOption(o, picked.option));
    if (index >= 0) return index;
    this.chosen.set(path.normalize(filePath), picked);
    return undefined;
  }

  /**
   * Ask for words (prefilled with `query`), search, and let the user pick.
   * Returns undefined when the user skips.
   */
  private async searchLoop(query: MatchQuery, filename: string, askFirst: boolean): Promise<Chosen | undefined> {
    const { ui } = this.ctx;
    const ec = ui.ec;
    let current = query;
    let ask = askFirst;
    for (;;) {
      if (ask) current = await this.askWords(current);
      ask = true;
      let options: SelectableOption[] = [];
      let problem: string | undefined;
      try {
        const result = await searchMatches(this.session.service, current, { signal: this.ctx.signal });
        options = result.options;
        if (!result.providerAvailable) problem = this.noProvider(current.mediaType);
        else if (options.length === 0) problem = `Nothing found for "${current.title}".`;
      } catch (error) {
        problem = `Search failed: ${describeLookupError(error).message}`;
      }

      ui.note();
      if (problem) ui.note(ec.yellow(problem));
      else {
        ui.note(`${ec.bold("Results for:")} ${current.title} ${ec.dim(`(${filename})`)}`);
        const table = makeTable(["#", "Title", "Artist/Year", "Type"], ec);
        options.forEach((option, i) => {
          const [title, info, kind] = describeOption(option);
          table.push([ec.cyan(String(i + 1)), ec.green(title), ec.yellow(info), ec.blue(kind)]);
        });
        ui.note(table.toString());
      }

      const choices: { name: string; value: MenuValue }[] = options.map((option, i) => {
        const [title, info] = describeOption(option);
        return { name: `${i + 1}. ${title} (${info})`, value: i };
      });
      choices.push({ name: "Search again with different words...", value: "words" });
      const other = this.otherKind(current, filename);
      if (other) choices.push({ name: `Search as a ${KIND_LABEL[other.mediaType]}...`, value: "kind" });
      choices.push({ name: "Skip this file", value: "skip" });
      const answer = await this.ctx.deps.prompter.select<MenuValue>(
        options.length ? `Select match (1-${options.length}), search again, or skip:` : "Search again or skip:",
        choices,
        { signal: this.ctx.signal },
      );
      if (typeof answer === "number") return { query: current, option: options[answer]! };
      if (answer === "skip") return undefined;
      if (answer === "kind" && other) current = other;
    }
  }

  /** The same words as the other kind of video search (movie <-> TV episode). */
  private otherKind(query: MatchQuery, filename: string): MatchQuery | undefined {
    if (!queryTypesFor({ path: filename }).includes("tv_episode")) return undefined;
    if (query.mediaType === "movie") return { mediaType: "tv_episode", title: query.title, ...(query.year ? { year: query.year } : {}) };
    if (query.mediaType === "tv_episode") return { mediaType: "movie", title: query.title, ...(query.year ? { year: query.year } : {}) };
    return undefined;
  }

  private noProvider(mediaType: MatchQueryType): string {
    switch (mediaType) {
      case "movie":
        return "Searching for movies needs a TMDB API key (and provider auto or tmdb).";
      case "tv_episode":
        return "Searching for TV shows needs a TVDB or TMDB API key (and a provider that covers TV).";
      case "music":
        return "Music is searched on MusicBrainz (provider auto or musicbrainz).";
    }
  }

  /** Prompt for each field of the query; an empty answer keeps the shown value. */
  private async askWords(query: MatchQuery): Promise<MatchQuery> {
    const { prompter } = this.ctx.deps;
    const signal = this.ctx.signal;
    const text = async (message: string, value: string | undefined): Promise<string> =>
      (await prompter.input(message, { default: value ?? "", signal })).trim();
    const whole = async (message: string, value: number | undefined): Promise<number | undefined> => {
      for (;;) {
        const answer = await text(message, value === undefined ? undefined : String(value));
        if (answer === "") return undefined;
        if (/^\d{1,6}$/.test(answer)) return Number(answer);
        this.ctx.ui.note(this.ctx.ui.ec.yellow("Use a whole number, or leave it empty."));
      }
    };
    const titleOf = async (message: string): Promise<string> => {
      for (;;) {
        const answer = await text(message, query.title);
        if (answer) return answer;
        this.ctx.ui.note(this.ctx.ui.ec.yellow("Type what to search for."));
      }
    };
    const optional = <T>(key: string, value: T | undefined) => (value === undefined || value === "" ? {} : { [key]: value });

    switch (query.mediaType) {
      case "movie": {
        const title = await titleOf("Movie title:");
        const year = await whole("Year (optional):", query.year);
        return { mediaType: "movie", title, ...optional("year", year) };
      }
      case "tv_episode": {
        const title = await titleOf("Show title:");
        const year = await whole("Year (optional):", query.year);
        const season = await whole("Season:", query.season);
        const episode = await whole("Episode:", query.episode);
        return { mediaType: "tv_episode", title, ...optional("year", year), ...optional("season", season), ...optional("episode", episode) };
      }
      case "music": {
        const title = await titleOf("Track title:");
        const artist = await text("Artist (optional):", query.artist);
        const album = await text("Album (optional):", query.album);
        return { mediaType: "music", title, ...optional("artist", artist), ...optional("album", album) };
      }
    }
  }

  /**
   * After the lookup: apply the picks made in the selection prompt, then
   * offer a search for each file without a match. Returns the corrected
   * operations (the same ones when nothing changed).
   */
  async afterPlan(operations: PlannedOperation[], destinationDir: string | undefined): Promise<PlannedOperation[]> {
    const corrector = this.session.corrector(operations, { destinationDir });
    const indexOf = (filePath: string) =>
      corrector.operations.findIndex((op) => path.normalize(op.source) === path.normalize(filePath));

    for (const [filePath, picked] of this.chosen) {
      const index = indexOf(filePath);
      if (index >= 0) await this.apply(corrector, index, picked);
    }

    let skipAll = false;
    for (let i = 0; i < corrector.operations.length && !skipAll; i++) {
      const op = corrector.operations[i]!;
      if (op.skipReason !== "no_match" || op.mediaFile.selectionSkipped || op.mediaFile.correction) continue;
      const name = path.basename(op.source);
      this.ctx.ui.note();
      this.ctx.ui.note(`${this.ctx.ui.ec.yellow("No match found for:")} ${name}`);
      const answer = await this.ctx.deps.prompter.select<MenuValue>(
        "Search with different words?",
        [
          { name: "Search with different words...", value: "words" },
          { name: "Skip this file", value: "skip" },
          { name: "Skip all files without a match", value: "skipAll" },
        ],
        { signal: this.ctx.signal },
      );
      if (answer === "skipAll") skipAll = true;
      if (answer !== "words") continue;
      const picked = await this.searchLoop(corrector.query(i), name, true);
      if (picked) await this.apply(corrector, i, picked);
    }
    return corrector.operations;
  }

  private async apply(
    corrector: ReturnType<RenameSession["corrector"]>,
    index: number,
    picked: Chosen,
  ): Promise<void> {
    const { ui, signal } = this.ctx;
    const name = path.basename(corrector.operations[index]!.source);
    let applyToSimilar = false;
    if (picked.option.kind === "show") {
      const similar = corrector.similarFiles(index).length;
      if (similar > 0) {
        const title = corrector.operations[index]!.mediaFile.parsedInfo.title;
        applyToSimilar = await this.ctx.deps.prompter.confirm(
          `Use ${picked.option.title} for the ${similar} other file(s) named "${title}" too?`,
          { default: true, signal },
        );
      }
    }
    try {
      const result = await corrector.chooseMatch(index, picked.query, picked.option, { applyToSimilar, signal });
      switch (result.kind) {
        case "applied":
          ui.note(ui.ec.green(`Matched ${result.changed.length} file(s) to ${optionTitle(picked.option)}.`));
          if (result.unmatched.length > 0) {
            ui.note(ui.ec.yellow(`${result.unmatched.length} file(s) have no such episode in ${picked.option.title} and keep their match.`));
          }
          break;
        case "episode_not_found":
          ui.note(ui.ec.yellow(`${picked.option.title} has no season ${result.season}, episode ${result.episode}; ${name} is skipped.`));
          break;
        case "needs_episode":
          ui.note(ui.ec.yellow(`No season and episode numbers for ${name}; it is skipped.`));
          break;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      ui.error(`Could not look up the episode for ${name}: ${describeLookupError(error).message}`);
    }
  }
}
