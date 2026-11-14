/**
 * End-to-end run of the update UI in the built app (`out-e2e/`), with the
 * scripted update engine (src/e2e/fakeUpdates.ts) in place of
 * electron-updater: no network. The menu item, IPC, main-process state
 * machine, and renderer are the real ones.
 *
 * Screenshots (light and dark) go to $TIDYTITLES_SCREENSHOT_DIR, default
 * out-e2e/screenshots, named updates-*.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ScriptedUpdateEngine } from "../src/e2e/fakeUpdates";
import type { TidyTitlesApi } from "../src/shared/ipc";

declare global {
  interface Window {
    readonly tidytitles: TidyTitlesApi;
  }
}

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");
const SHOTS = process.env.TIDYTITLES_SCREENSHOT_DIR ?? path.join(APP_DIR, "out-e2e", "screenshots");
/** A release newer than this app ("1.2.3-beta.4" -> "1.2.3-beta.5", "1.2.3" -> "1.2.4"); the app never offers a downgrade. */
const NEW = (() => {
  const { version } = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")) as { version: string };
  const pre = /^(.*\.)(\d+)$/.exec(version)!;
  return `${pre[1]}${Number(pre[2]) + 1}`;
})();

let tmp: string | undefined;
let electronApp: ElectronApplication | undefined;
let page: Page;

async function launch(mode: "1" | "unsigned"): Promise<string> {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-updates-"));
  const configDir = path.join(tmp, "config");
  const media = path.join(tmp, "Media Inbox");
  await mkdir(configDir, { recursive: true });
  await mkdir(media, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  for (const name of ["The.Matrix.1999.1080p.BluRay.x264.mkv", "Inception.2010.720p.WEB-DL.mkv"]) {
    await writeFile(path.join(media, name), "");
  }
  electronApp = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [MAIN],
    cwd: APP_DIR,
    colorScheme: null,
    env: {
      ...process.env,
      TIDYTITLES_E2E: "1",
      TIDYTITLES_E2E_FAKE_UPDATES: mode,
      TIDYTITLES_CONFIG_DIR: configDir,
      ELECTRON_RUN_AS_NODE: "",
    },
  });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow, shell }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(1180, 720);
    win.center();
    // Record instead of opening a browser.
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = (async (url: string) => {
      opened.push(url);
    }) as typeof shell.openExternal;
  });
  await page.waitForSelector(".app:not(.app-loading)");
  return media;
}

afterEach(async () => {
  await electronApp?.close();
  electronApp = undefined;
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

afterAll(async () => {
  await electronApp?.close();
});

async function setTheme(theme: "light" | "dark") {
  await electronApp!.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await page.waitForFunction((t) => window.matchMedia("(prefers-color-scheme: dark)").matches === (t === "dark"), theme);
  await page.waitForTimeout(200);
}

async function shoot(name: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await setTheme("light");
}

/** Click "Check for Updates…" in the real application menu. */
async function clickCheckForUpdates() {
  await electronApp!.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!.getMenuItemById("checkForUpdates")!.click();
  });
}

type EngineMember = "waiting" | "installRequested" | "resolveCheck" | "failCheck" | "progress" | "finishDownload" | "failInstall";

/** Call a method of (or read a field of) the scripted engine in main. */
function engine(member: EngineMember, ...args: unknown[]): Promise<unknown> {
  return electronApp!.evaluate(
    (_electron, [name, values]) => {
      const e = globalThis.__tidytitlesFakeUpdates as unknown as Record<string, unknown>;
      const value = e[name as string];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).apply(e, values as unknown[]) : value;
    },
    [member, args] as const,
  );
}

async function waitForEngine(what: "check" | "download") {
  await expect.poll(() => engine("waiting"), { timeout: 10_000 }).toMatchObject({ [what]: true });
}

// Keep the member names in step with the engine.
type _Check = Pick<ScriptedUpdateEngine, Exclude<EngineMember, never>>;

const dialog = () => page.getByTestId("update-dialog");
const indicator = () => page.getByTestId("update-indicator");

