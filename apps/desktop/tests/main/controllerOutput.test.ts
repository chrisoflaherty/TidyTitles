/** AppController: output folders, transfer modes, and undo of older history entries. */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEYS_TOML, createHarness, type Harness } from "./helpers";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const outputToml = (folders: { movie?: string; tv?: string; music?: string }, mode = "move") =>
  `${KEYS_TOML}[output]\nmovie = ${JSON.stringify(folders.movie ?? "")}\ntv = ${JSON.stringify(folders.tv ?? "")}\nmusic = ${JSON.stringify(folders.music ?? "")}\ntransfer_mode = "${mode}"\n`;

async function plan(harness: Harness, names: string[]) {
  for (const name of names) await harness.touch(name);
  await harness.controller.addPaths([harness.media]);
  const outcome = await harness.controller.fetch();
  return outcome;
}

describe("AppController: output folders", () => {
  it("shows the output folders in the state and plans into them", async () => {
    h = await createHarness();
    const movies = path.join(h.dir, "Movies");
    await mkdir(movies);
    await writeFile(path.join(h.config.configDir, "config.toml"), outputToml({ movie: movies }));
    await h.controller.init();
    expect(h.controller.getState().output).toEqual({ movie: movies, tv: "", music: "" });

    await plan(h, ["Inception.2010.720p.mkv", "Breaking.Bad.S01E01.720p.mkv"]);
    const ops = h.controller.getState().operations!;
    const inception = ops.find((o) => o.source.includes("Inception"))!;
    const episode = ops.find((o) => o.source.includes("Breaking"))!;
    expect(inception.destination).toBe(path.join(movies, "Inception (2010).mkv"));
    expect(path.dirname(episode.destination)).toBe(h.media);

    const outcome = await h.controller.rename();
    expect(outcome).toMatchObject({ kind: "done", transferMode: "move" });
    expect(await readdir(movies)).toEqual(["Inception (2010).mkv"]);
    // The list follows the moved file.
    expect(h.controller.getState().files.map((f) => f.path)).toContain(path.join(movies, "Inception (2010).mkv"));
  });

  it("reports a missing output folder at fetch time, before anything can be renamed", async () => {
    const missing = path.join("/", "nonexistent-tidytitles-volume", "Movies");
    h = await createHarness(outputToml({ movie: missing }));
    const outcome = await plan(h, ["Inception.2010.720p.mkv"]);
    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" && outcome.message).toContain("doesn't exist");
    expect(h.controller.getState().plan).toBe("none");
    expect(await readdir(h.media)).toEqual(["Inception.2010.720p.mkv"]);
  });

  it("refuses the whole rename when a folder went away after the fetch", async () => {
    h = await createHarness();
    const movies = path.join(h.dir, "Movies");
    await mkdir(movies);
    await writeFile(path.join(h.config.configDir, "config.toml"), outputToml({ movie: movies }));
    await h.controller.init();
    await plan(h, ["Inception.2010.720p.mkv", "Breaking.Bad.S01E01.720p.mkv"]);
    await rmdir(movies);
    const outcome = await h.controller.rename();
    expect(outcome.kind).toBe("error");
    expect((await readdir(h.media)).sort()).toEqual(["Breaking.Bad.S01E01.720p.mkv", "Inception.2010.720p.mkv"]);
    expect(await h.config.loadHistory()).toEqual([]);
  });

  it("saves output folders, the transfer mode, and the history limit from Settings", async () => {
    h = await createHarness(KEYS_TOML);
    const payload = await h.controller.getSettingsPayload();
    const movies = path.join(h.dir, "Movies");
    const result = await h.controller.saveSettings({
      ...payload.settings,
      output: { movie: movies, tv: "", music: "", transferMode: "copy" },
      history: { maxEntries: 500 },
    });
    expect(result).toEqual({ ok: true });
    const toml = await readFile(path.join(h.config.configDir, "config.toml"), "utf8");
    expect(toml).toContain(`[output]\nmovie = ${JSON.stringify(movies)}`);
    expect(toml).toContain('transfer_mode = "copy"');
    expect(toml).toContain("[history]\nmax_entries = 500");
    // The main window's Transfer option follows a changed default.
    expect(h.controller.getState().options.transferMode).toBe("copy");
    expect(h.controller.getState().output.movie).toBe(movies);
  });
});

