import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "@tidytitles/core";
import { createConfigService } from "../../src/main/configDir";
import { toEditableSettings } from "../../src/main/controller";
import { EVENTS, type AppState } from "../../src/shared/ipc";
import { KEYS_TOML, createHarness, type Harness } from "./helpers";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const lastState = (harness: Harness): AppState =>
  harness.events.filter((e) => e.channel === EVENTS.state).at(-1)!.payload as AppState;

describe("AppController: state and files", () => {
  it("starts with defaults and offers only MusicBrainz without keys", async () => {
    h = await createHarness();
    const state = h.controller.getState();
    expect(state.files).toEqual([]);
    expect(state.plan).toBe("none");
    expect(state.providerChoices).toEqual(["musicbrainz"]);
    expect(state.options.provider).toBe("musicbrainz");
    expect(state.apiKeys).toEqual({ tmdb: false, tvdb: false });
    expect(state.lastRename).toBeNull();
    expect(state.configError).toBeNull();
    expect(lastState(h)).toEqual(state);
  });

  it("offers Auto and the keyed providers when keys are set", async () => {
    h = await createHarness(KEYS_TOML);
    expect(h.controller.getState().providerChoices).toEqual(["auto", "tmdb", "tvdb", "musicbrainz"]);
    expect(h.controller.getState().options.provider).toBe("auto");
  });

  it("reports an unreadable config instead of throwing", async () => {
    h = await createHarness("[behavior]\ndry_run = [not valid");
    const state = h.controller.getState();
    expect(state.configError).toMatch(/Could not parse/);
    expect(state.status.tone).toBe("error");
    await h.touch("Inception.2010.mkv");
    await h.controller.addPaths([h.media]);
    expect((await h.controller.fetch()).kind).toBe("error");
  });

  it("adds folders recursively, skips non-media, de-duplicates, and sorts by name", async () => {
    h = await createHarness(KEYS_TOML);
    h.controller.setOptions({ recursive: true });
    await h.touch("b/Zodiac.2007.mkv");
    await h.touch("Alien.1979.mkv");
    await h.touch("notes.txt");
    await h.touch("music/Queen - Bohemian Rhapsody.mp3");
    const first = await h.controller.addPaths([h.media]);
    expect(first).toEqual({ added: 3, total: 3 });
    const again = await h.controller.addPaths([h.media, path.join(h.media, "Alien.1979.mkv")]);
    expect(again.added).toBe(0);
    const files = h.controller.getState().files;
    expect(files.map((f) => f.name)).toEqual(["Alien.1979.mkv", "Queen - Bohemian Rhapsody.mp3", "Zodiac.2007.mkv"]);
    expect(files.map((f) => f.kind)).toEqual(["video", "audio", "video"]);
    expect(new Set(files.map((f) => f.id)).size).toBe(3);
  });

  it("does not scan subfolders when recursion is off", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("Alien.1979.mkv");
    await h.touch("sub/Zodiac.2007.mkv");
    expect(h.controller.getState().options.recursive).toBe(false);
    await h.controller.addPaths([h.media]);
    expect(h.controller.getState().files.map((f) => f.name)).toEqual(["Alien.1979.mkv"]);
  });

  it("filters dropped files by extension but keeps files picked in the dialog", async () => {
    h = await createHarness(KEYS_TOML);
    const txt = await h.touch("readme.txt");
    expect((await h.controller.addPaths([txt])).added).toBe(0);
    expect(h.controller.getState().status.tone).toBe("warning");
    expect((await h.controller.addPaths([txt], { filterExplicitFiles: false })).added).toBe(1);
  });

  it("removes and clears files, dropping the plan", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("Inception.2010.mkv");
    await h.touch("Unknown.Film.2021.mkv");
    await h.controller.addPaths([h.media]);
    await h.controller.fetch();
    expect(h.controller.getState().plan).toBe("planned");
    const [first] = h.controller.getState().files;
    h.controller.removeFiles([first!.id]);
    expect(h.controller.getState().files).toHaveLength(1);
    expect(h.controller.getState().plan).toBe("none");
    h.controller.clearFiles();
    expect(h.controller.getState().files).toEqual([]);
  });

  it("drops the plan when the media type or provider changes", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("Inception.2010.mkv");
    await h.controller.addPaths([h.media]);
    await h.controller.fetch();
    h.controller.setOptions({ coverArt: true });
    expect(h.controller.getState().plan).toBe("planned");
    h.controller.setOptions({ mediaType: "movie" });
    expect(h.controller.getState().plan).toBe("none");
  });
});

