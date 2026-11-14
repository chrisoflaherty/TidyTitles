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
import type { FeedbackNotification } from "../main/taskFeedback";

/** What the e2e build records instead of notifying (read by the tests through `electronApp.evaluate`). */
export interface TidyTitlesE2eFeedback {
  notifications: FeedbackNotification[];
  attention: number;
  /** What the app sees as window focus. */
  focused: boolean;
}

declare global {
  var __tidytitlesE2eFeedback: TidyTitlesE2eFeedback | undefined;
}

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

// Never a real notification, Dock bounce, or taskbar flash: record them for
// the tests. The window counts as focused unless a test says otherwise.
const feedback: TidyTitlesE2eFeedback = { notifications: [], attention: 0, focused: true };
globalThis.__tidytitlesE2eFeedback = feedback;

startApp({
  sessionOverrides: createFakeSessionOverrides(),
  updates,
  feedback: {
    notify: (notification) => void feedback.notifications.push(notification),
    requestAttention: () => {
      feedback.attention += 1;
    },
    isFocused: () => feedback.focused,
  },
});
