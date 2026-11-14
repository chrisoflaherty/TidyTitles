/**
 * Automatic updates: the state machine behind "Check for Updates…", the
 * download in the background, and "Restart to Update".
 *
 * No Electron imports: the real engine (electron-updater) is wrapped in
 * `updaterEngine.ts` behind the `UpdateEngine` interface, and tests drive
 * this module with a fake engine and fake timers.
 *
 * Rules this module enforces:
 * - An automatic check that fails is silent; a check the user asked for
 *   always reports its outcome.
 * - A feed version that is not newer than the running one is ignored.
 * - A restart never happens while a fetch, rename, or undo is running.
 * - A failed download or install falls back, for the rest of the session,
 *   to offering the release page. Nothing retries in a loop: the next try is
 *   the next periodic check, and after a failure those only check.
 */

import type {
  ManualUpdateReason,
  RestartToUpdateResult,
  UpdateCapability,
  UpdateErrorKind,
  UpdateState,
  UpdateStatus,
} from "../shared/ipc";

export const RELEASES_URL = "https://github.com/chrisoflaherty/TidyTitles/releases";

/** What the controller needs from an updater. */
export interface UpdateEngine {
  /**
   * Ask the feed for its newest version. `available` is the engine's own
   * verdict (newer than the running version and installable on this system).
   */
  check(): Promise<{ version: string; available: boolean }>;
  /** Download the version found by the last check. Resolves when it is ready to install. */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Quit, install the downloaded version, and relaunch. */
  quitAndInstall(): void;
  /** Errors that happen outside `check` and `download` (installing). */
  onInstallError(listener: (error: unknown) => void): void;
  /** Map an error from this engine to a kind the UI can explain. */
  classifyError(error: unknown): UpdateErrorKind;
  /** Whether a rejected `download` failed while preparing the install (not while downloading). */
  isInstallError?(error: unknown): boolean;
}

export interface UpdateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdateControllerOptions {
  /** Null when updates are off. */
  engine: UpdateEngine | null;
  capability: UpdateCapability;
  currentVersion: string;
  autoCheck: boolean;
  saveAutoCheck: (enabled: boolean) => void | Promise<void>;
  /** True when no fetch, rename, undo, or save is running. */
  isIdle: () => boolean;
  emit: (state: UpdateState) => void;
  timers?: UpdateTimers;
  /** Delay of the first automatic check after launch. */
  initialDelayMs?: number;
  /** Time between automatic checks. */
  intervalMs?: number;
  /** A check that takes longer than this fails with "timeout". */
  checkTimeoutMs?: number;
  /** A download with no progress for this long fails. */
  downloadStallMs?: number;
}

export const DEFAULT_INITIAL_DELAY_MS = 15_000;
export const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_STALL_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether a string is a version the release page can be built from. */
export function isVersion(value: string): boolean {
  return SEMVER.test(value);
}

