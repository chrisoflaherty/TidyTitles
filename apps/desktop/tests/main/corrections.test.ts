import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppController } from "../../src/main/controller";
import { FakeTVProvider, createFakeSessionOverrides } from "../../src/e2e/fakes";
import { EVENTS, type AppState, type MatchSearchOutcome } from "../../src/shared/ipc";
import { KEYS_TOML, createHarness, type Harness } from "./helpers";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

function idOf(name: string): number {
  const file = h.controller.getState().files.find((f) => f.name === name);
  if (!file) throw new Error(`no file ${name}`);
  return file.id;
}

function opOf(name: string) {
  const state = h.controller.getState();
  const i = state.files.findIndex((f) => f.name === name);
  return state.operations![i]!;
}

async function plan(...names: string[]) {
  h = await createHarness(KEYS_TOML);
  for (const name of names) await h.touch(name);
  await h.controller.addPaths([h.media]);
  expect((await h.controller.fetch()).kind).toBe("done");
}

function results(outcome: MatchSearchOutcome) {
  if (outcome.kind !== "results") throw new Error(`expected results, got ${outcome.kind}`);
  return outcome;
}

describe("AppController: changing a match", () => {
  it("starts the search with what the fetch searched for", async () => {
    await plan("Unknown.Film.2021.mkv", "The.Office.S01E02.mkv", "The.Office.S01E03.mkv", "Daft Punk - One More Time.flac");
    expect(h.controller.getMatchContext(idOf("Unknown.Film.2021.mkv"))).toEqual({
      kind: "ok",
      context: {
        fileId: idOf("Unknown.Film.2021.mkv"),
        query: { mediaType: "movie", title: "Unknown Film", year: 2021 },
        queryTypes: ["movie", "tv_episode"],
        parsedTitle: "Unknown Film",
        similarCount: 0,
      },
    });
    const tv = h.controller.getMatchContext(idOf("The.Office.S01E02.mkv"));
    expect(tv).toMatchObject({
      kind: "ok",
      context: { query: { mediaType: "tv_episode", title: "The Office", season: 1, episode: 2 }, similarCount: 1 },
    });
    const music = h.controller.getMatchContext(idOf("Daft Punk - One More Time.flac"));
    expect(music).toMatchObject({
      kind: "ok",
      context: { query: { mediaType: "music", title: "One More Time", artist: "Daft Punk" }, queryTypes: ["music"] },
    });
  });

  it("gives a file without a match a result of a search with other words", async () => {
    await plan("Unknown.Film.2021.mkv");
    const id = idOf("Unknown.Film.2021.mkv");
    const found = results(await h.controller.searchMatches(id, { mediaType: "movie", title: "Matrix Reloaded" }));
    expect(found.options.map((o) => o.title)).toEqual(["The Matrix Reloaded"]);

    const states = h.events.length;
    expect(await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: false })).toEqual({
      kind: "applied",
      changed: 1,
      unmatched: 0,
    });
    const op = opOf("Unknown.Film.2021.mkv");
    expect(op.status).toBe("pending");
    expect(path.basename(op.destination)).toBe("The Matrix Reloaded (2003).mkv");
    expect(op.mediaFile.matchedMetadata?.verificationStatus).toBe("manual_selection");
    // The list was busy while the plan changed.
    const busy = h.events.slice(states).filter((e) => e.channel === EVENTS.state).map((e) => (e.payload as AppState).busy);
    expect(busy).toContain("correcting");
    expect(h.controller.getState().busy).toBeNull();
    // The search was used; a second choice from it is still allowed (same search).
    expect(h.controller.getState().status.text).toContain("Matched Unknown.Film.2021.mkv to The Matrix Reloaded");
  });

  it("re-checks conflicts: a chosen match that another file already gets is a duplicate", async () => {
    await plan("Inception.2010.mkv", "Unknown.Film.2021.mkv");
    const found = results(await h.controller.searchMatches(idOf("Unknown.Film.2021.mkv"), { mediaType: "movie", title: "Inception" }));
    await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: false });
    expect(opOf("Unknown.Film.2021.mkv").skipReason).toBe("duplicate_destination");
    expect(opOf("Inception.2010.mkv").status).toBe("pending");

    // Clearing the other file's match frees the name.
    expect(await h.controller.clearMatch(idOf("Inception.2010.mkv"))).toEqual({ kind: "applied" });
    expect(opOf("Inception.2010.mkv").skipReason).toBe("match_cleared");
    expect(opOf("Unknown.Film.2021.mkv").status).toBe("pending");

    const outcome = await h.controller.rename();
    expect(outcome.kind === "done" && outcome.summary.completed).toBe(1);
    expect(existsSync(path.join(h.media, "Inception (2010).mkv"))).toBe(true);
    expect(existsSync(path.join(h.media, "Inception.2010.mkv"))).toBe(true);
  });

  it("gives a chosen show to the other episodes with the same parsed title", async () => {
    await plan("The.Office.S01E01.mkv", "The.Office.S01E02.mkv", "The.Office.S01E03.mkv", "The.Office.S01E04.mkv", "Inception.2010.mkv");
    expect(path.basename(opOf("The.Office.S01E01.mkv").destination)).toBe("The Office - S01E01 - Downsize.mkv");

    const id = idOf("The.Office.S01E01.mkv");
    const context = h.controller.getMatchContext(id);
    expect(context.kind === "ok" && context.context.similarCount).toBe(3);
    const found = results(await h.controller.searchMatches(id, { mediaType: "tv_episode", title: "Office", season: 1, episode: 1 }));
    expect(found.options.map((o) => o.title)).toEqual(["The Office (US)", "The Office"]);

    expect(await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: true })).toEqual({
      kind: "applied",
      changed: 3,
      unmatched: 1,
    });
    expect(
      ["The.Office.S01E01.mkv", "The.Office.S01E02.mkv", "The.Office.S01E03.mkv", "The.Office.S01E04.mkv"].map((n) =>
        path.basename(opOf(n).destination),
      ),
    ).toEqual([
      "The Office (US) - S01E01 - Pilot.mkv",
      "The Office (US) - S01E02 - Diversity Day.mkv",
      "The Office (US) - S01E03 - Health Care.mkv",
      // No fourth episode in the fake US show: left as it was.
      "The.Office.S01E04.mkv",
    ]);
    expect(h.controller.getState().status.tone).toBe("warning");
  });

  it("uses season and episode numbers corrected after the search", async () => {
    await plan("The.Office.S01E01.mkv");
    const id = idOf("The.Office.S01E01.mkv");
    const found = results(await h.controller.searchMatches(id, { mediaType: "tv_episode", title: "The Office US" }));
    expect(await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: false })).toEqual({ kind: "needsEpisode" });
    expect(await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: false, season: 1, episode: 9 })).toEqual({
      kind: "episodeNotFound",
      season: 1,
      episode: 9,
    });
    await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: false, season: 1, episode: 3 });
    expect(path.basename(opOf("The.Office.S01E01.mkv").destination)).toBe("The Office (US) - S01E03 - Health Care.mkv");
  });

  it("reports provider errors and missing providers as typed outcomes", async () => {
    await plan("Unknown.Film.2021.mkv");
    const id = idOf("Unknown.Film.2021.mkv");
    await expect(h.controller.searchMatches(id, { mediaType: "tv_episode", title: "Broken Show" })).resolves.toMatchObject({
      kind: "error",
      error: { kind: "provider" },
    });
    // A video file cannot be searched as music.
    await expect(h.controller.searchMatches(id, { mediaType: "music", title: "x" })).resolves.toEqual({ kind: "unavailable" });
  });

  it("reports a kind of search no service is set up for", async () => {
    h = await createHarness();
    // Only a TV provider: movies have no service (as without a TMDB key).
    const controller = new AppController({
      config: h.config,
      emit: () => undefined,
      sessionOverrides: { ...createFakeSessionOverrides(), providers: { tvProvider: new FakeTVProvider() } },
    });
    await controller.init();
    await h.touch("Unknown.Film.2021.mkv");
    await controller.addPaths([h.media]);
    await controller.fetch();
    const id = controller.getState().files[0]!.id;
    await expect(controller.searchMatches(id, { mediaType: "movie", title: "Inception" })).resolves.toEqual({
      kind: "noProvider",
      mediaType: "movie",
    });
    await expect(controller.searchMatches(id, { mediaType: "tv_episode", title: "The Office" })).resolves.toMatchObject({
      kind: "results",
    });
  });

  it("refuses stale searches and corrections without a plan", async () => {
    await plan("Unknown.Film.2021.mkv");
    const id = idOf("Unknown.Film.2021.mkv");
    const found = results(await h.controller.searchMatches(id, { mediaType: "movie", title: "Inception" }));
    expect(await h.controller.chooseMatch("other-id", 0, { applyToSimilar: false })).toEqual({ kind: "unavailable" });
    expect(await h.controller.chooseMatch(found.searchId, 5, { applyToSimilar: false })).toEqual({ kind: "unavailable" });

    // A new fetch drops the plan the search was for.
    await h.controller.fetch();
    expect(await h.controller.chooseMatch(found.searchId, 0, { applyToSimilar: false })).toEqual({ kind: "unavailable" });
    expect(h.controller.getMatchContext(9999)).toEqual({ kind: "unavailable" });

    // After a rename, the plan can no longer be corrected.
    h.controller.clearFiles();
    expect(h.controller.getMatchContext(id)).toEqual({ kind: "unavailable" });
    expect(await h.controller.clearMatch(id)).toEqual({ kind: "unavailable" });
    expect(await h.controller.setFileName(id, "x")).toEqual({ kind: "unavailable" });
  });
});

