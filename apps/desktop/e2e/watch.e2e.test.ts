/**
 * End-to-end: watch folders in both modes. Real files in a temporary folder
 * (never the user's own folders), fake providers, a temporary config, real
 * file-system events plus the e2e build's one-second rescans.
 *
 * Review: a new file is added to the list and fetched, nothing is renamed; a
 * download under a temporary name is left alone until it gets its final
 * name; files already there stay out; pausing holds new files back; a
 * notification is recorded when the window is in the background.
 * Automatic: a file with exactly one match is renamed (and is in History),
 * a file with several matches is added to the list for review instead.
 */

import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TidyTitlesE2eFeedback } from "../src/e2e/main";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");
const SHOTS = process.env.TIDYTITLES_SCREENSHOT_DIR ?? path.join(APP_DIR, "out-e2e", "screenshots");

let tmp: string;
let configDir: string;
let inbox: string;
let electronApp: ElectronApplication;
let page: Page;

const toml = (mode: "review" | "automatic") =>
  `[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n\n` +
  `[watch]\nenabled = true\nfolders = [${JSON.stringify(inbox)}]\nrecursive = true\nmode = "${mode}"\nsettle_seconds = 2\n`;

const rowFor = (name: string) => page.getByTestId("file-row").filter({ hasText: name });
const names = async () => (await readdir(inbox)).sort();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const feedback = () =>
  electronApp.evaluate(() => {
    const f = globalThis.__tidytitlesE2eFeedback as TidyTitlesE2eFeedback;
    return { notifications: [...f.notifications] };
  });

const setFocused = (focused: boolean) =>
  electronApp.evaluate((_electron, value) => {
    (globalThis.__tidytitlesE2eFeedback as TidyTitlesE2eFeedback).focused = value;
  }, focused);

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-watch-"));
  configDir = path.join(tmp, "config");
  inbox = path.join(tmp, "Downloads");
  for (const d of [configDir, inbox, SHOTS]) await mkdir(d, { recursive: true });
  await writeFile(path.join(configDir, "config.toml"), toml("review"));
  await writeFile(path.join(inbox, "Already.There.2001.mkv"), "OLD");

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

describe("watch folders: review mode", () => {
  it("shows that watching is on", async () => {
    await expect.poll(() => page.getByTestId("watch-headline").textContent()).toBe("Watching · Review");
  });

  it("adds a new file to the list and fetches it, renaming nothing; files already there stay out", async () => {
    await writeFile(path.join(inbox, "Inception.2010.720p.mkv"), "INCEPTION");
    await rowFor("Inception.2010.720p.mkv").waitFor({ timeout: 15_000 });
    await expect.poll(() => rowFor("Inception.2010.720p.mkv").textContent(), { timeout: 10_000 }).toContain("Inception (2010).mkv");
    await expect(page.getByTestId("file-row").count()).resolves.toBe(1);
    expect(await names()).toEqual(["Already.There.2001.mkv", "Inception.2010.720p.mkv"]);
    await shoot("watch-review");
  }, 30_000);

  it("leaves a download under a temporary name alone until it has its final name", async () => {
    const part = path.join(inbox, "Breaking.Bad.S01E01.720p.mkv.crdownload");
    await writeFile(part, "PARTIAL");
    await sleep(5_000);
    await expect(rowFor("Breaking.Bad").count()).resolves.toBe(0);
    await rename(part, path.join(inbox, "Breaking.Bad.S01E01.720p.mkv"));
    await expect.poll(() => rowFor("Breaking.Bad.S01E01.720p.mkv").textContent(), { timeout: 15_000 }).toContain("Pilot");
  }, 30_000);

  it("holds new files back while paused and takes them on resume", async () => {
    await page.getByTestId("watch-pause").click();
    await expect.poll(() => page.getByTestId("watch-headline").textContent()).toBe("Watching paused");
    await writeFile(path.join(inbox, "Inception.2010.1080p.mkv"), "INCEPTION-HD");
    await sleep(5_000);
    await expect(rowFor("Inception.2010.1080p.mkv").count()).resolves.toBe(0);

    await setFocused(false);
    await page.getByTestId("watch-pause").click();
    await rowFor("Inception.2010.1080p.mkv").waitFor({ timeout: 15_000 });
    // In the background: a notification says files are ready for review.
    await expect
      .poll(async () => (await feedback()).notifications.map((n) => n.title), { timeout: 10_000 })
      .toContain("New Files to Review");
    await setFocused(true);
  }, 40_000);

  it("can process the files that were already there", async () => {
    await page.getByTestId("watch-activity-open").click();
    const dialog = page.getByTestId("watch-activity");
    await dialog.waitFor();
    await dialog.getByTestId("watch-process-existing").click();
    await dialog.getByTestId("watch-note").waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();
    await rowFor("Already.There.2001.mkv").waitFor({ timeout: 15_000 });
  }, 30_000);
});

describe("watch folders: automatic mode", () => {
  it("is switched on in Settings → Watch", async () => {
    await page.getByTestId("clear").click();
    await page.getByTestId("settings").click();
    await page.getByTestId("settings-tab-watch").click();
    await expect(page.getByText(/no background service or login item/).count()).resolves.toBe(1);
    await page.getByTestId("watch-mode-automatic").check();
    await shoot("watch-settings");
    await page.getByTestId("settings-save").click();
    await expect.poll(() => page.getByTestId("watch-headline").textContent()).toBe("Watching · Automatic");
  });

  it("renames a file with one match, and lists a file with several matches for review", async () => {
    await writeFile(path.join(inbox, "Breaking.Bad.S01E02.720p.mkv"), "EP2");
    await writeFile(path.join(inbox, "The.Matrix.mkv"), "MATRIX");
    // The Matrix has three results: the review fetch asks which one.
    const selection = page.getByTestId("selection-dialog");
    await selection.waitFor({ timeout: 20_000 });
    await selection.getByTestId("selection-skip").click();
    await expect.poll(async () => (await names()).some((n) => n.startsWith("Breaking Bad - S01E02")), { timeout: 15_000 }).toBe(true);
    expect(await names()).toContain("The.Matrix.mkv");
    await rowFor("The.Matrix.mkv").waitFor();
    await expect(rowFor("Breaking Bad - S01E02").count()).resolves.toBe(0);

    await page.getByTestId("watch-activity-open").click();
    const dialog = page.getByTestId("watch-activity");
    const log = dialog.getByTestId("watch-log");
    await log.waitFor();
    await expect.poll(() => log.locator('[data-kind="renamed"]').count()).toBeGreaterThan(0);
    await expect(log.locator('[data-reason="several_matches"]').count()).resolves.toBe(1);
    await shoot("watch-activity");
    await dialog.getByRole("button", { name: "Done" }).click();

    // In the history, so it can be undone.
    await page.getByTestId("history").click();
    await expect.poll(() => page.getByTestId("history-entry").count()).toBeGreaterThan(0);
    await page.getByTestId("history-close").click();
  }, 60_000);
});
