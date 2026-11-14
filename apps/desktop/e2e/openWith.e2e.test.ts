/**
 * Files opened with the app from outside the window, and the feedback
 * outside it (see src/main/openPaths.ts and src/main/taskFeedback.ts):
 *
 * - paths on the command line at first launch (Windows and Linux, and
 *   files dragged onto the Windows shortcut or exe, arrive this way)
 * - paths given to a second instance, which hands them to the running one
 * - refusal while a drop would be refused (a dialog is open)
 * - icon progress, the attention request at a "which match?" question, and
 *   the notification after a rename while the window is in the background.
 *   The e2e build records these instead of showing them.
 *
 * macOS's `open-file` (Dock, Finder's Open With) cannot be sent from here;
 * it was checked by hand with the packaged app (BUILD.md).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TidyTitlesE2eFeedback } from "../src/e2e/main";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");

let tmp: string;
let configDir: string;
let mediaDir: string;
let env: Record<string, string>;
let electronApp: ElectronApplication;
let page: Page;

const media = (rel: string) => path.join(mediaDir, rel);
const rows = () => page.getByTestId("file-row");

/** Start a second instance with these arguments and wait for it to hand them over and quit. */
function secondInstance(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath as unknown as string, [MAIN, ...args], { cwd: mediaDir, env, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The second instance did not quit"));
    }, 30_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const feedback = () =>
  electronApp.evaluate(() => {
    const f = globalThis.__tidytitlesE2eFeedback as TidyTitlesE2eFeedback;
    return { notifications: [...f.notifications], attention: f.attention };
  });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-open-"));
  configDir = path.join(tmp, "config");
  mediaDir = path.join(tmp, "Downloads");
  await mkdir(configDir, { recursive: true });
  await mkdir(media("Albums"), { recursive: true });
  await writeFile(
    path.join(configDir, "config.toml"),
    '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n',
  );
  for (const name of [
    "The.Matrix.1999.1080p.BluRay.x264.mkv",
    "Inception.2010.720p.WEB-DL.mkv",
    "Breaking.Bad.S01E01.720p.HDTV.x264.mkv",
    "notes.txt",
    "Albums/Queen - Bohemian Rhapsody.mp3",
  ]) {
    await writeFile(media(name), "");
  }
  env = { ...(process.env as Record<string, string>), TIDYTITLES_E2E: "1", TIDYTITLES_CONFIG_DIR: configDir, ELECTRON_RUN_AS_NODE: "" };

  electronApp = await _electron.launch({
    executablePath: electronPath as unknown as string,
    // A file, a folder (scanned), a switch, a missing file, and a relative path.
    args: [
      MAIN,
      media("The.Matrix.1999.1080p.BluRay.x264.mkv"),
      "--some-chromium-switch=1",
      media("Albums"),
      media("Missing.2001.mkv"),
      "Inception.2010.720p.WEB-DL.mkv",
    ],
    cwd: mediaDir,
    colorScheme: null,
    env,
  });
  page = await electronApp.firstWindow();
  await page.waitForSelector(".app:not(.app-loading)");
}, 60_000);

afterAll(async () => {
  await electronApp?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("Opening files with the app", () => {
  it("adds the files and folders named on the command line", async () => {
    await rows().nth(2).waitFor();
    const names = await rows().allTextContents();
    expect(names).toHaveLength(3);
    expect(names.join("|")).toContain("The.Matrix.1999");
    expect(names.join("|")).toContain("Inception.2010");
    expect(names.join("|")).toContain("Queen - Bohemian Rhapsody");
  });

  it("adds the files a second instance was started with, and the second instance quits", async () => {
    // Relative to the second instance's working directory; the text file is not media.
    await expect(secondInstance(["Breaking.Bad.S01E01.720p.HDTV.x264.mkv", "notes.txt"])).resolves.toBe(0);
    await rows().nth(3).waitFor();
    expect(await rows().count()).toBe(4);
    await expect(page.getByTestId("status-message").textContent()).resolves.toContain("Added 1 file");
  });

  it("refuses opened files while a drop would be refused", async () => {
    await electronApp.evaluate(({ dialog }) => {
      const shown: string[] = [];
      (globalThis as { __shownBoxes?: string[] }).__shownBoxes = shown;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const opts = args.find((a) => typeof a === "object" && a !== null && "message" in a) as { message: string };
        shown.push(opts.message);
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await page.getByTestId("settings").click();
    await page.getByTestId("settings-dialog").waitFor();
    await writeFile(media("Late.Arrival.2020.mkv"), "");
    await expect(secondInstance([media("Late.Arrival.2020.mkv")])).resolves.toBe(0);
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as { __shownBoxes?: string[] }).__shownBoxes ?? []))
      .toEqual(["The item wasn’t added"]);
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
    expect(await rows().count()).toBe(4);
  });

  it("shows progress on the icon, asks for attention, and notifies in the background", async () => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const values: number[] = [];
      (globalThis as { __progress?: number[] }).__progress = values;
      const win = BrowserWindow.getAllWindows()[0]!;
      const original = win.setProgressBar.bind(win);
      win.setProgressBar = (value, options) => {
        values.push(value);
        original(value, options);
      };
      (globalThis.__tidytitlesE2eFeedback as TidyTitlesE2eFeedback).focused = false;
    });
    const progress = () => electronApp.evaluate(() => (globalThis as { __progress?: number[] }).__progress ?? []);

    await page.getByTestId("fetch").click();
    const selection = page.getByTestId("selection-dialog");
    await selection.waitFor();
    await expect.poll(async () => (await feedback()).attention).toBe(1);
    await selection.getByTestId("selection-option").first().click();
    await selection.getByTestId("selection-select").click();
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    const afterFetch = await progress();
    expect(afterFetch.some((v) => v >= 0 && v <= 1)).toBe(true);
    expect(afterFetch.at(-1)).toBe(-1);

    await page.getByTestId("rename").click();
    await page.getByTestId("confirm").click();
    await page.getByTestId("rename-result").waitFor();
    expect((await progress()).at(-1)).toBe(-1);
    const { notifications } = await feedback();
    expect(notifications).toEqual([{ title: "Rename Complete", body: expect.stringMatching(/^Renamed 4 files/) }]);
    expect(existsSync(media("The Matrix (1999).mkv"))).toBe(true);
  });
});
