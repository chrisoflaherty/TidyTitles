// Renders build/icon.svg to build/icon.png (1024 x 1024) with Electron's own
// Chromium, then builds build/icon.icns with sips + iconutil on macOS.
// Run with: npm run icons   (electron scripts/render-icon.mjs)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";

const buildDir = path.resolve(import.meta.dirname, "..", "build");
const svg = readFileSync(path.join(buildDir, "icon.svg"), "utf8");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

// No top-level await before "ready": Electron fires it after the ESM entry finishes evaluating.
app.whenReady().then(async () => {
const win = new BrowserWindow({
  width: 1024,
  height: 1024,
  show: false,
  frame: false,
  transparent: true,
  webPreferences: { offscreen: true, sandbox: true },
});
const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
await new Promise((r) => setTimeout(r, 300));
const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
const png = image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
writeFileSync(path.join(buildDir, "icon.png"), png);
console.log("wrote build/icon.png");

if (process.platform === "darwin") {
  const iconset = path.join(buildDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", ["-z", String(px), String(px), path.join(buildDir, "icon.png"), "--out", path.join(iconset, name)], { stdio: "ignore" });
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(buildDir, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("wrote build/icon.icns");
}
app.quit();
});