describe("AppController: transfer modes", () => {
  it("copies, keeps the originals in the list, and undo removes only the copies", async () => {
    h = await createHarness(outputToml({}, "copy"));
    expect(h.controller.getState().options.transferMode).toBe("copy");
    await plan(h, ["Inception.2010.720p.mkv", "Inception.2010.720p.en.srt"]);
    const before = h.controller.getState().files.map((f) => f.path);
    const outcome = await h.controller.rename();
    expect(outcome).toMatchObject({ kind: "done", transferMode: "copy", associatedRenamed: 1 });
    expect((await readdir(h.media)).sort()).toEqual([
      "Inception (2010).en.srt",
      "Inception (2010).mkv",
      "Inception.2010.720p.en.srt",
      "Inception.2010.720p.mkv",
    ]);
    expect(h.controller.getState().files.map((f) => f.path)).toEqual(before);
    expect(h.controller.getState().status.text).toMatch(/^Copied 1 file/);

    const undo = await h.controller.undo();
    expect(undo).toMatchObject({ kind: "done", undone: 1, kept: 0 });
    expect((await readdir(h.media)).sort()).toEqual(["Inception.2010.720p.en.srt", "Inception.2010.720p.mkv"]);
    expect(h.controller.getState().files.map((f) => f.path)).toEqual(before);
  });

  it("switches the transfer mode of a plan without fetching again", async () => {
    h = await createHarness(KEYS_TOML);
    await plan(h, ["Inception.2010.720p.mkv"]);
    h.controller.setOptions({ transferMode: "hardlink" });
    const state = h.controller.getState();
    expect(state.plan).toBe("planned");
    expect(state.options.transferMode).toBe("hardlink");
    const outcome = await h.controller.rename();
    expect(outcome).toMatchObject({ kind: "done", transferMode: "hardlink" });
    expect((await readdir(h.media)).sort()).toEqual(["Inception (2010).mkv", "Inception.2010.720p.mkv"]);
  });
});

describe("AppController: history", () => {
  it("lists the history and undoes an older entry, leaving the later one", async () => {
    h = await createHarness(KEYS_TOML);
    await plan(h, ["Inception.2010.720p.mkv"]);
    await h.controller.rename();
    await new Promise((r) => setTimeout(r, 5));
    await h.controller.clearFiles();
    const second = path.join(h.dir, "second");
    await mkdir(second);
    await writeFile(path.join(second, "Breaking.Bad.S01E01.720p.mkv"), "");
    await h.controller.addPaths([second]);
    await h.controller.fetch();
    await h.controller.rename();

    const history = await h.controller.getHistory();
    expect(history.map((e) => [e.position, e.operations, e.transfer])).toEqual([
      [0, 1, "move"],
      [1, 1, "move"],
    ]);
    expect(path.basename(history[1]!.samples[0]!.destination)).toBe("Inception (2010).mkv");

    const outcome = await h.controller.undoEntry(history[1]!.timestamp);
    expect(outcome).toMatchObject({ kind: "done", undone: 1, kept: 0, failed: 0 });
    expect(existsSync(path.join(h.media, "Inception.2010.720p.mkv"))).toBe(true);
    expect(existsSync(path.join(second, "Breaking Bad - S01E01 - Pilot.mkv"))).toBe(true);
    expect((await h.controller.getHistory()).map((e) => e.timestamp)).toEqual([history[0]!.timestamp]);
    expect(h.controller.getState().lastRename?.timestamp).toBe(history[0]!.timestamp);
  });

  it("reports a file left in place, and an entry that is gone", async () => {
    h = await createHarness(KEYS_TOML);
    await plan(h, ["Inception.2010.720p.mkv"]);
    await h.controller.rename();
    const [entry] = await h.controller.getHistory();
    const renamed = path.join(h.media, "Inception (2010).mkv");
    // Replace the renamed file with a different one.
    const { unlink } = await import("node:fs/promises");
    await unlink(renamed);
    await writeFile(renamed, "someone else's file");

    const outcome = await h.controller.undoEntry(entry!.timestamp);
    expect(outcome).toMatchObject({ kind: "done", undone: 0, kept: 1 });
    expect(outcome.kind === "done" && outcome.items[0]!.kept).toEqual([{ name: "Inception (2010).mkv", reason: "changed" }]);
    expect(await readFile(renamed, "utf8")).toBe("someone else's file");

    const gone = await h.controller.undoEntry(entry!.timestamp);
    expect(gone.kind).toBe("error");
  });
});
