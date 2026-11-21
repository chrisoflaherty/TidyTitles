/**
 * End-to-end: output folders chosen in Settings, copy mode, the destination
 * shown in the main window, the Rename History dialog undoing an older
 * entry, and a missing output folder stopping a run before anything moves.
 * Real files on disk, fake providers, a temporary config directory.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
let inbox: string;
let moviesDir: string;
let showsInbox: string;
let electronApp: ElectronApplication;
let page: Page;

const KEYS = '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n';

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

const rowFor = (name: string) => page.getByTestId("file-row").filter({ hasText: name });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-output-"));
  configDir = path.join(tmp, "config");
  inbox = path.join(tmp, "Inbox");
  moviesDir = path.join(tmp, "Library", "Movies");
  showsInbox = path.join(tmp, "Shows Inbox");
  for (const d of [configDir, inbox, moviesDir, showsInbox, SHOTS]) await mkdir(d, { recursive: true });
  await writeFile(path.join(configDir, "config.toml"), KEYS);
  await writeFile(path.join(inbox, "Inception.2010.720p.WEB-DL.mkv"), "INCEPTION");
  await writeFile(path.join(inbox, "Inception.2010.720p.WEB-DL.en.srt"), "SUBS");
  await writeFile(path.join(inbox, "Breaking.Bad.S01E01.720p.HDTV.x264.mkv"), "PILOT");
  await writeFile(path.join(showsInbox, "Breaking.Bad.S01E01.1080p.mkv"), "PILOT-HD");

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

describe("output folders, copy mode, and history", () => {
  it("says files stay in their folders until an output folder is set", async () => {
    await expect(page.getByTestId("output-chip").textContent()).resolves.toContain("Same folders");
    await expect(page.getByTestId("transfer-mode").inputValue()).resolves.toBe("move");
  });

  it("sets a movie output folder and copy mode in Settings (from the Output button)", async () => {
    await page.getByTestId("output-chip").click();
    const dialog = page.getByTestId("settings-dialog");
    await dialog.getByTestId("output-movie").waitFor();
    await stubOpenDialog([moviesDir]);
    await dialog.getByTestId("output-movie-choose").click();
    await expect.poll(() => dialog.getByTestId("output-movie").inputValue()).toBe(moviesDir);
    await dialog.getByTestId("transfer-copy").check();
    await dialog.getByTestId("history-limit").fill("50");
    await shoot("20-settings-output");
    await dialog.getByTestId("settings-save").click();
    await dialog.waitFor({ state: "detached" });

    const toml = await readFile(path.join(configDir, "config.toml"), "utf8");
    expect(toml).toContain(`[output]\nmovie = ${JSON.stringify(moviesDir)}`);
    expect(toml).toContain('transfer_mode = "copy"');
    expect(toml).toContain("max_entries = 50");
    await expect(page.getByTestId("output-chip").textContent()).resolves.toContain("Movies → Movies");
    await expect(page.getByTestId("transfer-mode").inputValue()).resolves.toBe("copy");
  });

  it("shows where each file goes before renaming", async () => {
    await stubOpenDialog([inbox]);
    await page.getByTestId("add-folder").click();
    await page.getByTestId("file-row").nth(1).waitFor();
    await page.getByTestId("fetch").click();
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();

    const inception = rowFor("Inception.2010");
    await expect(inception.getByTestId("dest-elsewhere").textContent()).resolves.toContain("Movies/Inception (2010).mkv");
    await expect(rowFor("Breaking.Bad").getByTestId("dest-elsewhere").count()).resolves.toBe(0);
    await expect(page.locator(".assoc-row").textContent()).resolves.toContain("Copied with the file");
    await expect(page.getByTestId("rename").textContent()).resolves.toBe("Copy 2");
    await shoot("21-destination-in-table");
  });

  it("copies into the output folder and leaves the originals", async () => {
    await page.getByTestId("rename").click();
    const confirm = page.getByTestId("confirm-rename");
    await confirm.waitFor();
    await expect(confirm.textContent()).resolves.toContain("Copy Files?");
    await expect(confirm.getByTestId("confirm-destinations").textContent()).resolves.toContain(moviesDir);
    await shoot("22-confirm-copy");
    await confirm.getByTestId("confirm").click();
    const result = page.getByTestId("rename-result");
    await result.waitFor();
    await expect(result.textContent()).resolves.toContain("Copied 2 files");
    await result.getByTestId("ok").click();

    expect((await readdir(moviesDir)).sort()).toEqual(["Inception (2010).en.srt", "Inception (2010).mkv"]);
    expect(await readFile(path.join(moviesDir, "Inception (2010).mkv"), "utf8")).toBe("INCEPTION");
    expect((await readdir(inbox)).sort()).toEqual([
      "Breaking Bad - S01E01 - Pilot.mkv",
      "Breaking.Bad.S01E01.720p.HDTV.x264.mkv",
      "Inception.2010.720p.WEB-DL.en.srt",
      "Inception.2010.720p.WEB-DL.mkv",
    ]);
  });

  it("records a later rename (moved in place)", async () => {
    await page.getByTestId("clear").click();
    await page.getByTestId("transfer-mode").selectOption("move");
    await stubOpenDialog([showsInbox]);
    await page.getByTestId("add-folder").click();
    await page.getByTestId("file-row").first().waitFor();
    await page.getByTestId("fetch").click();
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    await page.getByTestId("rename").click();
    await page.getByTestId("confirm-rename").getByTestId("confirm").click();
    await page.getByTestId("rename-result").getByTestId("ok").click();
    expect(await readdir(showsInbox)).toEqual(["Breaking Bad - S01E01 - Pilot.mkv"]);
  });

  it("undoes the older copy from Rename History, keeping the later rename", async () => {
    await page.getByTestId("history").click();
    const dialog = page.getByTestId("history-dialog");
    const entries = dialog.getByTestId("history-entry");
    await entries.nth(1).waitFor();
    expect(await entries.count()).toBe(2);
    await expect(entries.nth(0).textContent()).resolves.toContain("Renamed 1 file");
    await expect(entries.nth(1).textContent()).resolves.toContain("Copied 2 files");
    await expect(entries.nth(1).textContent()).resolves.toMatch(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [A-Z][a-z]+ \d{1,2}( at|, \d{4} at) \d{1,2}:\d{2} (AM|PM)/);
    await shoot("23-history-dialog");

    await entries.nth(1).getByTestId("history-undo").click();
    await expect(dialog.getByTestId("history-confirm").textContent()).resolves.toContain("1 later rename will stay as it is");
    await dialog.getByTestId("history-confirm-undo").click();
    const result = page.getByTestId("undo-result");
    await result.waitFor();
    await expect(result.textContent()).resolves.toContain("Restored2");
    await result.getByTestId("ok").click();

    // The copies are gone (the Inception copy in Movies and the episode copy
    // made in place); the originals and the later rename are untouched.
    expect(await readdir(moviesDir)).toEqual([]);
    expect((await readdir(inbox)).sort()).toEqual([
      "Breaking.Bad.S01E01.720p.HDTV.x264.mkv",
      "Inception.2010.720p.WEB-DL.en.srt",
      "Inception.2010.720p.WEB-DL.mkv",
    ]);
    expect(await readFile(path.join(inbox, "Inception.2010.720p.WEB-DL.mkv"), "utf8")).toBe("INCEPTION");
    expect(await readdir(showsInbox)).toEqual(["Breaking Bad - S01E01 - Pilot.mkv"]);
    const history = JSON.parse(await readFile(path.join(configDir, "history.json"), "utf8")) as unknown[];
    expect(history).toHaveLength(1);
  });

  it("stops at fetch when the output folder is missing, before anything moves", async () => {
    const missing = path.join(tmp, "Unplugged Drive", "Movies");
    await writeFile(
      path.join(configDir, "config.toml"),
      `${KEYS}[output]\nmovie = ${JSON.stringify(missing)}\ntransfer_mode = "move"\n`,
    );
    await page.getByTestId("clear").click();
    await stubOpenDialog([inbox]);
    await page.getByTestId("add-folder").click();
    await page.getByTestId("file-row").first().waitFor();
    await page.getByTestId("fetch").click();
    const error = page.getByTestId("error-dialog");
    await error.waitFor();
    await expect(error.textContent()).resolves.toContain("The movie output folder doesn't exist (is the drive connected?)");
    await shoot("24-missing-output-folder");
    await error.getByTestId("ok").click();
    await expect(page.getByTestId("rename").isDisabled()).resolves.toBe(true);
    expect(existsSync(path.join(inbox, "Inception.2010.720p.WEB-DL.mkv"))).toBe(true);
  });
});