describe("AppController: editing a new name", () => {
  it("sets a typed name, moves associated files with it, and survives until the next fetch", async () => {
    await plan("Inception.2010.mkv", "Inception.2010.en.srt");
    const id = idOf("Inception.2010.mkv");
    expect(await h.controller.getEditableName(id)).toEqual({
      kind: "ok",
      name: { name: "Inception (2010)", templateName: "Inception (2010)", extension: ".mkv", folder: "", custom: false },
    });

    expect(await h.controller.setFileName(id, "Inception (2010) {Extended}")).toEqual({ kind: "applied" });
    const op = opOf("Inception.2010.mkv");
    expect(path.basename(op.destination)).toBe("Inception (2010) {Extended}.mkv");
    expect(op.associatedFiles.map((a) => path.basename(a.destination))).toEqual(["Inception (2010) {Extended}.en.srt"]);
    expect(op.mediaFile.correction?.customName).toBe("Inception (2010) {Extended}");

    await h.controller.fetch();
    expect(path.basename(opOf("Inception.2010.mkv").destination)).toBe("Inception (2010).mkv");
  });

  it("refuses invalid names and names already taken, with nothing changed", async () => {
    await plan("Inception.2010.mkv", "Unknown.Film.2021.mkv");
    await writeFile(path.join(h.media, "Taken.mkv"), "keep");
    const id = idOf("Inception.2010.mkv");
    const before = opOf("Inception.2010.mkv");
    await expect(h.controller.setFileName(id, "../escape")).resolves.toMatchObject({ kind: "invalid", problem: "invalid_characters" });
    await expect(h.controller.setFileName(id, "  ")).resolves.toMatchObject({ kind: "invalid", problem: "empty" });
    await expect(h.controller.setFileName(id, "Taken")).resolves.toMatchObject({ kind: "invalid", problem: "exists" });
    expect(opOf("Inception.2010.mkv")).toEqual(before);
    // No match, no name to edit.
    expect(await h.controller.getEditableName(idOf("Unknown.Film.2021.mkv"))).toEqual({ kind: "unavailable" });
    expect(await readFile(path.join(h.media, "Taken.mkv"), "utf8")).toBe("keep");
  });

  it("re-checks conflicts after a typed name, and goes back to the template's name", async () => {
    await plan("Inception.2010.mkv", "The.Office.S01E01.mkv");
    await h.controller.setFileName(idOf("The.Office.S01E01.mkv"), "Inception (2010)");
    expect(opOf("The.Office.S01E01.mkv").skipReason).toBe("duplicate_destination");
    expect(opOf("Inception.2010.mkv").status).toBe("pending");

    await h.controller.setFileName(idOf("The.Office.S01E01.mkv"), null);
    expect(opOf("The.Office.S01E01.mkv").status).toBe("pending");
    expect(path.basename(opOf("The.Office.S01E01.mkv").destination)).toBe("The Office - S01E01 - Downsize.mkv");
  });
});
