/**
 * End-to-end: "Write metadata" in Settings, the rename confirmation and
 * result, a real FLAC file whose tags are rewritten by the main bundle, a
 * movie NFO, and undo putting the old tags back and removing the NFO.
 * Fake providers, a temporary config directory, real files on disk.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { readTags } from "@tidytitles/core";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");
const SHOTS = process.env.TIDYTITLES_SCREENSHOT_DIR ?? path.join(APP_DIR, "out-e2e", "screenshots");
const FLAC = path.resolve(APP_DIR, "../../packages/core/tests/fixtures/audio/tagged.flac");

let tmp: string;
let configDir: string;
let inbox: string;
let electronApp: ElectronApplication;
let page: Page;

const KEYS = '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n';
const SONG = "Daft Punk - One More Time.flac";

async function stubOpenDialog(paths: string[]) {
  await electronApp.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
  }, paths);
}

async function shoot(name: string) {
  for (const theme of ["light", "dark"] as const) {
    await electronApp.evaluate(({ nativeTheme }, t) => {
      nativeTheme.themeSource = t;
    }, theme);
    await page.waitForFunction((t) => window.matchMedia("(prefers-color-scheme: dark)").matches === (t === "dark"), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await electronApp.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "light";
  });
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-metadata-"));
  configDir = path.join(tmp, "config");
  inbox = path.join(tmp, "Inbox");
  for (const d of [configDir, inbox, SHOTS]) await mkdir(d, { recursive: true });
  await writeFile(path.join(configDir, "config.toml"), KEYS);
  await copyFile(FLAC, path.join(inbox, SONG));
  await writeFile(path.join(inbox, "Inception.2010.720p.WEB-DL.mkv"), "INCEPTION");

  electronApp = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [MAIN],
    cwd: APP_DIR,
    colorScheme: null,
    env: { ...process.env, TIDYTITLES_E2E: "1", TIDYTITLES_CONFIG_DIR: configDir, ELECTRON_RUN_AS_NODE: "" },
  });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(1180, 720);
    win.center();
  });
  await page.waitForSelector(".app:not(.app-loading)");
}, 60_000);

afterAll(async () => {
  await electronApp?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("writing tags and NFO files", () => {
  it("turns both on in Settings", async () => {
    await page.getByTestId("settings").click();
    const dialog = page.getByTestId("settings-dialog");
    await dialog.getByTestId("template-movie").waitFor();
    await dialog.getByTestId("settings-tab-files").click();
    await dialog.getByTestId("write-music-tags").check();
    await dialog.getByTestId("write-nfo").check();
    await dialog.getByTestId("write-metadata-settings").scrollIntoViewIfNeeded();
    await shoot("40-settings-write-metadata");
    await dialog.getByTestId("settings-save").click();
    await dialog.waitFor({ state: "detached" });
    expect(await readFile(path.join(configDir, "config.toml"), "utf8")).toContain("[write_metadata]\nmusic_tags = true\nnfo = true");
  });

  it("says in the confirmation what will be written", async () => {
    await stubOpenDialog([inbox]);
    await page.getByTestId("add-folder").click();
    await page.getByTestId("file-row").nth(1).waitFor();
    await page.getByTestId("fetch").click();
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    await page.getByTestId("rename").click();
    const confirm = page.getByTestId("confirm-rename");
    await confirm.waitFor();
    const note = await confirm.getByTestId("confirm-metadata").textContent();
    expect(note).toContain("Tags from MusicBrainz matches will be written into the 1 music file where they differ.");
    expect(note).toContain("NFO files will be written for 1 video.");
    await shoot("41-confirm-write-metadata");
  });

  it("writes the tags into the FLAC file and the NFO, and lists them in the result", async () => {
    await page.getByTestId("confirm-rename").getByTestId("confirm").click();
    const result = page.getByTestId("rename-result");
    await result.waitFor();
    await expect(result.getByTestId("tags-written").textContent()).resolves.toBe("1");
    await expect(result.getByTestId("nfo-written").textContent()).resolves.toBe("1");
    await expect(result.getByTestId("metadata-details").textContent()).resolves.toContain("title “Wrong Title” → “One More Time”");
    await shoot("42-result-write-metadata");
    await result.getByTestId("ok").click();

    const song = path.join(inbox, "Daft Punk", "Discovery (2001)", "01 - One More Time.flac");
    const tags = await readTags(song);
    expect(tags.values).toMatchObject({ title: "One More Time", artist: "Daft Punk", album: "Discovery", year: 2001 });
    const nfo = await readFile(path.join(inbox, "Inception (2010).nfo"), "utf8");
    expect(nfo).toContain("<title>Inception</title>");
    expect(nfo).toContain('<uniqueid type="tmdb" default="true">27205</uniqueid>');
  });

  it("undo puts the old tags back and removes the NFO", async () => {
    await page.getByTestId("undo").click();
    await page.getByTestId("confirm-undo").getByTestId("confirm").click();
    const result = page.getByTestId("undo-result");
    await result.waitFor();
    const text = await result.getByTestId("undo-metadata").textContent();
    expect(text).toContain("Tags put back1");
    expect(text).toContain("NFO files removed1");
    await result.getByTestId("ok").click();

    expect((await readFile(path.join(inbox, SONG))).equals(await readFile(FLAC))).toBe(true);
    expect(existsSync(path.join(inbox, "Inception (2010).nfo"))).toBe(false);
    expect((await readdir(inbox)).filter((n) => !n.startsWith(".")).sort()).toEqual(
      ["Daft Punk", "Inception.2010.720p.WEB-DL.mkv", SONG].sort(),
    );
  });
});
