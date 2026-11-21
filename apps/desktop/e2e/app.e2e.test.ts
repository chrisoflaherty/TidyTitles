/**
 * End-to-end run of the real built app (`out-e2e/`, see src/e2e/main.ts):
 * fake providers, no network, a temporary config directory, and real files
 * renamed on disk. Native file dialogs are replaced in the main process with
 * `electronApp.evaluate`, so the toolbar buttons run their real code path.
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

const MEDIA = {
  matrix: "The.Matrix.1999.1080p.BluRay.x264.mkv",
  inception: "Inception.2010.720p.WEB-DL.mkv",
  inceptionSub: "Inception.2010.720p.WEB-DL.en.srt",
  breakingBad: "Breaking.Bad.S01E01.720p.HDTV.x264.mkv",
  broken: "Broken.Show.S02E03.mkv",
  unknown: "Unknown.Film.2021.mkv",
  queen: "music/Queen - Bohemian Rhapsody.mp3",
  demo: "music/03 - Basement Tapes - Demo.mp3",
  daft: "music/Daft Punk - One More Time.flac",
} as const;

let tmp: string;
let configDir: string;
let mediaDir: string;
let electronApp: ElectronApplication;
let page: Page;

async function setTheme(theme: "light" | "dark") {
  await electronApp.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await page.waitForFunction(
    (t) => window.matchMedia("(prefers-color-scheme: dark)").matches === (t === "dark"),
    theme,
  );
  await page.waitForTimeout(150);
}

/** Screenshot the window in both themes, ending in light. */
async function shoot(name: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await setTheme("light");
}

async function stubOpenDialog(paths: string[]) {
  await electronApp.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
  }, paths);
}

function statusOf(name: string) {
  return page.getByTestId("file-row").filter({ hasText: name }).getByTestId("status-badge");
}

