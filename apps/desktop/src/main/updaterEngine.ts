/**
 * The real update engine: electron-updater behind the `UpdateEngine`
 * interface of `updater.ts`, plus the checks that decide whether this copy
 * can install updates itself.
 *
 * electron-updater is bundled into the main bundle like every other
 * dependency (the package ships no node_modules). It reads
 * `resources/app-update.yml` (written by electron-builder from the `publish`
 * setting) only for its cache folder name; the feed is set here explicitly.
 *
 * Feed policy (electron-updater 6, `GitHubProvider.getLatestVersion`):
 * - A prerelease app (0.2.0-beta.3) sets `allowPrerelease`, reads the
 *   releases Atom feed, and takes the newest release that is stable or
 *   alpha/beta (never alpha when it is on beta). For a beta tag it asks for
 *   `beta-mac.yml` / `beta.yml` / `beta-linux.yml` (falling back to the
 *   `latest*` file only on error); for a stable tag it asks for the `latest*`
 *   file. electron-builder.yml publishes with `channel: ${channel}`, so a beta
 *   build writes the `beta*` files and a stable build the `latest*` files.
 * - A stable app reads `/releases/latest` (GitHub never returns a
 *   prerelease there) and asks for the `latest*` file. So it is offered only
 *   stable versions.
 * Downgrades are off (`allowDowngrade = false`, and no `channel` is set,
 * because setting one turns downgrades on).
 */

import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { AppUpdater, autoUpdater, type Logger } from "electron-updater";
import type { UpdateErrorKind } from "../shared/ipc";
import { isPrerelease, parseCodesignDisplay, type MacSignature, type UpdateEngine } from "./updater";

export const GITHUB_FEED = { provider: "github", owner: "chrisoflaherty", repo: "TidyTitles" } as const;

export type FeedOptions = typeof GITHUB_FEED | { provider: "generic"; url: string; channel?: string };

/** Only for the local end-to-end update test; the shipped build sets this to null at build time. */
export function testFeedFromBuild(value: string | null | undefined): FeedOptions | null {
  if (!value) return null;
  // Never anything but a local server.
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(value)) return null;
  return { provider: "generic", url: value };
}

/**
 * An updater that only checks: used when this copy cannot install updates
 * (ad-hoc signed on macOS, not an AppImage on Linux). It never downloads.
 */
class CheckOnlyUpdater extends AppUpdater {
  constructor() {
    super(null);
  }
  protected doDownloadUpdate(): never {
    throw new Error("This copy of the app cannot install updates");
  }
  quitAndInstall(): void {
    // Nothing to install.
  }
}

const NETWORK_ERROR = /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED|ABORTED)|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TIMED_OUT|NETWORK_ACCESS_DENIED)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/;

/** electron-updater error codes (`newError(message, code)`) and Chromium network errors. */
export function classifyUpdaterError(error: unknown): UpdateErrorKind {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const status = typeof error === "object" && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (
    code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" ||
    code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" ||
    code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" ||
    status === 404
  ) {
    return "notFound";
  }
  if (typeof code === "string" && NETWORK_ERROR.test(code)) return "offline";
  if (NETWORK_ERROR.test(message)) return "offline";
  if (/timed? ?out/i.test(message)) return "timeout";
  return "unknown";
}

export interface EngineOptions {
  /** "self": download and install; "check": only look for new versions. */
  mode: "self" | "check";
  feed: FeedOptions;
  logger?: Logger;
}

export function createElectronUpdateEngine(options: EngineOptions): UpdateEngine {
  const updater: AppUpdater = options.mode === "self" ? autoUpdater : new CheckOnlyUpdater();
  updater.logger = options.logger ?? prefixedConsole();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = isPrerelease(updater.currentVersion.version);
  updater.allowDowngrade = false;
  updater.fullChangelog = false;
  updater.disableWebInstaller = true;
  // The generic (test) feed reads "<channel>-mac.yml"; give it the channel the
  // GitHub provider would use for a release of this kind ("beta").
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(updater.currentVersion.version)?.[1];
  updater.setFeedURL(
    options.feed.provider === "generic" && prerelease ? { ...options.feed, channel: prerelease } : options.feed,
  );

  let checking = false;
  let downloading = false;
  /** Set when electron-updater reported the file as downloaded (Squirrel.Mac then verifies it). */
  let downloaded = false;
  const installErrorListeners: ((error: unknown) => void)[] = [];
  const installStageErrors = new WeakSet<object>();

  updater.on("update-downloaded", () => {
    downloaded = true;
  });
  updater.on("error", (error: unknown) => {
    // Errors of a check or download reject their promise; the rest come from installing.
    if (checking || downloading) return;
    for (const listener of installErrorListeners) listener(error);
  });

  return {
    async check() {
      checking = true;
      try {
        const result = await updater.checkForUpdates();
        if (!result) throw new Error("The updater is not active in this copy of the app");
        return { version: result.updateInfo.version, available: result.isUpdateAvailable };
      } finally {
        checking = false;
      }
    },
    async download(onProgress) {
      downloading = true;
      downloaded = false;
      const progress = (info: { percent: number }) => onProgress(info.percent);
      updater.on("download-progress", progress);
      try {
        await updater.downloadUpdate();
      } catch (error) {
        if (downloaded && typeof error === "object" && error !== null) installStageErrors.add(error);
        throw error;
      } finally {
        updater.off("download-progress", progress);
        downloading = false;
      }
    },
    quitAndInstall() {
      // Silent on Windows (no installer pages), then start the new version.
      updater.quitAndInstall(true, true);
    },
    onInstallError(listener) {
      installErrorListeners.push(listener);
    },
    classifyError: classifyUpdaterError,
    isInstallError: (error) => typeof error === "object" && error !== null && installStageErrors.has(error),
  };
}

function prefixedConsole(): Logger {
  return {
    info: (message?: unknown) => console.log("[updater]", message),
    warn: (message?: unknown) => console.warn("[updater]", message),
    error: (message?: unknown) => console.error("[updater]", message),
  };
}

// ---------------------------------------------------------------------------
// What this copy can do
// ---------------------------------------------------------------------------

/** The `.app` bundle that contains the running executable. */
export function macBundlePath(execPath: string): string {
  return path.resolve(execPath, "..", "..", "..");
}

export function readMacSignature(bundle: string, timeoutMs = 10_000): Promise<MacSignature> {
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["--display", "--verbose=2", bundle], { timeout: timeoutMs }, (error, stdout, stderr) => {
      const text = `${String(stdout ?? "")}\n${String(stderr ?? "")}`;
      const parsed = parseCodesignDisplay(text);
      resolve(error && parsed === "unknown" ? "unknown" : parsed);
    });
  });
}

/**
 * Squirrel.Mac installs an update by swapping the whole bundle within its
 * folder, so that folder must be writable and the app must not be
 * translocated.
 *
 * Only the folder is checked, never the bundle itself: macOS refuses a
 * notarized app write access to its own bundle (EPERM, even for the owner),
 * yet still lets the bundle be replaced. Checking the bundle would report
 * every properly installed copy as unable to update.
 */
export async function readMacLocation(bundle: string): Promise<"ok" | "translocated" | "readOnly"> {
  if (bundle.includes("/AppTranslocation/")) return "translocated";
  try {
    await access(path.dirname(bundle), constants.W_OK);
    return "ok";
  } catch {
    return "readOnly";
  }
}

export function hasUpdateConfig(resourcesPath: string | undefined): boolean {
  return Boolean(resourcesPath) && existsSync(path.join(resourcesPath!, "app-update.yml"));
}
