/**
 * Correcting matches and names in the real built app (see app.e2e.test.ts
 * for the harness): search with other words, give a show to the other
 * episodes, re-checked conflicts, a typed name with its subtitle, music
 * search, clearing a match, and the renamed files on disk.
 *
 * Screenshots (light and dark) go to $TIDYTITLES_SCREENSHOT_DIR, default
 * out-e2e/screenshots.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TidyTitlesApi } from "../src/shared/ipc";

declare global {
  interface Window {
    readonly tidytitles: TidyTitlesApi;
  }
}

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");
const SHOTS = process.env.TIDYTITLES_SCREENSHOT_DIR ?? path.join(APP_DIR, "out-e2e", "screenshots");

const MEDIA = [
  "The.Office.S01E01.mkv",
  "The.Office.S01E02.mkv",
  "The.Office.S01E03.mkv",
  "Inception.2010.mkv",
  "Unknown.Film.2021.mkv",
  "Unknown.Film.2021.en.srt",
  "music/Daft Punk - One More Time.flac",
];

let tmp: string;
let mediaDir: string;
let electronApp: ElectronApplication;
let page: Page;

const media = (rel: string) => path.join(mediaDir, rel);
const row = (name: string) => page.getByTestId("file-row").filter({ hasText: name });
const statusOf = (name: string) => row(name).getByTestId("status-badge");

async function setTheme(theme: "light" | "dark") {
  await electronApp.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await page.waitForFunction((t) => window.matchMedia("(prefers-color-scheme: dark)").matches === (t === "dark"), theme);
  await page.waitForTimeout(150);
}

async function shoot(name: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await setTheme("light");
}

/** Wait until main is idle again after a change. */
const idle = () => page.waitForFunction(async () => (await window.tidytitles.getState()).busy === null);

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-correct-"));
  const configDir = path.join(tmp, "config");
  mediaDir = path.join(tmp, "Inbox");
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(mediaDir, "music"), { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  await writeFile(
    path.join(configDir, "config.toml"),
    '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n',
  );
  for (const rel of MEDIA) await writeFile(media(rel), rel);

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

describe("correcting matches and names", () => {
  it("fetches the list", async () => {
    await page.getByTestId("recursive").check();
    await page.evaluate((dir) => window.tidytitles.addPaths([dir]), mediaDir);
    await page.getByTestId("file-row").nth(5).waitFor();
    // No actions before a fetch.
    expect(await page.getByTestId("row-actions").count()).toBe(0);
    await page.getByTestId("fetch").click();
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    await expect(row("The.Office.S01E02").textContent()).resolves.toContain("The Office - S01E02 - Work Experience.mkv");
    await expect(statusOf("Unknown.Film").textContent()).resolves.toBe("No match");
    expect(await page.getByTestId("row-actions").count()).toBe(6);
  });

  it("rejects malformed correction arguments in main", async () => {
    await expect(page.evaluate(() => window.tidytitles.getMatchContext("1" as unknown as number))).rejects.toThrow(/fileId/);
    await expect(
      page.evaluate(() => window.tidytitles.searchMatches(1, { mediaType: "movie", title: "x", path: "/etc" } as never)),
    ).rejects.toThrow(/unknown query field/);
    await expect(page.evaluate(() => window.tidytitles.setFileName(1, 5 as unknown as string))).rejects.toThrow(/name/);
  });

  it("gives another show to every episode of the season in one change", async () => {
    await row("The.Office.S01E01").getByTestId("row-actions").click();
    await page.getByTestId("row-menu").waitFor();
    await shoot("10-row-actions-menu");
    await page.getByTestId("row-action-changeMatch").click();

    const dialog = page.getByTestId("match-dialog");
    await dialog.getByTestId("match-option").first().waitFor();
    // It starts with what the fetch searched for.
    await expect(dialog.getByTestId("match-title").inputValue()).resolves.toBe("The Office");
    await expect(dialog.getByTestId("match-season").inputValue()).resolves.toBe("1");
    await expect(dialog.getByTestId("match-episode").inputValue()).resolves.toBe("1");
    expect(await dialog.getByTestId("match-option").count()).toBe(1);

    await dialog.getByTestId("match-title").fill("Office");
    await dialog.getByTestId("match-title").press("Enter");
    await dialog.getByTestId("match-message").filter({ hasText: "2 results" }).waitFor();
    await expect(dialog.getByTestId("match-apply-similar").textContent()).resolves.toBe(
      "Also use this show for the 2 other files named “The Office”",
    );
    await shoot("11-change-match-dialog");
    await dialog.getByTestId("match-use").click();
    await dialog.waitFor({ state: "detached" });
    await idle();

    for (const [e, title] of [
      [1, "Pilot"],
      [2, "Diversity Day"],
      [3, "Health Care"],
    ] as const) {
      await expect(row(`The.Office.S01E0${e}`).textContent()).resolves.toContain(`The Office (US) - S01E0${e} - ${title}.mkv`);
      await expect(statusOf(`The.Office.S01E0${e}`).textContent()).resolves.toBe("Selected");
    }
  });

  it("matches a file with no match from the keyboard, and re-checks conflicts", async () => {
    await row("Unknown.Film.2021.mkv").click();
    await page.keyboard.press("Enter");
    const dialog = page.getByTestId("match-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("match-message").filter({ hasText: "Nothing found" }).waitFor();
    await dialog.getByTestId("match-title").fill("Inception");
    await dialog.getByTestId("match-year").fill("");
    await page.keyboard.press("Enter");
    await dialog.getByTestId("match-option").first().waitFor();
    // Enter on the selected result uses it.
    await dialog.getByTestId("match-option").first().locator("input").focus();
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await idle();
    // Inception.2010.mkv already gets that name, so the corrected file yields.
    await expect(statusOf("Unknown.Film.2021.mkv").textContent()).resolves.toBe("Duplicate name");
    await expect(statusOf("Inception.2010").textContent()).resolves.toBe("Auto-matched");
  });

  it("types a new name, refusing an invalid one, and the subtitle follows", async () => {
    await row("Unknown.Film.2021.mkv").click();
    await page.keyboard.press("F2");
    const dialog = page.getByTestId("name-dialog");
    const input = dialog.getByTestId("name-input");
    await expect.poll(() => input.inputValue()).toBe("Inception (2010)");
    await input.fill("Inception: Extended");
    await page.keyboard.press("Enter");
    await dialog.getByTestId("name-error").waitFor();
    await expect(input.getAttribute("aria-invalid")).resolves.toBe("true");
    await shoot("12-edit-name-error");

    await input.fill("Inception (2010) Extended");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await idle();
    await expect(statusOf("Unknown.Film.2021.mkv").textContent()).resolves.toBe("Selected");
    await expect(row("Unknown.Film.2021.mkv").getByTestId("name-edited").textContent()).resolves.toBe("Edited");
    await expect(row("Unknown.Film.2021.mkv").textContent()).resolves.toContain("Inception (2010) Extended.mkv");
    await expect(page.locator(".assoc-row").filter({ hasText: "Unknown.Film.2021.en.srt" }).textContent()).resolves.toContain(
      "Inception (2010) Extended.en.srt",
    );
  });

  it("searches for music by title, artist, and album", async () => {
    await row("Daft Punk").getByTestId("row-actions").click();
    await page.getByTestId("row-action-changeMatch").click();
    const dialog = page.getByTestId("match-dialog");
    await dialog.waitFor();
    await expect.poll(() => dialog.getByTestId("match-artist").inputValue()).toBe("Daft Punk");
    expect(await dialog.getByTestId("match-type").count()).toBe(0);
    await dialog.getByTestId("match-title").fill("Digital Love");
    await dialog.getByTestId("match-search").click();
    await dialog.getByTestId("match-message").filter({ hasText: "2 results" }).waitFor();
    await dialog.getByTestId("match-use").click();
    await dialog.waitFor({ state: "detached" });
    await idle();
    await expect(row("Daft Punk").textContent()).resolves.toContain("03 - Digital Love.flac");
  });

  it("clears a match from the context menu", async () => {
    await row("Inception.2010").click({ button: "right" });
    await page.getByTestId("row-action-clearMatch").click();
    await expect.poll(() => statusOf("Inception.2010").textContent()).toBe("Left alone");
    await idle();
    await shoot("13-table-after-corrections");
  });

  it("renames to the corrected names on disk", async () => {
    await page.getByTestId("rename").click();
    await page.getByTestId("confirm-rename").waitFor();
    await page.getByTestId("confirm").click();
    const result = page.getByTestId("rename-result");
    await result.waitFor();
    await expect(result.textContent()).resolves.toContain("Renamed 5 files");
    await result.getByTestId("ok").click();

    expect(existsSync(media("The Office (US) - S01E01 - Pilot.mkv"))).toBe(true);
    expect(existsSync(media("The Office (US) - S01E02 - Diversity Day.mkv"))).toBe(true);
    expect(existsSync(media("The Office (US) - S01E03 - Health Care.mkv"))).toBe(true);
    expect(await readFile(media("Inception (2010) Extended.mkv"), "utf8")).toBe("Unknown.Film.2021.mkv");
    expect(await readFile(media("Inception (2010) Extended.en.srt"), "utf8")).toBe("Unknown.Film.2021.en.srt");
    expect(await readFile(media("music/Daft Punk/Discovery (2001)/03 - Digital Love.flac"), "utf8")).toBe(
      "music/Daft Punk - One More Time.flac",
    );
    // The cleared file is left alone.
    expect(await readFile(media("Inception.2010.mkv"), "utf8")).toBe("Inception.2010.mkv");
    // No actions once renamed.
    expect(await page.getByTestId("row-actions").count()).toBe(0);
  });
});