describe("updates", () => {
  it("checks from the menu, downloads with progress, and restarts when ready", async () => {
    const media = await launch("1");
    await page.evaluate((dir) => window.tidytitles.addPaths([dir]), media);

    await clickCheckForUpdates();
    await dialog().waitFor();
    await expect.poll(() => dialog().textContent()).toContain("Checking for updates…");
    await waitForEngine("check");
    await shoot("updates-01-checking");

    await engine("resolveCheck", NEW);
    await waitForEngine("download");
    await engine("progress", 42.4);
    await expect.poll(() => page.getByTestId("update-percent").textContent()).toBe("42%");
    await shoot("updates-02-downloading-dialog");

    // Hide: the download goes on, shown in the status bar.
    await dialog().getByTestId("update-close").click();
    await dialog().waitFor({ state: "detached" });
    await expect.poll(() => indicator().getAttribute("data-status")).toBe("downloading");
    await shoot("updates-03-downloading-status-bar");

    await engine("finishDownload");
    await expect.poll(() => indicator().getAttribute("data-status")).toBe("ready");
    await shoot("updates-04-ready-status-bar");

    // The menu item shows the ready update instead of checking again.
    await clickCheckForUpdates();
    await expect.poll(() => dialog().textContent()).toContain(`TidyTitles ${NEW} is ready to install.`);
    expect(await engine("waiting")).toEqual({ check: false, download: false });
    await shoot("updates-05-ready-dialog");

    // Files are in the list, so the restart asks first.
    await dialog().getByTestId("update-restart").click();
    const confirm = page.getByTestId("confirm-restart");
    await confirm.waitFor();
    expect(await confirm.textContent()).toContain("The file list will be cleared.");
    await shoot("updates-06-confirm-restart");
    await confirm.getByTestId("confirm").click();
    await expect.poll(() => engine("installRequested")).toBe(1);

    // The system updater refuses: fall back to the release page.
    await engine("failInstall");
    await expect.poll(() => indicator().getAttribute("data-status")).toBe("unsupported");
    await shoot("updates-07-install-failed-download");
    await page.getByTestId("update-indicator-download").click();
    await expect
      .poll(() => electronApp!.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
      .toEqual([`https://github.com/chrisoflaherty/TidyTitles/releases/tag/v${NEW}`]);
  });

  it("reports up to date and a failed check, with the releases page", async () => {
    await launch("1");
    const current = (await page.evaluate(() => window.tidytitles.getUpdateState())).currentVersion;

    await clickCheckForUpdates();
    await waitForEngine("check");
    await engine("resolveCheck", "0.0.1");
    await expect.poll(() => dialog().textContent()).toContain("TidyTitles is up to date.");
    expect(await dialog().textContent()).toContain(`You have version ${current}`);
    await shoot("updates-08-up-to-date");
    await dialog().getByTestId("update-close").click();
    await dialog().waitFor({ state: "detached" });
    // Seen in the dialog: nothing left in the status bar.
    expect(await indicator().count()).toBe(0);

    await clickCheckForUpdates();
    await waitForEngine("check");
    await engine("failCheck", "offline");
    await expect.poll(() => dialog().textContent()).toContain("Couldn’t check for updates.");
    expect(await dialog().textContent()).toContain("Check your internet connection");
    await shoot("updates-09-check-failed");
    await dialog().getByTestId("update-download").click();
    await expect
      .poll(() => electronApp!.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
      .toEqual(["https://github.com/chrisoflaherty/TidyTitles/releases"]);
  });

  it("offers a download when this copy cannot install updates", async () => {
    await launch("unsigned");
    await clickCheckForUpdates();
    await waitForEngine("check");
    await engine("resolveCheck", NEW);
    await expect.poll(() => dialog().textContent()).toContain(`TidyTitles ${NEW} is available.`);
    expect(await engine("waiting")).toEqual({ check: false, download: false });
    await shoot("updates-10-unsigned-download-dialog");
    await dialog().getByTestId("update-close").click();
    await expect.poll(() => indicator().getAttribute("data-status")).toBe("unsupported");
    await shoot("updates-11-unsigned-download-status-bar");
  });

  it("keeps the setting in userData", async () => {
    await launch("1");
    await page.evaluate(() => window.tidytitles.setAutoCheckForUpdates(false));
    expect((await page.evaluate(() => window.tidytitles.getUpdateState())).autoCheck).toBe(false);
    // The e2e build keeps userData in <config dir>/electron-user-data; config.toml is untouched.
    const saved = await readFile(path.join(tmp!, "config", "electron-user-data", "preferences.json"), "utf8");
    expect(JSON.parse(saved)).toEqual({ autoCheckForUpdates: false });
    await expect(page.evaluate(() => window.tidytitles.setAutoCheckForUpdates("no" as unknown as boolean))).rejects.toThrow(/boolean/);
  });
});
