/**
 * Main-process entry of the END-TO-END TEST BUILD (`electron-vite build
 * --mode e2e`, output `out-e2e/`). Runs the real app with fake metadata
 * providers and no network. Never packaged: electron-builder only ships `out/`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { startApp } from "../main/app";
import type { UpdateCapability } from "../shared/ipc";
import { CONFIG_DIR_ENV } from "../main/configDir";
import { ScriptedUpdateEngine } from "./fakeUpdates";
import { createFakeSessionOverrides, fakeFetch } from "./fakes";

const configDir = process.env[CONFIG_DIR_ENV];
if (process.env.TIDYTITLES_E2E !== "1" || !configDir) {
  console.error(`The e2e build needs TIDYTITLES_E2E=1 and ${CONFIG_DIR_ENV} set to a temporary directory.`);
  process.exit(1);
}

// Keep window state and Chromium data out of the real userData directory.
app.setPath("userData", path.join(configDir, "electron-user-data"));
// Anything that slips past the overrides must not reach the network either.
globalThis.fetch = fakeFetch;

// Updates are off unless a test asks for the scripted engine (never electron-updater).
// "1": a copy that installs updates itself; "unsigned": one that offers a download.
let updates: "off" | { engine: ScriptedUpdateEngine; capability: UpdateCapability; currentVersion: string } = "off";
const fakeUpdates = process.env.TIDYTITLES_E2E_FAKE_UPDATES;
if (fakeUpdates === "1" || fakeUpdates === "unsigned") {
  const engine = new ScriptedUpdateEngine();
  globalThis.__tidytitlesFakeUpdates = engine;
  // Unpackaged, app.getVersion() is Electron's version; use the app's own.
  const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
  updates = {
    engine,
    capability: fakeUpdates === "1" ? { kind: "self" } : { kind: "manual", reason: "unsigned" },
    currentVersion: pkg.version,
  };
}

startApp({ sessionOverrides: createFakeSessionOverrides(), updates });