describe("AppController: fetch", () => {
  it("plans operations with statuses from the providers", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("Inception.2010.720p.mkv");
    await h.touch("Breaking.Bad.S01E01.720p.mkv");
    await h.touch("Broken.Show.S02E03.mkv");
    await h.touch("Unknown.Film.2021.mkv");
    await h.touch("Queen - Bohemian Rhapsody.mp3");
    await h.touch("03 - Basement Tapes - Demo.mp3");
    await h.touch("Daft Punk - One More Time.flac");
    await h.controller.addPaths([h.media]);

    const outcome = await h.controller.fetch();
    expect(outcome.kind).toBe("done");
    const state = h.controller.getState();
    expect(state.plan).toBe("planned");
    const byName = Object.fromEntries(
      state.operations!.map((op) => [path.basename(op.source), op]),
    );
    expect(byName["Inception.2010.720p.mkv"]!.mediaFile.matchedMetadata?.verificationStatus).toBe("auto_matched");
    expect(path.basename(byName["Inception.2010.720p.mkv"]!.destination)).toBe("Inception (2010).mkv");
    expect(byName["Breaking.Bad.S01E01.720p.mkv"]!.mediaFile.matchedMetadata?.verificationStatus).toBe("auto_matched");
    expect(byName["Broken.Show.S02E03.mkv"]!.skipReason).toBe("lookup_failed");
    expect(byName["Broken.Show.S02E03.mkv"]!.lookupError?.kind).toBe("provider");
    expect(byName["Unknown.Film.2021.mkv"]!.skipReason).toBe("no_match");
    expect(byName["Queen - Bohemian Rhapsody.mp3"]!.mediaFile.matchedMetadata?.verificationStatus).toBe("verified");
    expect(byName["03 - Basement Tapes - Demo.mp3"]!.mediaFile.matchedMetadata?.verificationStatus).toBe("unverified");
    expect(byName["Daft Punk - One More Time.flac"]!.mediaFile.matchedMetadata?.verificationStatus).toBe("from_provider");
    // Operations are index-aligned with the files.
    expect(state.operations!.map((op) => op.source)).toEqual(state.files.map((f) => f.path));
    // Progress was reported, then cleared.
    const progress = h.events.filter((e) => e.channel === EVENTS.progress).map((e) => e.payload);
    expect(progress.some((p) => p && (p as { phase: string }).phase === "fetch")).toBe(true);
    expect(progress.at(-1)).toBeNull();
  });

  it("asks the renderer to choose among several matches and uses the answer", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("The.Matrix.1999.mkv");
    await h.controller.addPaths([h.media]);
    const request = h.next(EVENTS.selectionRequest);
    const fetching = h.controller.fetch();
    const req = await request;
    expect(req.kind).toBe("movie");
    expect(req.filename).toBe("The.Matrix.1999.mkv");
    expect(req.options).toHaveLength(3);
    expect(h.controller.getState().busy).toBe("fetching");
    expect((await h.controller.fetch()).kind).toBe("busy");

    h.controller.answerSelection(req.id, 2);
    expect((await fetching).kind).toBe("done");
    const op = h.controller.getState().operations![0]!;
    expect(op.mediaFile.matchedMetadata?.verificationStatus).toBe("manual_selection");
    expect(path.basename(op.destination)).toBe("The Matrix Resurrections (2021).mkv");
  });

  it("skips the file when the selection is closed (null) or out of range", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("The.Matrix.1999.mkv");
    await h.controller.addPaths([h.media]);
    let request = h.next(EVENTS.selectionRequest);
    let fetching = h.controller.fetch();
    h.controller.answerSelection((await request).id, null);
    await fetching;
    expect(h.controller.getState().operations![0]!.skipReason).toBe("no_match");

    request = h.next(EVENTS.selectionRequest);
    fetching = h.controller.fetch();
    h.controller.answerSelection((await request).id, 99);
    await fetching;
    expect(h.controller.getState().operations![0]!.skipReason).toBe("no_match");
  });

  it("ignores answers to unknown or stale ids", async () => {
    h = await createHarness(KEYS_TOML);
    expect(() => h.controller.answerSelection("nope", 0)).not.toThrow();
  });

  it("cancels the fetch at an open selection and withdraws it", async () => {
    h = await createHarness(KEYS_TOML);
    await h.touch("Inception.2010.mkv");
    await h.touch("The.Matrix.1999.mkv");
    await h.controller.addPaths([h.media]);
    const request = h.next(EVENTS.selectionRequest);
    const closed = h.next(EVENTS.selectionClosed);
    const fetching = h.controller.fetch();
    const req = await request;
    h.controller.cancelFetch();
    expect((await closed).id).toBe(req.id);
    expect((await fetching).kind).toBe("canceled");
    const state = h.controller.getState();
    expect(state.plan).toBe("none");
    expect(state.operations).toBeNull();
    expect(state.busy).toBeNull();
    expect(state.status.text).toBe("Fetch canceled");
    // A late answer is harmless.
    h.controller.answerSelection(req.id, 0);
  });

  it("returns empty when there is nothing to fetch", async () => {
    h = await createHarness(KEYS_TOML);
    expect((await h.controller.fetch()).kind).toBe("empty");
  });
});

