// Measures how the file list copes with a large list, in the e2e build
// (`npm run build:e2e` first; fake providers, no network, temporary config).
//
//   node scripts/measure-file-list.mjs [--files 10000] [--out results.json]
//
// It creates a temporary folder of empty movie-like files (half match the fake
// provider, one in ten of those has a subtitle, the rest find no match),
// launches the app, and reports:
//   - add: time from addPaths() until the list is painted
//   - scroll: frame times while scrolling the list by script
//   - fetch / rename: wall time, frame times, and renderer long tasks while
//     main streams one progress event per file
//   - burst: renderer cost of N progress events sent back to back from main
// Opens one app window on the screen while it runs, and closes it at the end.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import electronPath from "electron";
import { _electron } from "playwright-core";

const { values: args } = parseArgs({
  options: { files: { type: "string", default: "10000" }, out: { type: "string" } },
});
const N = Number(args.files);
const APP_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(APP_DIR, "out-e2e", "main", "index.js");

const tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-measure-"));
const configDir = path.join(tmp, "config");
const mediaDir = path.join(tmp, "media");
await mkdir(configDir, { recursive: true });
await mkdir(mediaDir, { recursive: true });
await writeFile(
  path.join(configDir, "config.toml"),
  '[api]\ntmdb_api_key = "e2e-not-a-real-key"\ntvdb_api_key = "e2e-not-a-real-key"\n',
);

// Half "Inception" (one fake match, each in its own folder so the new names
// do not collide), every tenth with a subtitle; half with no match.
const writes = [];
for (let i = 0; i < N; i++) {
  const n = String(i).padStart(5, "0");
  if (i % 2 === 0) {
    const dir = path.join(mediaDir, `Inception ${n}`);
    writes.push(
      mkdir(dir).then(async () => {
        await writeFile(path.join(dir, "Inception.2010.720p.WEB-DL.mkv"), "");
        if (i % 20 === 0) await writeFile(path.join(dir, "Inception.2010.720p.WEB-DL.en.srt"), "");
      }),
    );
  } else {
    writes.push(writeFile(path.join(mediaDir, `Unknown.Film.${n}.2021.1080p.BluRay.x264.mkv`), ""));
  }
  if (writes.length >= 500) await Promise.all(writes.splice(0));
}
await Promise.all(writes);

