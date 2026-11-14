/**
 * The windowed file list with a large list, in the real window (see
 * app.e2e.test.ts for the harness): only rows near the viewport are in the
 * DOM, the scrollbar reflects the whole list, keyboard focus survives
 * windowing, and rows whose height differs from the estimate do not make the
 * list jump while scrolling.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Half match the fake provider (each in its own folder, one in four with a subtitle), half find nothing. */
const FILES = 2000;
const MATCHED = FILES / 2;
const SUBTITLES = MATCHED / 4;

let tmp: string;
let electronApp: ElectronApplication;
let page: Page;

/** Wait until React has rendered and the browser has painted. */
const settle = () =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(() => requestAnimationFrame(() => resolve()), 0)),
      ),
  );

const table = () => page.getByTestId("file-table");

async function setScrollTop(top: number) {
  await table().evaluate((el, t) => {
    el.scrollTop = t;
  }, top);
  await settle();
  await settle();
}

/** Layout facts of the list. */
function metrics() {
  return table().evaluate((el) => {
    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="file-row"]')];
    // The header cells are sticky (the thead itself scrolls away).
    const head = el.querySelector("thead th")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const active = document.activeElement as HTMLElement | null;
    const activeRect = active?.getBoundingClientRect();
    return {
      rowsInDom: rows.length,
      rowCount: Number(el.querySelector("table")!.getAttribute("aria-rowcount")),
      rowHeight: rows[0]!.getBoundingClientRect().height,
      headerHeight: head.height,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      active: active?.dataset.testid === "file-row" ? active.textContent : null,
      activeRowIndex: active?.getAttribute("aria-rowindex") ?? null,
      /** The focused row is entirely inside the list, below the sticky header. */
      activeVisible: activeRect ? activeRect.top >= head.bottom - 0.5 && activeRect.bottom <= box.bottom + 0.5 : false,
    };
  });
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-large-"));
  const configDir = path.join(tmp, "config");
  const mediaDir = path.join(tmp, "media");
  await mkdir(configDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.toml"),
    '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n',
  );
  const writes: Promise<void>[] = [];
  for (let i = 0; i < MATCHED; i++) {
    const n = String(i).padStart(5, "0");
    const dir = path.join(mediaDir, `Inception ${n}`);
    writes.push(
      mkdir(dir).then(async () => {
        await writeFile(path.join(dir, "Inception.2010.720p.WEB-DL.mkv"), "");
        if (i % 4 === 0) await writeFile(path.join(dir, "Inception.2010.720p.WEB-DL.en.srt"), "");
      }),
    );
    writes.push(writeFile(path.join(mediaDir, `Unknown.Film.${n}.2021.mkv`), ""));
  }
  await Promise.all(writes);

  electronApp = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [MAIN],
    cwd: APP_DIR,
    env: { ...process.env, TIDYTITLES_E2E: "1", TIDYTITLES_CONFIG_DIR: configDir, ELECTRON_RUN_AS_NODE: "" },
  });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(1180, 720);
    win.center();
  });
  await page.waitForSelector(".app:not(.app-loading)");
  await page.evaluate(async (dir) => {
    await window.tidytitles.setOptions({ recursive: true });
    await window.tidytitles.addPaths([dir]);
  }, mediaDir);
  await page.getByTestId("status-message").filter({ hasText: "Added 2,000 files" }).waitFor();
  await settle();
}, 90_000);