describe("AppController: rename and undo", () => {
  async function planned(harness: Harness) {
    await harness.touch("Inception.2010.720p.mkv");
    await harness.touch("Inception.2010.720p.en.srt");
    await harness.touch("Unknown.Film.2021.mkv");
    await harness.touch("Queen - Bohemian Rhapsody.mp3");
    harness.controller.setOptions({ recursive: true });
    await harness.controller.addPaths([harness.media]);
    await harness.controller.fetch();
  }

  it("renames from main's own plan, saves history, and updates the list", async () => {
    h = await createHarness(KEYS_TOML);
    await planned(h);
    const outcome = await h.controller.rename();
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") return;
    expect(outcome.summary.completed).toBe(2);
    expect(outcome.summary.skipped).toBe(1);
    expect(outcome.associatedRenamed).toBe(1);
    expect(outcome.historySaved).toBe(2);
    expect(outcome.coverArtAttempted).toBe(false);

    expect(existsSync(path.join(h.media, "Inception (2010).mkv"))).toBe(true);
    expect(existsSync(path.join(h.media, "Inception (2010).en.srt"))).toBe(true);
    expect(existsSync(path.join(h.media, "Queen/A Night at the Opera (1975)/11 - Bohemian Rhapsody.mp3"))).toBe(true);
    expect(existsSync(path.join(h.media, "Unknown.Film.2021.mkv"))).toBe(true);

    const state = h.controller.getState();
    expect(state.plan).toBe("renamed");
    expect(state.files.map((f) => f.name)).toContain("Inception (2010).mkv");
    expect(state.lastRename).toMatchObject({ operations: 2, files: 3 });
    // Nothing left to rename until the next fetch.
    expect((await h.controller.rename()).kind).toBe("nothing");
  });

  it("downloads cover art through the session's fetch when enabled", async () => {
    h = await createHarness(KEYS_TOML);
    await planned(h);
    h.controller.setOptions({ coverArt: true });
    const outcome = await h.controller.rename();
    expect(outcome.kind === "done" && outcome.coverArtDownloaded).toBeGreaterThan(0);
    expect(existsSync(path.join(h.media, "poster.jpg"))).toBe(true);
  });

  it("undoes the last rename from history and restores the list", async () => {
    h = await createHarness(KEYS_TOML);
    await planned(h);
    await h.controller.rename();
    const outcome = await h.controller.undo();
    expect(outcome).toMatchObject({ kind: "done", historyFound: true, undone: 2, failed: 0 });
    expect(existsSync(path.join(h.media, "Inception.2010.720p.mkv"))).toBe(true);
    expect(existsSync(path.join(h.media, "Inception.2010.720p.en.srt"))).toBe(true);
    expect(existsSync(path.join(h.media, "Queen - Bohemian Rhapsody.mp3"))).toBe(true);
    const state = h.controller.getState();
    expect(state.files.map((f) => f.name)).toContain("Inception.2010.720p.mkv");
    expect(state.plan).toBe("none");
    expect(state.lastRename).toBeNull();
    expect(await h.controller.undo()).toMatchObject({ kind: "done", historyFound: false });
  });

  it("does not undo a newer rename recorded elsewhere than the one it showed", async () => {
    h = await createHarness(KEYS_TOML);
    await planned(h);
    await h.controller.rename();
    const shown = h.controller.getState().lastRename;
    // The CLI records another rename while the app shows the old one.
    await new Promise((r) => setTimeout(r, 5));
    const cliFile = await h.touch("Renamed By CLI.mkv");
    const cli = new ConfigService({ configDir: h.config.configDir, cacheDir: h.config.cacheDir, env: {} });
    await cli.saveHistory([{ source: path.join(h.media, "cli.old.mkv"), destination: cliFile, associatedFiles: [] }]);

    const outcome = await h.controller.undo();
    expect(outcome.kind).toBe("error");
    expect(existsSync(cliFile)).toBe(true);
    expect(existsSync(path.join(h.media, "Inception (2010).mkv"))).toBe(true);
    // The app now shows the entry an undo would reverse.
    expect(h.controller.getState().lastRename).not.toEqual(shown);
    expect(h.controller.getState().lastRename).toMatchObject({ operations: 1, files: 1 });
  });

  it("refuses to rename without a plan", async () => {
    h = await createHarness(KEYS_TOML);
    expect((await h.controller.rename()).kind).toBe("nothing");
  });
});

