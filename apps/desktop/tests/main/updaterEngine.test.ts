import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreferences, parsePreferences, savePreferences } from "../../src/main/preferences";
import {
  classifyUpdaterError,
  hasUpdateConfig,
  macBundlePath,
  readMacLocation,
  testFeedFromBuild,
} from "../../src/main/updaterEngine";
import { IpcValidationError, parseEnabled } from "../../src/main/validate";

function updaterError(message: string, code?: string) {
  return Object.assign(new Error(message), code ? { code } : {});
}

describe("classifyUpdaterError", () => {
  it("maps electron-updater codes and network errors to plain kinds", () => {
    expect(classifyUpdaterError(updaterError("Cannot find beta-mac.yml", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"))).toBe("notFound");
    expect(classifyUpdaterError(updaterError("Unable to find latest version", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"))).toBe("notFound");
    expect(classifyUpdaterError(updaterError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS"))).toBe("notFound");
    expect(classifyUpdaterError(Object.assign(new Error("HttpError: 404"), { statusCode: 404 }))).toBe("notFound");
    expect(classifyUpdaterError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("offline");
    expect(classifyUpdaterError(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe("offline");
    expect(classifyUpdaterError(updaterError("getaddrinfo", "ENOTFOUND"))).toBe("offline");
    expect(classifyUpdaterError(new Error("Request timed out"))).toBe("timeout");
    expect(classifyUpdaterError(new Error("sha512 checksum mismatch"))).toBe("unknown");
    expect(classifyUpdaterError("weird")).toBe("unknown");
  });
});

describe("test feed", () => {
  it("accepts only a local server, and nothing in a normal build", () => {
    expect(testFeedFromBuild(null)).toBeNull();
    expect(testFeedFromBuild(undefined)).toBeNull();
    expect(testFeedFromBuild("http://127.0.0.1:8765/")).toEqual({ provider: "generic", url: "http://127.0.0.1:8765/" });
    expect(testFeedFromBuild("http://localhost:9000")).toEqual({ provider: "generic", url: "http://localhost:9000" });
    expect(testFeedFromBuild("https://example.com/feed/")).toBeNull();
    expect(testFeedFromBuild("http://127.0.0.1.example.com:80/")).toBeNull();
  });
});

describe("package inspection", () => {
  it("finds the .app bundle from the executable path", () => {
    const exe = path.join(path.sep, "Applications", "TidyTitles.app", "Contents", "MacOS", "TidyTitles");
    expect(macBundlePath(exe)).toBe(path.resolve(path.sep, "Applications", "TidyTitles.app"));
  });

  it("looks for app-update.yml in the resources folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-updates-"));
    try {
      expect(hasUpdateConfig(dir)).toBe(false);
      expect(hasUpdateConfig(undefined)).toBe(false);
      await writeFile(path.join(dir, "app-update.yml"), "provider: github\n");
      expect(hasUpdateConfig(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("preferences", () => {
  it("defaults to checking automatically and survives a bad file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-prefs-"));
    const file = path.join(dir, "nested", "preferences.json");
    try {
      expect(await loadPreferences(file)).toEqual({ autoCheckForUpdates: true });
      savePreferences(file, { autoCheckForUpdates: false });
      expect(await loadPreferences(file)).toEqual({ autoCheckForUpdates: false });
      await writeFile(file, "{not json");
      expect(await loadPreferences(file)).toEqual({ autoCheckForUpdates: true });
      expect(parsePreferences({ autoCheckForUpdates: "no" })).toEqual({ autoCheckForUpdates: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("IPC validation", () => {
  it("accepts only a boolean for the setting", () => {
    expect(parseEnabled(true)).toBe(true);
    expect(parseEnabled(false)).toBe(false);
    expect(() => parseEnabled("true")).toThrow(IpcValidationError);
    expect(() => parseEnabled(undefined)).toThrow(IpcValidationError);
  });
});

describe("readMacLocation", () => {
  // File modes are not enforced on Windows, or for root.
  const modesEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

  it("reports a translocated app", async () => {
    expect(await readMacLocation("/private/var/folders/x/AppTranslocation/ABC/d/TidyTitles.app")).toBe("translocated");
  });

  it.skipIf(!modesEnforced)(
    "is ok when the folder is writable even though the bundle itself is not (as macOS reports for a notarized app)",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-location-"));
      const bundle = path.join(dir, "TidyTitles.app");
      await mkdir(bundle);
      await chmod(bundle, 0o555);
      try {
        expect(await readMacLocation(bundle)).toBe("ok");
      } finally {
        await chmod(bundle, 0o755);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!modesEnforced)("is readOnly when the folder that contains the app cannot be written", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-location-"));
    const bundle = path.join(dir, "TidyTitles.app");
    await mkdir(bundle);
    await chmod(dir, 0o555);
    try {
      expect(await readMacLocation(bundle)).toBe("readOnly");
    } finally {
      await chmod(dir, 0o755);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