afterAll(async () => {
  await electronApp?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("a large file list", () => {
  it("keeps only the rows near the viewport in the DOM, with a full-length scrollbar", async () => {
    const m = await metrics();
    expect(m.rowsInDom).toBeGreaterThan(10);
    expect(m.rowsInDom).toBeLessThan(80);
    expect(m.rowCount).toBe(FILES + 1);
    expect(m.scrollHeight).toBeCloseTo(m.headerHeight + FILES * m.rowHeight, 0);

    await setScrollTop(m.scrollHeight);
    const bottom = await metrics();
    expect(bottom.rowsInDom).toBeLessThan(80);
    const last = page.getByTestId("file-row").last();
    await expect(last.textContent()).resolves.toContain(`Unknown.Film.${String(MATCHED - 1).padStart(5, "0")}`);
    await expect(last.getAttribute("aria-rowindex")).resolves.toBe(String(FILES + 1));
    await setScrollTop(0);
  });

  it("moves keyboard focus through rows that were not rendered, and keeps it while scrolling", async () => {
    await page.getByTestId("file-row").first().click();
    await page.keyboard.press("End");
    await settle();
    let m = await metrics();
    expect(m.activeRowIndex).toBe(String(FILES + 1));
    expect(m.activeVisible).toBe(true);

    await page.keyboard.press("Home");
    await settle();
    m = await metrics();
    expect(m.activeRowIndex).toBe("2");
    expect(m.activeVisible).toBe(true);

    // Scroll the focused row far out of the window: it stays focused.
    await setScrollTop(m.scrollHeight / 2);
    m = await metrics();
    expect(m.activeRowIndex).toBe("2");
    expect(m.activeVisible).toBe(false);
    await page.keyboard.press("ArrowDown");
    await settle();
    m = await metrics();
    expect(m.activeRowIndex).toBe("3");
    expect(m.activeVisible).toBe(true);

    await page.keyboard.press("PageDown");
    await settle();
    m = await metrics();
    expect(m.activeRowIndex).toBe("13");
    expect(m.activeVisible).toBe(true);

    // Escape clears the selection but keeps focus; jumping away (as when dragging
    // the scrollbar) keeps both the scroll position and the focus.
    await page.keyboard.press("Escape");
    const half = Math.round(m.scrollHeight / 2);
    await setScrollTop(half);
    m = await metrics();
    expect(m.scrollTop).toBe(half);
    expect(m.activeRowIndex).toBe("13");
    expect(m.activeVisible).toBe(false);
    await page.keyboard.press("ArrowDown");
    await settle();
    m = await metrics();
    expect(m.activeRowIndex).toBe("2");
    expect(m.activeVisible).toBe(true);
  });

  it("sizes the list for associated-file rows after fetching", async () => {
    await page.evaluate(() => window.tidytitles.fetch());
    await page.getByTestId("status-message").filter({ hasText: "ready to rename" }).waitFor();
    await settle();
    const m = await metrics();
    expect(m.rowCount).toBe(FILES + SUBTITLES + 1);
    expect(m.scrollHeight).toBeCloseTo(m.headerHeight + (FILES + SUBTITLES) * m.rowHeight, 0);
    expect(await page.locator(".assoc-row").count()).toBeGreaterThan(0);
  });

  it("does not jump when rows turn out taller than estimated", async () => {
    // Make associated-file rows taller than the list assumes (CSSOM: the CSP blocks <style>).
    await page.evaluate(() => {
      const sheet = document.styleSheets[0]!;
      sheet.insertRule(".file-table tbody tr.assoc-row td { height: 46px; }", sheet.cssRules.length);
    });
    const { scrollHeight } = await metrics();
    await setScrollTop(scrollHeight / 2);

    /** Scroll by `delta` and report how far a row that stays on screen moved. */
    const step = async (delta: number) => {
      const before = await table().evaluate((el) => {
        const head = el.querySelector("thead th")!.getBoundingClientRect().bottom;
        const row = [...el.querySelectorAll<HTMLElement>('[data-testid="file-row"]')].find(
          (r) => r.getBoundingClientRect().top >= head + 150,
        )!;
        return { index: row.getAttribute("aria-rowindex")!, top: row.getBoundingClientRect().top };
      });
      await table().evaluate((el, d) => {
        el.scrollTop += d;
      }, delta);
      await settle();
      await settle();
      const top = await table().evaluate(
        (el, index) => el.querySelector(`[aria-rowindex="${index}"]`)!.getBoundingClientRect().top,
        before.index,
      );
      return before.top - top;
    };

    // Upward: new rows enter above the viewport and are measured there.
    for (let i = 0; i < 30; i++) expect(await step(-90)).toBeCloseTo(-90, 0);
    for (let i = 0; i < 30; i++) expect(await step(90)).toBeCloseTo(90, 0);

    // Once every row has been rendered, the scrollbar matches the real length.
    // (Each step renders the viewport plus a margin above and below it.)
    const { clientHeight } = await metrics();
    for (let top = 0; top < (await metrics()).scrollHeight; top += clientHeight + 400) await setScrollTop(top);
    const m = await metrics();
    expect(m.scrollHeight).toBeCloseTo(m.headerHeight + FILES * m.rowHeight + SUBTITLES * 46, 0);
  });
});
