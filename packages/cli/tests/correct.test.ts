import { readdir } from "node:fs/promises";
import {
  createEpisode,
  createMovie,
  createTVShow,
  type Episode,
  type TVProvider,
  type TVShow,
} from "@tidytitles/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeMovieProvider,
  FakePrompter,
  FakeTVProvider,
  MATRIX_FILE,
  createSandbox,
  matrix,
  matrixReloaded,
  runIn,
  touch,
  writeKeys,
  type RunOptions,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox();
  await writeKeys(sb.configDir, { tmdb: "tmdb-secret-key", tvdb: "tvdb-secret-key" });
});

afterEach(async () => {
  await sb.cleanup();
});

const revolutions = createMovie({ id: 605, title: "The Matrix Revolutions", originalTitle: "The Matrix Revolutions", year: 2003 });

const officeUK: TVShow = createTVShow({ id: 1, title: "The Office", originalTitle: "The Office", year: 2001 });
const officeUS: TVShow = createTVShow({ id: 2, title: "The Office (US)", originalTitle: "The Office", year: 2005 });
const officeUK2: TVShow = createTVShow({ id: 3, title: "The Office (AU)", originalTitle: "The Office", year: 2024 });

/** Shows by title and episodes by show id and "season:episode". */
class EpisodeTV implements TVProvider {
  constructor(
    private shows: Record<string, TVShow[]>,
    private episodes: Record<number, Record<string, Episode>>,
  ) {}
  async searchShow(title: string) {
    return this.shows[title] ?? [];
  }
  async getShow() {
    return undefined;
  }
  async getEpisode(id: number, season: number, episode: number) {
    return this.episodes[id]?.[`${season}:${episode}`];
  }
}

const usEpisodes = Object.fromEntries(
  ["Pilot", "Diversity Day", "Health Care"].map((title, i) => [
    `1:${i + 1}`,
    createEpisode({ show: officeUS, season: 1, episode: i + 1, title }),
  ]),
);

function rename(args: string[], options: RunOptions, providers: { movie?: FakeMovieProvider; tv?: TVProvider } = {}) {
  return runIn(["rename", ...args, "--config-dir", sb.configDir], {
    session: {
      providers: {
        movieProvider: providers.movie ?? new FakeMovieProvider(),
        tvProvider: providers.tv ?? new FakeTVProvider(),
      },
    },
    ...options,
  });
}