const electronApp = await _electron.launch({
  executablePath: electronPath,
  args: [MAIN],
  cwd: APP_DIR,
  env: { ...process.env, TIDYTITLES_E2E: "1", TIDYTITLES_CONFIG_DIR: configDir, ELECTRON_RUN_AS_NODE: "" },
});
const results = { files: N, date: new Date().toISOString() };
try {
  const page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1180, 720);
    win.center();
  });
  await page.waitForSelector(".app:not(.app-loading)");

  // Instrumentation in the renderer.
  await page.evaluate(() => {
    const m = (window.__measure = { longTasks: [], progress: 0 });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) m.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: false });
    window.tidytitles.onProgress((p) => {
      if (p) m.progress += 1;
    });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    m.settle = async () => {
      await frame();
      await new Promise((r) => setTimeout(r, 0));
      await frame();
    };
    m.longTaskSum = (from, to) =>
      m.longTasks.filter((t) => t.start >= from && t.start < to).reduce((s, t) => s + t.duration, 0);
    m.stats = (deltas) => {
      const sorted = [...deltas].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
      const round = (x) => Math.round(x * 10) / 10;
      return {
        frames: deltas.length,
        meanMs: round(deltas.reduce((s, d) => s + d, 0) / Math.max(1, deltas.length)),
        p50Ms: round(q(0.5)),
        p95Ms: round(q(0.95)),
        maxMs: round(sorted.at(-1) ?? 0),
        over20ms: deltas.filter((d) => d > 20).length,
        over50ms: deltas.filter((d) => d > 50).length,
      };
    };
    /** Record frame deltas until `done` resolves. */
    m.recordFrames = async (done) => {
      const deltas = [];
      let last = performance.now();
      let running = true;
      const loop = () => {
        if (!running) return;
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      await done;
      running = false;
      return deltas.slice(1);
    };
    m.dom = () => ({
      rowsInDom: document.querySelectorAll('[data-testid="file-row"]').length,
      domNodes: document.getElementsByTagName("*").length,
    });
  });

  // --- add -----------------------------------------------------------------
  results.add = await page.evaluate(async (dir) => {
    const m = window.__measure;
    await window.tidytitles.setOptions({ recursive: true });
    const t0 = performance.now();
    const result = await window.tidytitles.addPaths([dir]);
    const tIpc = performance.now();
    // The state event follows the reply; wait for the list to show it.
    await new Promise((resolve) => {
      const check = () => {
        if (document.querySelector('[data-testid="file-row"]') && document.querySelector('[data-testid="status-message"]')?.textContent?.includes("Added")) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
    await m.settle();
    const t1 = performance.now();
    return {
      added: result.added,
      mainScanMs: Math.round(tIpc - t0),
      totalMs: Math.round(t1 - t0),
      rendererLongTaskMs: Math.round(m.longTaskSum(t0, t1)),
      ...m.dom(),
    };
  }, mediaDir);
  console.log("add", results.add);

  const scroll = (label) =>
    page.evaluate(async () => {
      const m = window.__measure;
      const el = document.querySelector('[data-testid="file-table"]');
      el.scrollTop = 0;
      await m.settle();
      const t0 = performance.now();
      // Smooth: 60px per frame for 300 frames. Jumps: 60 random positions (like dragging the scrollbar).
      const smooth = await m.recordFrames(
        new Promise((resolve) => {
          let i = 0;
          const step = () => {
            if (i++ >= 300) return resolve();
            el.scrollTop += 60;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
      );
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const jumps = await m.recordFrames(
        new Promise((resolve) => {
          let i = 0;
          const step = () => {
            if (i++ >= 60) return resolve();
            el.scrollTop = rand() * (el.scrollHeight - el.clientHeight);
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
      );
      const t1 = performance.now();
      const out = {
        smooth: m.stats(smooth),
        jumps: m.stats(jumps),
        rendererLongTaskMs: Math.round(m.longTaskSum(t0, t1)),
        scrollHeight: el.scrollHeight,
        ...m.dom(),
      };
      el.scrollTop = 0;
      await m.settle();
      return out;
    }).then((r) => {
      console.log(label, r);
      return r;
    });

  results.scrollBeforeFetch = await scroll("scroll (not fetched)");

  const run = (label, action) =>
    page.evaluate(async (action) => {
      const m = window.__measure;
      m.progress = 0;
      const t0 = performance.now();
      let outcome;
      const done = window.tidytitles[action]().then(async (o) => {
        outcome = o;
        await m.settle();
      });
      const deltas = await m.recordFrames(done);
      const t1 = performance.now();
      return {
        outcome: outcome.kind,
        progressEvents: m.progress,
        totalMs: Math.round(t1 - t0),
        rendererLongTaskMs: Math.round(m.longTaskSum(t0, t1)),
        frames: m.stats(deltas),
        ...m.dom(),
      };
    }, action).then((r) => {
      console.log(label, r);
      return r;
    });

  results.fetch = await run("fetch", "fetch");
  results.scrollAfterFetch = await scroll("scroll (fetched)");

  // --- burst of progress events from main, while idle -----------------------
  const burst = page.evaluate(async (n) => {
    const m = window.__measure;
    m.progress = 0;
    let t0 = 0;
    await new Promise((resolve) => {
      const off = window.tidytitles.onProgress(() => {
        if (t0 === 0) t0 = performance.now();
        if (m.progress >= n) {
          off();
          resolve();
        }
      });
      window.__burstReady = true;
    });
    const tLast = performance.now();
    await m.settle();
    const t1 = performance.now();
    return {
      events: m.progress,
      deliverMs: Math.round(tLast - t0),
      totalMs: Math.round(t1 - t0),
      rendererLongTaskMs: Math.round(m.longTaskSum(t0 - 1, t1)),
    };
  }, N);
  await page.waitForFunction(() => window.__burstReady === true);
  await electronApp.evaluate(({ BrowserWindow }, n) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    for (let i = 1; i <= n; i++) {
      wc.send("event:progress", { phase: "fetch", current: i, total: n, message: `Fetching: file ${i}` });
    }
  }, N);
  results.burst = await burst;
  console.log("burst", results.burst);
  // Clear the progress the burst left behind.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("event:progress", null);
  });

  results.rename = await run("rename", "rename");
} finally {
  await electronApp.close();
  await rm(tmp, { recursive: true, force: true });
}

if (args.out) {
  await writeFile(args.out, JSON.stringify(results, null, 2));
  console.log(`Wrote ${args.out}`);
}
