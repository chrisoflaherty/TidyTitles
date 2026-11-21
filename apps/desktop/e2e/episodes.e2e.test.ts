/**
 * End-to-end: a multi-episode file gets one name for both episodes, and the
 * episode order and metadata language are chosen in Settings and saved to
 * config.toml. Real built app (`out-e2e/`), fake providers, no network, a
 * temporary config directory.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");
const SHOTS = process.env.TIDYTITLES_SCREENSHOT_DIR ?? path.join(APP_DIR, "out-e2e", "screenshots");

let tmp: string;
let configDir: string;
let mediaDir: string;
let electronApp: ElectronApplication;
let page: Page;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-episodes-"));
  configDir = path.join(tmp, "config");
  mediaDir = path.join(tmp, "Shows");
  await mkdir(configDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  // Only a TMDB key, so TV lookups (and the order notes) are TMDB's.
  await writeFile(path.join(configDir, "config.toml"), '[api]\ntmdb_api_key = "e2e-not-a-real-key"\n');
  await writeFile(path.join(mediaDir, "Breaking.Bad.S01E01E02.720p.HDTV.mkv"), "");

  electronApp = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [MAIN],
    cwd: APP_DIR,
    colorScheme: null,
    env: { ...process.env, TIDYTITLES_E2E: "1", TIDYTITLES_CONFIG_DIR: configDir, ELECTRON_RUN_AS_NODE: "" },
  });
  page = await electronApp.firstWindow();
  await page.waitForSelector(".app:not(.app-loading)");
}, 60_000);

afterAll(async () => {
  await electronApp?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("episodes", () => {
  it("names a two-episode file with both episodes", async () => {
    await electronApp.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
    }, [mediaDir]);
    await page.getByTestId("add-folder").click();
    await page.getByTestId("file-row").first().waitFor();
    await page.getByTestId("fetch").click();
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    const row = page.getByTestId("file-row").first();
    await row.filter({ hasText: "Breaking Bad - S01E01-E02 - Pilot & Cat's in the Bag....mkv" }).waitFor();
  });

  it("chooses the episode order and metadata language in Settings", async () => {
    await page.getByTestId("settings").click();
    const dialog = page.getByTestId("settings-dialog");
    await dialog.getByTestId("settings-tab-providers").click();
    const order = dialog.getByTestId("episode-order");
    await expect(order.locator("option").allTextContents()).resolves.toEqual([
      "Aired",
      "DVD (only some shows on TMDB)",
      "Absolute",
    ]);
    await order.selectOption("dvd");
    await dialog.getByTestId("episode-order-hint").filter({ hasText: "DVD episode group" }).waitFor();
    await dialog.getByTestId("metadata-language").selectOption({ label: "German" });
    await page.screenshot({ path: path.join(SHOTS, "06-settings-episodes-language.png") });

    await dialog.getByTestId("settings-save").click();
    await dialog.waitFor({ state: "detached" });
    const toml = await readFile(path.join(configDir, "config.toml"), "utf8");
    expect(toml).toContain('[tv]\nepisode_order = "dvd"');
    expect(toml).toContain('[metadata]\nlanguage = "de-DE"');

    // Reopening shows what was saved.
    await page.getByTestId("settings").click();
    await dialog.getByTestId("settings-tab-providers").click();
    await expect(dialog.getByTestId("episode-order").inputValue()).resolves.toBe("dvd");
    await expect(dialog.getByTestId("metadata-language").inputValue()).resolves.toBe("de-DE");
  });
});