describe("searching with different words", () => {
  const two = () =>
    new FakeMovieProvider({
      "The Matrix": [matrix, matrixReloaded],
      "Matrix Revolutions": [revolutions],
      Reloaded: [matrixReloaded],
    });

  it("answers the prompt directly when the pick was among its options", async () => {
    await touch(sb.media, MATRIX_FILE);
    // Search, type "Reloaded" (an empty year keeps the parsed one), pick the first result.
    const prompter = new FakePrompter([], ["search", 0], ["Reloaded", ""]);
    const r = await rename([sb.media, "-y"], { prompter, stdinIsTTY: true }, { movie: two() });
    expect(r.code).toBe(0);
    expect(prompter.calls.filter((c) => c.kind === "input").map((c) => c.message)).toEqual(["Movie title:", "Year (optional):"]);
    expect(r.stderr).toContain("Results for: Reloaded");
    expect(await readdir(sb.media)).toEqual(["The Matrix Reloaded (2003).mkv"]);
  });

  it("applies a pick that was not among the options after the lookup, as a manual selection", async () => {
    await touch(sb.media, MATRIX_FILE);
    const prompter = new FakePrompter([], ["search", 0], ["Matrix Revolutions", ""]);
    const r = await rename([sb.media, "-n", "--json"], { prompter, stdinIsTTY: true }, { movie: two() });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { operations: Array<{ destination: string; match: { id: number; verificationStatus: string }; correction: string }> };
    expect(out.operations[0]!.destination).toMatch(/The Matrix Revolutions \(2003\)\.mkv$/);
    expect(out.operations[0]!.match).toMatchObject({ id: 605, verificationStatus: "manual_selection" });
    expect(out.operations[0]!.correction).toBe("chosen");
  });

  it("can search again, as the other kind, and skip", async () => {
    await touch(sb.media, MATRIX_FILE);
    // search → (title, year) → "search again" → (title, year) → "search as TV" → (show, year, season, episode) → skip
    const prompter = new FakePrompter(
      [],
      ["search", "words", "kind", "skip"],
      ["Nothing Here", "", "Still Nothing", "", "", "", "", ""],
    );
    const r = await rename([sb.media, "-n"], { prompter, stdinIsTTY: true }, { movie: two() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Nothing found for "Nothing Here".');
    const inputs = prompter.calls.filter((c) => c.kind === "input").map((c) => c.message);
    expect(inputs.slice(4)).toEqual(["Show title:", "Year (optional):", "Season:", "Episode:"]);
    expect(r.stdout).toContain("(skipped: no match)");
  });

  it("gives a chosen show to the other episodes with the same parsed title", async () => {
    for (const e of [1, 2, 3]) await touch(sb.media, `The.Office.S01E0${e}.mkv`);
    const tv = new EpisodeTV(
      { "The Office": [officeUK, officeUK2], "Office US": [officeUS] },
      { [officeUS.id]: usEpisodes },
    );
    // Asked once (the same options for every episode): search, pick the US show, give it to the others.
    const prompter = new FakePrompter([true, true], ["search", 0], ["Office US", "", "", ""]);
    const r = await rename([sb.media], { prompter, stdinIsTTY: true }, { tv });
    expect(r.code).toBe(0);
    expect(prompter.calls.filter((c) => c.kind === "select")).toHaveLength(2);
    expect(prompter.calls.filter((c) => c.kind === "confirm").map((c) => c.message)).toEqual([
      'Use The Office (US) for the 2 other file(s) named "The Office" too?',
      "Proceed with rename?",
    ]);
    expect((await readdir(sb.media)).sort()).toEqual([
      "The Office (US) - S01E01 - Pilot.mkv",
      "The Office (US) - S01E02 - Diversity Day.mkv",
      "The Office (US) - S01E03 - Health Care.mkv",
    ]);
  });
});

describe("files without a match", () => {
  it("offers the same search after the lookup", async () => {
    await touch(sb.media, "Unknown.Film.2021.mkv");
    const movie = new FakeMovieProvider({ Inception: [createMovie({ id: 27205, title: "Inception", originalTitle: "Inception", year: 2010 })] });
    const prompter = new FakePrompter([true], ["words", 0], ["Inception", ""]);
    const r = await rename([sb.media], { prompter, stdinIsTTY: true }, { movie });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("No match found for: Unknown.Film.2021.mkv");
    // The search starts from what the lookup searched for.
    expect(movie.calls[0]).toEqual(["Unknown Film", 2021]);
    expect(movie.calls[1]).toEqual(["Inception", 2021]);
    expect(await readdir(sb.media)).toEqual(["Inception (2010).mkv"]);
  });

  it("skips all remaining files without a match on request", async () => {
    await touch(sb.media, "Unknown.Film.2021.mkv");
    await touch(sb.media, "Another.Unknown.2020.mkv");
    const prompter = new FakePrompter([], ["skipAll"]);
    const r = await rename([sb.media, "-n"], { prompter, stdinIsTTY: true });
    expect(r.code).toBe(0);
    expect(prompter.calls).toHaveLength(1);
  });

  it("asks nothing without a terminal or with --auto-select", async () => {
    await touch(sb.media, "Unknown.Film.2021.mkv");
    const prompter = new FakePrompter();
    expect((await rename([sb.media, "-n"], { prompter, stdinIsTTY: false })).code).toBe(0);
    expect((await rename([sb.media, "-n", "-a"], { prompter, stdinIsTTY: true })).code).toBe(0);
    expect(prompter.calls).toEqual([]);
  });
});