const media = (rel: string) => path.join(mediaDir, rel);

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-"));
  configDir = path.join(tmp, "config");
  mediaDir = path.join(tmp, "Media Inbox");
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(mediaDir, "music"), { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  // Keys only make the provider menu offer "Auto"; the e2e build never calls real services.
  await writeFile(
    path.join(configDir, "config.toml"),
    '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n',
  );
  for (const rel of Object.values(MEDIA)) await writeFile(media(rel), "");

  electronApp = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [MAIN],
    cwd: APP_DIR,
    // Let nativeTheme drive prefers-color-scheme (Playwright would emulate "light").
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

describe("TidyTitles desktop app", () => {
  it("runs with the security settings in effect", async () => {
    const prefs = await electronApp.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      // Electron does not expose the final webPreferences; read what we can observe.
      return { url: wc.getURL() };
    });
    expect(prefs.url.startsWith("file://")).toBe(true);
    const exposed = await page.evaluate(() => ({
      api: typeof window.tidytitles,
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      ipc: Object.keys(window.tidytitles).includes("ipcRenderer"),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
    }));
    expect(exposed).toMatchObject({ api: "object", require: "undefined", process: "undefined", ipc: false });
    expect(exposed.csp).toContain("default-src 'none'");
    // Untrusted IPC arguments are rejected in main.
    await expect(page.evaluate(() => window.tidytitles.addPaths(["relative/path"]))).rejects.toThrow(/absolute/);
    await expect(page.evaluate(() => window.tidytitles.openExternal("file:///etc/passwd"))).rejects.toThrow(/https/);
  });

  it("shows the empty state", async () => {
    await expect(page.getByTestId("empty-state").isVisible()).resolves.toBe(true);
    await shoot("01-empty-state");
  });

  it("adds a folder (recursively) through the toolbar", async () => {
    await page.getByTestId("recursive").check();
    await stubOpenDialog([mediaDir]);
    await page.getByTestId("add-folder").click();
    await page.getByTestId("file-row").nth(7).waitFor();
    expect(await page.getByTestId("file-row").count()).toBe(8);
    await expect(statusOf("Inception").textContent()).resolves.toBe("Not fetched");
  });

  it("cancels a fetch from the selection dialog", async () => {
    await page.getByTestId("fetch").click();
    await page.getByTestId("selection-dialog").waitFor();
    await page.getByTestId("selection-cancel-all").click();
    await page.getByTestId("status-message").filter({ hasText: "Fetch canceled" }).waitFor();
    await expect(page.getByTestId("selection-dialog").count()).resolves.toBe(0);
    await expect(statusOf("Inception").textContent()).resolves.toBe("Not fetched");
  });

  it("fetches metadata, asking which match to use", async () => {
    await page.getByTestId("cover-art").check();
    await page.getByTestId("fetch").click();
    const selection = page.getByTestId("selection-dialog");
    await selection.waitFor();
    expect(await selection.getByTestId("selection-option").count()).toBe(3);
    await expect(selection.textContent()).resolves.toContain("The.Matrix.1999.1080p.BluRay.x264.mkv");
    await shoot("03-selection-dialog");
    await selection.getByTestId("selection-option").first().click();
    await selection.getByTestId("selection-select").click();

    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    const expected: Record<string, string> = {
      "The.Matrix": "Selected",
      "Inception.2010": "Auto-matched",
      "Breaking.Bad": "Auto-matched",
      "Broken.Show": "Lookup failed",
      "Unknown.Film": "No match",
      "Queen - Bohemian": "Verified",
      "Basement Tapes": "Unverified",
      "Daft Punk": "From MusicBrainz",
    };
    for (const [name, label] of Object.entries(expected)) {
      await expect(statusOf(name).textContent(), name).resolves.toBe(label);
    }
    // Row tints follow the status meaning.
    const tones = await page.getByTestId("file-row").evaluateAll((rows) =>
      rows.map((r) => [r.textContent?.slice(0, 40), r.getAttribute("data-tone")]),
    );
    expect(tones.filter(([, t]) => t === "success")).toHaveLength(4);
    expect(tones.filter(([, t]) => t === "warning")).toHaveLength(1);
    expect(tones.filter(([, t]) => t === "danger")).toHaveLength(2);
    // The subtitle moves with Inception.
    await expect(page.locator(".assoc-row").textContent()).resolves.toContain("Inception (2010).en.srt");
    await shoot("02-table-after-fetch");
  });

  it("renames the files on disk and shows a summary", async () => {
    await page.getByTestId("rename").click();
    await page.getByTestId("confirm-rename").waitFor();
    await page.getByTestId("confirm").click();
    const result = page.getByTestId("rename-result");
    await result.waitFor();
    await expect(result.textContent()).resolves.toContain("Renamed 6 files");
    await shoot("04-rename-results");

    expect(existsSync(media("The Matrix (1999).mkv"))).toBe(true);
    expect(existsSync(media("Inception (2010).mkv"))).toBe(true);
    expect(existsSync(media("Inception (2010).en.srt"))).toBe(true);
    expect(existsSync(media("Breaking Bad - S01E01 - Pilot.mkv"))).toBe(true);
    expect(existsSync(media("music/Queen/A Night at the Opera (1975)/11 - Bohemian Rhapsody.mp3"))).toBe(true);
    expect(existsSync(media("music/Daft Punk/Discovery (2001)/01 - One More Time.flac"))).toBe(true);
    expect(existsSync(media("poster.jpg"))).toBe(true);
    expect(existsSync(media(MEDIA.matrix))).toBe(false);
    expect(existsSync(media(MEDIA.inceptionSub))).toBe(false);
    // Skipped files are untouched.
    expect(existsSync(media(MEDIA.unknown))).toBe(true);
    expect(existsSync(media(MEDIA.broken))).toBe(true);

    await result.getByTestId("ok").click();
    await expect(statusOf("The Matrix (1999)").textContent()).resolves.toBe("Renamed");
    await shoot("04b-table-after-rename");

    // The smallest window size still fits the toolbar and table.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(760, 480));
    await page.waitForFunction(() => window.innerWidth === 760);
    const overflow = await page.evaluate(() => {
      const bar = document.querySelector(".toolbar")!;
      return bar.scrollWidth - bar.clientWidth;
    });
    expect(overflow).toBe(0);
    await shoot("06-minimum-window-size");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1180, 720));
  });

  it("undoes the rename from history", async () => {
    const history = JSON.parse(await readFile(path.join(configDir, "history.json"), "utf8")) as unknown[];
    expect(history).toHaveLength(1);

    await page.getByTestId("undo").click();
    await page.getByTestId("confirm-undo").waitFor();
    await page.getByTestId("confirm").click();
    const result = page.getByTestId("undo-result");
    await result.waitFor();
    await expect(result.textContent()).resolves.toContain("Restored6");
    await result.getByTestId("ok").click();

    for (const rel of Object.values(MEDIA)) expect(existsSync(media(rel)), rel).toBe(true);
    expect(existsSync(media("The Matrix (1999).mkv"))).toBe(false);
    expect(existsSync(media("Inception (2010).en.srt"))).toBe(false);
    await expect(statusOf("The.Matrix").textContent()).resolves.toBe("Not fetched");
    expect(JSON.parse(await readFile(path.join(configDir, "history.json"), "utf8"))).toHaveLength(0);
  });

  it("edits a template with live preview and saves settings", async () => {
    await page.getByTestId("settings").click();
    const dialog = page.getByTestId("settings-dialog");
    await dialog.getByTestId("template-movie").waitFor();
    await expect(dialog.getByTestId("template-movie-preview").textContent()).resolves.toContain("The Matrix (1999).mkv");

    const movie = dialog.getByTestId("template-movie");
    await movie.fill("{title} [{year}] {bogus}");
    await dialog.getByTestId("template-movie-error").filter({ hasText: "Unknown field: {bogus}" }).waitFor();
    await shoot("05b-settings-template-error");

    await movie.fill("{title} [{year}] {quality}");
    await dialog.getByTestId("template-movie-preview").filter({ hasText: "The Matrix [1999] 1080p.mkv" }).waitFor();
    await shoot("05-settings-dialog");

    await dialog.getByTestId("settings-tab-api").click();
    const key = dialog.getByTestId("tmdb-key");
    await expect(key.getAttribute("type")).resolves.toBe("password");
    await dialog.getByRole("button", { name: "Show TMDB API key" }).click();
    await expect(key.getAttribute("type")).resolves.toBe("text");
    await shoot("05c-settings-api-keys");

    await dialog.getByTestId("settings-tab-files").click();
    await dialog.getByTestId("conflict-auto_version").check();

    await dialog.getByTestId("settings-save").click();
    await dialog.waitFor({ state: "detached" });
    const toml = await readFile(path.join(configDir, "config.toml"), "utf8");
    expect(toml).toContain('movie = "{title} [{year}] {quality}"');
    expect(toml).toContain('conflict_resolution = "auto_version"');
    expect(toml).toContain('tmdb_api_key = "e2e-not-a-real-key"');
  });

  it("fills the templates from a naming preset and shows Custom once edited", async () => {
    await page.getByTestId("settings").click();
    const dialog = page.getByTestId("settings-dialog");
    const picker = dialog.getByTestId("naming-preset");
    await picker.waitFor();
    // The movie template was edited by the previous test.
    await expect(picker.inputValue()).resolves.toBe("custom");

    await picker.selectOption("plex");
    await expect(dialog.getByTestId("template-movie").inputValue()).resolves.toBe(
      "{title} ({year})< {tmdb-{tmdb_id}}>< {edition-{edition}}>/{title} ({year})< {edition-{edition}}>",
    );
    await dialog
      .getByTestId("template-movie-preview")
      .filter({ hasText: "The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv" })
      .waitFor();
    await dialog
      .getByTestId("template-tv-preview")
      .filter({ hasText: "Breaking Bad (2008) {tvdb-81189}/Season 01/Breaking Bad (2008) - s01e01 - Pilot.mkv" })
      .waitFor();
    await dialog.getByTestId("template-music-preview").filter({ hasText: "Pink Floyd/The Wall/206 - Comfortably Numb.flac" }).waitFor();
    await dialog.locator("details.reference summary").click();
    await dialog.getByTestId("placeholder-table").filter({ hasText: "{audio_channels}" }).waitFor();
    await shoot("05d-settings-naming-preset");

    // Still editable: an edit turns the picker to Custom.
    const tv = dialog.getByTestId("template-tv");
    await tv.fill("{title} S{season2}E{episode2}");
    await expect(picker.inputValue()).resolves.toBe("custom");
    await expect(dialog.getByTestId("naming-preset-hint").textContent()).resolves.toContain("Custom");

    await picker.selectOption("plex");
    await dialog.getByTestId("settings-save").click();
    await dialog.waitFor({ state: "detached" });
    const toml = await readFile(path.join(configDir, "config.toml"), "utf8");
    expect(toml).toContain("Season {season2}/{title} ({year}) - s{season2}e{episode2}");

    // Reopened, the dialog shows the saved preset; put the previous template back.
    await page.getByTestId("settings").click();
    await expect(dialog.getByTestId("naming-preset").inputValue()).resolves.toBe("plex");
    await dialog.getByTestId("naming-preset").selectOption("default");
    await dialog.getByTestId("template-movie").fill("{title} [{year}] {quality}");
    await dialog.getByTestId("settings-save").click();
    await dialog.waitFor({ state: "detached" });
  });

  it("remembers the window size and position", async () => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setBounds({ x: 80, y: 90, width: 1000, height: 640 });
    });
    await electronApp.close();
    const saved = JSON.parse(
      await readFile(path.join(configDir, "electron-user-data", "window-state.json"), "utf8"),
    ) as { width: number; height: number; x: number; y: number };
    expect(saved).toMatchObject({ width: 1000, height: 640, x: 80, y: 90 });

    electronApp = await _electron.launch({
      executablePath: electronPath as unknown as string,
      args: [MAIN],
      cwd: APP_DIR,
    // Let nativeTheme drive prefers-color-scheme (Playwright would emulate "light").
    colorScheme: null,
      env: { ...process.env, TIDYTITLES_E2E: "1", TIDYTITLES_CONFIG_DIR: configDir, ELECTRON_RUN_AS_NODE: "" },
    });
    page = await electronApp.firstWindow();
    await page.waitForSelector(".app:not(.app-loading)");
    const bounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    expect(bounds).toMatchObject({ width: 1000, height: 640, x: 80, y: 90 });
  });
});