describe("AppController: settings", () => {
  it("returns the editable settings with keys, previews, and the field reference", async () => {
    h = await createHarness(KEYS_TOML);
    const payload = await h.controller.getSettingsPayload();
    expect(payload.settings.api.tmdbApiKey).toBe("k");
    expect(payload.preview.movie.preview).toBe("The Matrix (1999).mkv");
    expect(payload.fields.episode_title).toBeTruthy();
    expect(payload.loadError).toBeNull();
  });

  it("offers the metadata languages and what each TV service can do with each order", async () => {
    h = await createHarness(`${KEYS_TOML}\n[metadata]\nlanguage = "de-AT"\n`);
    const payload = await h.controller.getSettingsPayload();
    expect(payload.settings.tv).toEqual({ episodeOrder: "aired" });
    expect(payload.settings.metadata).toEqual({ language: "de-AT" });
    expect(payload.metadataLanguages[0]).toEqual({ code: "en-US", name: "English" });
    // A code from config.toml that is not in the list is offered, so saving keeps it.
    expect(payload.metadataLanguages.at(-1)).toEqual({ code: "de-AT", name: "de-AT" });
    expect(payload.episodeOrderNotes.tmdb.dvd.partial).toBe(true);
    expect(payload.episodeOrderNotes.tvdb.dvd.partial).toBe(false);
  });

  it("saves the episode order and metadata language", async () => {
    h = await createHarness(KEYS_TOML);
    const edited = toEditableSettings(await h.config.getSettings());
    edited.tv.episodeOrder = "absolute";
    edited.metadata.language = "ja-JP";
    expect(await h.controller.saveSettings(edited)).toEqual({ ok: true });
    const toml = await readFile(h.config.configFile, "utf8");
    expect(toml).toContain('[tv]\nepisode_order = "absolute"');
    expect(toml).toContain('[metadata]\nlanguage = "ja-JP"');
    expect((await h.config.load()).metadata.language).toBe("ja-JP");
  });

  it("rejects invalid templates without saving", async () => {
    h = await createHarness(KEYS_TOML);
    const edited = toEditableSettings(await h.config.getSettings());
    edited.templates.movie = "{title} {nope}";
    const result = await h.controller.saveSettings(edited);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.templateErrors?.movie).toEqual(["Unknown field: {nope}"]);
    expect(await readFile(h.config.configFile, "utf8")).toBe(KEYS_TOML);
  });

  it("saves, trims keys, keeps settings the dialog does not edit, and drops a plan", async () => {
    h = await createHarness('[behavior]\ndry_run = true\n[providers]\nmovie = "tmdb"\n');
    await h.touch("Inception.2010.mkv");
    await h.controller.addPaths([h.media]);
    await h.controller.fetch();
    const edited = toEditableSettings(await h.config.getSettings());
    edited.templates.movie = "{title} [{year}]";
    edited.api.tmdbApiKey = "  new-key  ";
    edited.conflictResolution = "auto_version";
    edited.coverArt.enabled = true;
    expect(await h.controller.saveSettings(edited)).toEqual({ ok: true });

    const toml = await readFile(h.config.configFile, "utf8");
    expect(toml).toContain('movie = "{title} [{year}]"');
    expect(toml).toContain('tmdb_api_key = "new-key"');
    expect(toml).toContain('conflict_resolution = "auto_version"');
    expect(toml).toContain("dry_run = true");
    const state = h.controller.getState();
    expect(state.plan).toBe("none");
    expect(state.options.coverArt).toBe(true);
    expect(state.apiKeys.tmdb).toBe(true);
  });

  it("previews templates through the core engine", async () => {
    h = await createHarness();
    const preview = h.controller.previewTemplates({
      movie: "{title|upper} ({year})",
      tv: "{title}/Season {season}/{title} S{season2}E{episode2}",
      music: "{artist} - {title} {",
    });
    expect(preview.movie).toEqual({ preview: "THE MATRIX (1999).mkv", errors: [] });
    expect(preview.tv.preview).toBe("Breaking Bad/Season 1/Breaking Bad S01E01.mkv");
    expect(preview.music.errors).toEqual(["Mismatched braces in template"]);
  });
});

describe("createConfigService", () => {
  it("uses TIDYTITLES_CONFIG_DIR with a cache subdirectory", async () => {
    h = await createHarness();
    const config = createConfigService({ TIDYTITLES_CONFIG_DIR: h.dir });
    expect(config.configDir).toBe(h.dir);
    expect(config.cacheDir).toBe(path.join(h.dir, "cache"));
    expect(config.configFile).toBe(path.join(h.dir, "config.toml"));
    await writeFile(config.configFile, KEYS_TOML);
    expect((await config.load()).api.tmdbApiKey).toBe("k");
  });

  it("falls back to the platform directory when unset or blank", () => {
    const config = createConfigService({ TIDYTITLES_CONFIG_DIR: "  " });
    expect(config.configDir).toMatch(/file-renamer$/);
  });
});
