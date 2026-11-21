/** AppController: `[write_metadata]` (tags into music files, NFO files) in rename, undo, and Settings. */

import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { readTags } from "@tidytitles/core";
import { afterEach, describe, expect, it } from "vitest";
import { toEditableSettings } from "../../src/main/controller";
import { KEYS_TOML, createHarness, type Harness } from "./helpers";

const FLAC = path.resolve(__dirname, "../../../../packages/core/tests/fixtures/audio/tagged.flac");

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const WRITE_TOML = `${KEYS_TOML}[write_metadata]\nmusic_tags = true\nnfo = true\n`;

describe("AppController: writing metadata", () => {
  it("writes tags and an NFO file, reports them per file, and undo reverses both", async () => {
    h = await createHarness(WRITE_TOML);
    const song = path.join(h.media, "Daft Punk - One More Time.flac");
    await copyFile(FLAC, song);
    await h.touch("Inception.2010.720p.mkv");
    expect(h.controller.getState().writeMetadata).toEqual({ musicTags: true, nfo: true });

    await h.controller.addPaths([h.media]);
    expect(await h.controller.fetch()).toMatchObject({ kind: "done" });
    const outcome = await h.controller.rename();
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") return;
    expect(outcome.metadata).toBeDefined();
    const files = outcome.metadata!.files;
    const flac = files.find((f) => f.name.endsWith(".flac"))!;
    expect(flac.tags).toMatchObject({ status: "written", format: "flac" });
    expect(flac.tags!.changes).toContainEqual({ field: "title", from: "Wrong Title", to: "One More Time" });
    const movie = files.find((f) => f.name === "Inception (2010).mkv")!;
    expect(movie.nfo).toEqual([{ kind: "movie", path: path.join(h.media, "Inception (2010).nfo"), status: "written" }]);

    const dest = h.controller.getState().operations!.find((o) => o.destination.endsWith(".flac"))!.destination;
    expect((await readTags(dest)).values.title).toBe("One More Time");

    const undo = await h.controller.undo();
    expect(undo.kind).toBe("done");
    if (undo.kind !== "done") return;
    expect(undo.items.find((i) => i.name.endsWith(".flac"))!.tags).toEqual({ status: "restored" });
    expect(undo.items.find((i) => i.name === "Inception (2010).mkv")!.createdFiles).toEqual([
      { name: "Inception (2010).nfo", kind: "movie", status: "removed" },
    ]);
    expect((await readFile(song)).equals(await readFile(FLAC))).toBe(true);
    expect(existsSync(path.join(h.media, "Inception (2010).nfo"))).toBe(false);
  });

  it("has no metadata report when both settings are off", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("Inception.2010.720p.mkv");
    await h.controller.addPaths([h.media]);
    await h.controller.fetch();
    const outcome = await h.controller.rename();
    expect(outcome.kind === "done" && outcome.metadata).toBeUndefined();
    expect(existsSync(path.join(h.media, "Inception (2010).nfo"))).toBe(false);
  });

  it("saves the settings from the Settings dialog", async () => {
    h = await createHarness(KEYS_TOML);
    const payload = await h.controller.getSettingsPayload();
    expect(payload.settings.writeMetadata).toEqual({ musicTags: false, nfo: false });
    const result = await h.controller.saveSettings({ ...payload.settings, writeMetadata: { musicTags: true, nfo: false } });
    expect(result).toEqual({ ok: true });
    expect(await readFile(h.config.configFile, "utf8")).toContain("[write_metadata]\nmusic_tags = true\nnfo = false");
    expect(h.controller.getState().writeMetadata).toEqual({ musicTags: true, nfo: false });
    expect(toEditableSettings(await h.config.load()).writeMetadata).toEqual({ musicTags: true, nfo: false });
  });
});