/** Semantic-version precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new Error(`Not a version: ${!ma ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  // A version without a prerelease part ranks above one with it.
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return SEMVER.exec(version)?.[4] !== undefined;
}

/** The release page for a version, or the releases list when it is unknown. */
export function releasePageUrl(version?: string): string {
  if (version && isVersion(version)) return `${RELEASES_URL}/tag/v${version.replace(/^v/, "")}`;
  return RELEASES_URL;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export interface CapabilityInputs {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  /** `resources/app-update.yml` exists (written by electron-builder for installable targets). */
  hasUpdateConfig: boolean;
  /** Test builds: updates are off. */
  testBuild?: boolean;
  /** macOS: the bundle's code signature. */
  macSignature?: MacSignature;
  /** macOS: whether the bundle is somewhere it can be replaced. */
  macLocation?: "ok" | "translocated" | "readOnly";
}

export type MacSignature = "developerId" | "adhoc" | "unsigned" | "unknown";

/**
 * Decide how this copy updates. The order matters: "off" first, then the
 * platform conditions (which give the most useful explanation), then the
 * update configuration.
 */
export function resolveUpdateCapability(i: CapabilityInputs): UpdateCapability {
  if (i.env.TIDYTITLES_DISABLE_UPDATES === "1") return { kind: "off", reason: "disabled" };
  if (i.testBuild) return { kind: "off", reason: "test" };
  if (!i.isPackaged) return { kind: "off", reason: "development" };
  if (i.platform === "darwin") {
    if (i.macSignature !== "developerId") return { kind: "manual", reason: "unsigned" };
    if (i.macLocation !== "ok") return { kind: "manual", reason: "location" };
  }
  if (i.platform === "linux" && !i.env.APPIMAGE) return { kind: "manual", reason: "notAppImage" };
  if (!i.hasUpdateConfig) return { kind: "manual", reason: "noUpdateConfig" };
  return { kind: "self" };
}

/**
 * Read `codesign --display --verbose=2` output (it is written to stderr).
 * Squirrel.Mac only installs an update whose signature satisfies the running
 * app's designated requirement; an ad-hoc signature (no team) never does.
 */
export function parseCodesignDisplay(output: string): MacSignature {
  if (/not signed at all/i.test(output)) return "unsigned";
  if (/^Signature=adhoc\s*$/m.test(output)) return "adhoc";
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  if (team && team !== "not set") return "developerId";
  if (/^Identifier=/m.test(output)) return "adhoc";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor() {
    super("Timed out");
    this.name = "UpdateTimeoutError";
  }
}

const realTimers: UpdateTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Never keep the process alive for a scheduled check.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class UpdateController {
  private readonly engine: UpdateEngine | null;
  private capability: UpdateCapability;
  private readonly currentVersion: string;
  private autoCheck: boolean;
  private readonly saveAutoCheckFn: UpdateControllerOptions["saveAutoCheck"];
  private readonly isIdle: () => boolean;
  private readonly emitFn: (state: UpdateState) => void;
  private readonly timers: UpdateTimers;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly checkTimeoutMs: number;
  private readonly downloadStallMs: number;

  private status: UpdateStatus = { kind: "idle" };
  /** What to go back to when an automatic check fails or finds nothing. */
  private resting: UpdateStatus = { kind: "idle" };
  private manual = false;
  private checkId = 0;
  private busy = false;
  private timer: unknown = null;
  private started = false;
  private installing = false;
  private disposed = false;

  constructor(options: UpdateControllerOptions) {
    this.engine = options.capability.kind === "off" ? null : options.engine;
    this.capability = this.engine ? options.capability : offCapability(options.capability);
    this.currentVersion = options.currentVersion;
    this.autoCheck = options.autoCheck;
    this.saveAutoCheckFn = options.saveAutoCheck;
    this.isIdle = options.isIdle;
    this.emitFn = options.emit;
    this.timers = options.timers ?? realTimers;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.downloadStallMs = options.downloadStallMs ?? DEFAULT_DOWNLOAD_STALL_MS;
    this.engine?.onInstallError(() => this.installFailed());
  }

  getState(): UpdateState {
    return {
      status: { ...this.status },
      capability: { ...this.capability },
      currentVersion: this.currentVersion,
      autoCheck: this.autoCheck,
      manual: this.manual,
      checkId: this.checkId,
    };
  }

  /** Schedule the first automatic check (when automatic checks are on). */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.autoCheck) this.schedule(this.initialDelayMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** Check now. `manual`: the user asked, so the outcome is reported. */
  async check({ manual }: { manual: boolean }): Promise<void> {
    if (this.disposed) return;
    if (manual) {
      this.manual = true;
      // Already checking or downloading: the running work reports to the user.
      // Already downloaded: nothing to check.
      if (this.busy || this.status.kind === "ready") {
        this.emit();
        return;
      }
    } else if (this.busy || this.status.kind === "ready") {
      return;
    }
    if (!this.engine) {
      // Updates are off; the UI explains why from `capability`.
      this.emit();
      return;
    }

    this.clearTimer();
    this.busy = true;
    this.checkId += 1;
    if (!manual) this.manual = false;
    this.setStatus({ kind: "checking" });
    try {
      let result: { version: string; available: boolean };
      try {
        result = await this.withTimeout(this.engine.check(), this.checkTimeoutMs);
      } catch (error) {
        this.checkFailed(error);
        return;
      }
      if (this.disposed) return;

      const newer = result.available && isVersion(result.version) && compareVersions(result.version, this.currentVersion) > 0;
      if (!newer) {
        this.resting = { kind: "idle" };
        this.setStatus(this.manual ? { kind: "upToDate" } : { kind: "idle" });
        return;
      }

      if (this.capability.kind === "manual") {
        this.offerDownload(result.version, this.capability.reason);
        return;
      }

      await this.download(result.version);
    } finally {
      this.busy = false;
      if (!this.disposed && !this.isReady() && this.autoCheck && this.started) this.schedule(this.intervalMs);
    }
  }

  /** Restart into the downloaded version, only when the app is idle. */
  restartToUpdate(): RestartToUpdateResult {
    if (this.status.kind !== "ready" || !this.engine || this.installing) return "notReady";
    if (!this.isIdle()) return "busy";
    this.installing = true;
    try {
      this.engine.quitAndInstall();
    } catch {
      this.installFailed();
      return "notReady";
    }
    return "restarting";
  }

  async setAutoCheck(enabled: boolean): Promise<void> {
    if (enabled === this.autoCheck) return;
    this.autoCheck = enabled;
    try {
      await this.saveAutoCheckFn(enabled);
    } catch {
      // The setting still applies to this session.
    }
    if (!enabled) this.clearTimer();
    else if (this.started && !this.busy && this.status.kind !== "ready") this.schedule(this.initialDelayMs);
    this.emit();
  }

  /** The page to open for "Download" or "Open Releases Page". */
  releasePageUrl(): string {
    const s = this.status.kind === "unsupported" || this.status.kind === "ready" || this.status.kind === "downloading" ? this.status : this.resting;
    return releasePageUrl("version" in s ? s.version : undefined);
  }

  // -------------------------------------------------------------------------

  private async download(version: string): Promise<void> {
    const engine = this.engine!;
    this.setStatus({ kind: "downloading", version, percent: null });
    let stall: unknown = null;
    let rejectStall: (error: Error) => void = () => {};
    const stalled = new Promise<never>((_, reject) => {
      rejectStall = reject;
    });
    const armStall = () => {
      if (stall !== null) this.timers.clearTimeout(stall);
      stall = this.timers.setTimeout(() => rejectStall(new TimeoutError()), this.downloadStallMs);
    };
    armStall();
    try {
      await Promise.race([
        engine.download((percent) => {
          armStall();
          if (this.status.kind !== "downloading") return;
          const rounded = Math.max(0, Math.min(100, Math.round(percent)));
          if (rounded !== this.status.percent) this.setStatus({ kind: "downloading", version, percent: rounded });
        }),
        stalled,
      ]);
      if (this.disposed) return;
      this.resting = { kind: "idle" };
      this.setStatus({ kind: "ready", version });
    } catch (error) {
      if (this.disposed) return;
      const installStage = engine.isInstallError?.(error) ?? false;
      this.capability = { kind: "manual", reason: installStage ? "installFailed" : "downloadFailed" };
      this.offerDownload(version, this.capability.reason);
    } finally {
      if (stall !== null) this.timers.clearTimeout(stall);
    }
  }

  private isReady(): boolean {
    return this.status.kind === "ready";
  }

  private offerDownload(version: string, reason: ManualUpdateReason): void {
    const status: UpdateStatus = { kind: "unsupported", version, reason };
    this.resting = status;
    this.setStatus(status);
  }

  private checkFailed(error: unknown): void {
    if (this.manual) {
      const kind = error instanceof TimeoutError ? "timeout" : this.engine!.classifyError(error);
      this.setStatus({ kind: "error", error: kind });
    } else {
      // Automatic and offline (or anything else): say nothing.
      this.setStatus(this.resting);
    }
  }

  /** The system updater rejected the update (or the installer could not start). */
  private installFailed(): void {
    if (this.disposed) return;
    this.installing = false;
    const version = "version" in this.status ? this.status.version : "version" in this.resting ? this.resting.version : undefined;
    this.capability = { kind: "manual", reason: "installFailed" };
    if (version) this.offerDownload(version, "installFailed");
    else this.emit();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.timers.setTimeout(() => reject(new TimeoutError()), ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(handle);
          resolve(value);
        },
        (error: unknown) => {
          this.timers.clearTimeout(handle);
          reject(error);
        },
      );
    });
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (this.disposed || !this.engine) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.check({ manual: false });
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.emitFn(this.getState());
  }
}

function offCapability(capability: UpdateCapability): UpdateCapability {
  return capability.kind === "off" ? capability : { kind: "off", reason: "disabled" };
}
