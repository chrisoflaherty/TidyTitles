/**
 * Smoke test of the packaged app (`npm run package` first): it starts, its
 * window loads, and core works inside the asar: config.toml is parsed
 * (smol-toml) and validated (zod), templates render, and music-metadata
 * reads ID3 tags from a real file. No network: the only file is music and
 * the provider is TMDB, so the music lookup uses a null provider.
 *
 * The tag writer is checked inside both shipped bundles: core (from source)
 * renames a FLAC file with `[write_metadata] music_tags` and records it, and
 * the packaged app's Undo, then the packaged CLI bundle's `undo`, must put
 * the file back byte for byte (which rewrites its tags).
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigService,
  RenameSession,
  createArtist,
  createRenameOperation,
  createTrack,
  parseSettings,
} from "@tidytitles/core";
import type { TidyTitlesApi } from "../src/shared/ipc";

const FLAC = path.resolve(import.meta.dirname, "../../../packages/core/tests/fixtures/audio/tagged.flac");

/** Rename `source` with tag writing on (core from source) and record it in `configDir`'s history. */
async function taggedRename(configDir: string, source: string): Promise<void> {
  const config = new ConfigService({ configDir, cacheDir: path.join(configDir, "cache"), env: {} });
  const settings = parseSettings(await readFile(config.configFile, "utf8"));
  settings.writeMetadata.musicTags = true;
  const session = new RenameSession(settings, { config, requireApiKeys: false, cache: false });
  const ops = [
    createRenameOperation({
      source,
      destination: path.join(path.dirname(source), "Renamed.flac"),
      mediaFile: {
        path: source,
        parsedInfo: { title: "x", mediaType: "music", rawFilename: path.basename(source) },
        matchedMetadata: createTrack({ id: "rec-1", title: "Packaged Title", artist: createArtist({ id: "a", name: "Packaged Artist" }) }),
      },
    }),
  ];
  await session.execute(ops);
  await session.saveHistory(ops);
  if (ops[0]!.metadataWrites?.tags?.status !== "written") throw new Error("tags were not written");
}

declare global {
  interface Window {
    readonly tidytitles: TidyTitlesApi;
  }
}

const APP_DIR = path.resolve(import.meta.dirname, "..");
const EXECUTABLE =
  process.env.TIDYTITLES_PACKAGED_APP ??
  path.join(APP_DIR, "release", `mac-${process.arch}`, "TidyTitles.app", "Contents", "MacOS", "TidyTitles");

/** A minimal MP3: an ID3v2.3 tag (title, artist) followed by silent MPEG frames. */
function taggedMp3(title: string, artist: string): Buffer {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, "utf8")]); // UTF-8 encoding byte
    const header = Buffer.alloc(10);
    header.write(id, 0, "latin1");
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const frames = Buffer.concat([frame("TIT2", title), frame("TPE1", artist)]);
  const size = frames.length;
  const syncsafe = Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const id3 = Buffer.concat([Buffer.from("ID3"), Buffer.from([0x03, 0x00, 0x00]), syncsafe, frames]);
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz frames (417 bytes each).
  const mpegFrame = Buffer.alloc(417);
  mpegFrame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat([id3, ...Array.from({ length: 8 }, () => mpegFrame)]);
}

let app: ElectronApplication | undefined;
let tmp: string | undefined;
afterAll(async () => {
  await app?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!existsSync(EXECUTABLE))("packaged app", () => {
  it("starts and runs core inside the package", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-packaged-"));
    const configDir = path.join(tmp, "config");
    const media = path.join(tmp, "media");
    await mkdir(configDir, { recursive: true });
    await mkdir(media, { recursive: true });
    await writeFile(
      path.join(configDir, "config.toml"),
      '[templates]\nmusic = "{artist} - {title}"\n\n[api]\ntmdb_api_key = "packaged-test-not-a-key"\n\n[behavior]\nconflict_resolution = "auto_version"\n',
    );
    await writeFile(path.join(media, "track01.mp3"), taggedMp3("Packaged Song", "TidyTitles Band"));

    app = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      colorScheme: null,
      // No update checks: a test never contacts the network.
      env: { ...process.env, TIDYTITLES_CONFIG_DIR: configDir, TIDYTITLES_DISABLE_UPDATES: "1", ELECTRON_RUN_AS_NODE: "" },
    });
    const page = await app.firstWindow();
    await page.waitForSelector(".app:not(.app-loading)");
    expect(await app.evaluate(({ app: a }) => [a.isPackaged, a.getName()])).toEqual([true, "TidyTitles"]);

    const result = await page.evaluate(async (dir) => {
      const api = window.tidytitles;
      const settings = await api.getSettings();
      await api.setOptions({ provider: "tmdb", mediaType: "music" });
      await api.addPaths([dir]);
      const fetched = await api.fetch();
      const state = await api.getState();
      return { settings, fetched, state };
    }, media);

    // smol-toml + zod: values from config.toml.
    expect(result.settings.loadError).toBeNull();
    expect(result.settings.settings.conflictResolution).toBe("auto_version");
    expect(result.settings.settings.api.tmdbApiKey).toBe("packaged-test-not-a-key");
    // Template engine.
    expect(result.settings.preview.music.preview).toBe("Pink Floyd - Comfortably Numb.flac");
    // music-metadata read the ID3 tags.
    expect(result.fetched.kind).toBe("done");
    const op = result.state.operations![0]!;
    expect(op.mediaFile.parsedMusicInfo).toMatchObject({ source: "tags", title: "Packaged Song", artist: "TidyTitles Band" });
    expect(op.destination.endsWith("TidyTitles Band - Packaged Song.mp3")).toBe(true);
    // The CLI bundle is packaged, so the menu item is enabled.
    const cliEnabled = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("installCli")?.enabled);
    expect(cliEnabled).toBe(true);
    // The bundled updater is wired up, and off because of TIDYTITLES_DISABLE_UPDATES.
    const updates = await page.evaluate(() => window.tidytitles.getUpdateState());
    expect(updates.capability).toEqual({ kind: "off", reason: "disabled" });
    const updatesItem = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("checkForUpdates")?.label);
    expect(updatesItem).toBe("Check for Updates…");

    // Tag writer in the main bundle: Undo restores the tags core wrote.
    const music = path.join(tmp, "music");
    await mkdir(music, { recursive: true });
    const song = path.join(music, "song.flac");
    await copyFile(FLAC, song);
    await taggedRename(configDir, song);
    const undone = await page.evaluate(() => window.tidytitles.undo());
    expect(undone).toMatchObject({ kind: "done", undone: 1 });
    expect(undone.kind === "done" && undone.items[0]!.tags).toEqual({ status: "restored" });
    expect((await readFile(song)).equals(await readFile(FLAC))).toBe(true);
    await app.close();
    app = undefined;

    // Tag writer in the packaged CLI bundle, run with the app's own executable.
    const cli =
      process.platform === "darwin"
        ? path.resolve(EXECUTABLE, "../../Resources/cli/tidytitles.mjs")
        : path.resolve(path.dirname(EXECUTABLE), "resources", "cli", "tidytitles.mjs");
    await taggedRename(configDir, song);
    execFileSync(EXECUTABLE, [cli, "undo", "-y", "--config-dir", configDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
    });
    expect((await readFile(song)).equals(await readFile(FLAC))).toBe(true);
  }, 60_000);
});
