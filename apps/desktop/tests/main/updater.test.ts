import { describe, expect, it, vi } from "vitest";
import {
  RELEASES_URL,
  UpdateController,
  compareVersions,
  isPrerelease,
  parseCodesignDisplay,
  releasePageUrl,
  resolveUpdateCapability,
  type UpdateEngine,
  type UpdateTimers,
} from "../../src/main/updater";
import type { UpdateCapability, UpdateErrorKind, UpdateState } from "../../src/shared/ipc";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeTimers implements UpdateTimers {
  now = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Delays still scheduled, relative to now. */
  get scheduled(): number[] {
    return [...this.pending.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

class EngineError extends Error {
  constructor(
    readonly kind: UpdateErrorKind,
    readonly installStage = false,
  ) {
    super(kind);
  }
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

class FakeEngine implements UpdateEngine {
  checks = 0;
  downloads = 0;
  installs = 0;
  check$: Deferred<{ version: string; available: boolean }> | null = null;
  download$: (Deferred<void> & { progress: (p: number) => void }) | null = null;
  private installListeners: ((e: unknown) => void)[] = [];

  check() {
    this.checks += 1;
    return new Promise<{ version: string; available: boolean }>((resolve, reject) => {
      this.check$ = { resolve, reject };
    });
  }
  download(progress: (p: number) => void) {
    this.downloads += 1;
    return new Promise<void>((resolve, reject) => {
      this.download$ = { resolve, reject, progress };
    });
  }
  quitAndInstall() {
    this.installs += 1;
  }
  onInstallError(listener: (e: unknown) => void) {
    this.installListeners.push(listener);
  }
  classifyError(error: unknown): UpdateErrorKind {
    return error instanceof EngineError ? error.kind : "unknown";
  }
  isInstallError(error: unknown) {
    return error instanceof EngineError && error.installStage;
  }
  // test helpers
  async found(version: string, available = true) {
    this.check$!.resolve({ version, available });
    this.check$ = null;
    await flush();
  }
  async checkFails(kind: UpdateErrorKind) {
    this.check$!.reject(new EngineError(kind));
    this.check$ = null;
    await flush();
  }
  async progress(p: number) {
    this.download$!.progress(p);
    await flush();
  }
  async downloaded() {
    this.download$!.resolve();
    this.download$ = null;
    await flush();
  }
  async downloadFails(installStage = false) {
    this.download$!.reject(new EngineError("offline", installStage));
    this.download$ = null;
    await flush();
  }
  installError() {
    for (const l of this.installListeners) l(new Error("rejected"));
  }
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const CURRENT = "0.2.0-beta.2";

function setup(
  over: {
    capability?: UpdateCapability;
    autoCheck?: boolean;
    idle?: boolean;
    engine?: FakeEngine | null;
  } = {},
) {
  const engine = over.engine === undefined ? new FakeEngine() : over.engine;
  const timers = new FakeTimers();
  const states: UpdateState[] = [];
  const saved: boolean[] = [];
  let idle = over.idle ?? true;
  const controller = new UpdateController({
    engine,
    capability: over.capability ?? { kind: "self" },
    currentVersion: CURRENT,
    autoCheck: over.autoCheck ?? true,
    saveAutoCheck: (v) => {
      saved.push(v);
    },
    isIdle: () => idle,
    emit: (s) => states.push(s),
    timers,
    initialDelayMs: 1_000,
    intervalMs: 10_000,
    checkTimeoutMs: 5_000,
    downloadStallMs: 7_000,
  });
  return {
    engine: engine!,
    timers,
    states,
    saved,
    controller,
    setIdle: (v: boolean) => {
      idle = v;
    },
    kinds: () => states.map((s) => s.status.kind),
    last: () => states.at(-1)!,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("versions", () => {
  it("orders versions by semantic-version precedence", () => {
    const ordered = [
      "0.2.0-alpha.1",
      "0.2.0-beta.2",
      "0.2.0-beta.10",
      "0.2.0-beta.11",
      "0.2.0-rc.1",
      "0.2.0",
      "0.2.1-beta.1",
      "0.2.1",
      "0.10.0",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
    expect(compareVersions("v0.2.0-beta.3", "0.2.0-beta.3")).toBe(0);
    expect(() => compareVersions("latest", "0.2.0")).toThrow();
  });

  it("knows prereleases and builds release page links", () => {
    expect(isPrerelease("0.2.0-beta.3")).toBe(true);
    expect(isPrerelease("0.2.0")).toBe(false);
    expect(releasePageUrl("0.2.0-beta.3")).toBe(`${RELEASES_URL}/tag/v0.2.0-beta.3`);
    expect(releasePageUrl("../../evil")).toBe(RELEASES_URL);
    expect(releasePageUrl()).toBe(RELEASES_URL);
  });
});

describe("resolveUpdateCapability", () => {
  const base = { isPackaged: true, env: {}, hasUpdateConfig: true };
  it("turns updates off in development, in test builds, and with TIDYTITLES_DISABLE_UPDATES=1", () => {
    expect(resolveUpdateCapability({ ...base, platform: "win32", isPackaged: false })).toEqual({ kind: "off", reason: "development" });
    expect(resolveUpdateCapability({ ...base, platform: "win32", testBuild: true })).toEqual({ kind: "off", reason: "test" });
    expect(resolveUpdateCapability({ ...base, platform: "win32", env: { TIDYTITLES_DISABLE_UPDATES: "1" } })).toEqual({
      kind: "off",
      reason: "disabled",
    });
    expect(resolveUpdateCapability({ ...base, platform: "win32", env: { TIDYTITLES_DISABLE_UPDATES: "0" } }).kind).toBe("self");
  });

  it("lets only Developer ID signed Mac builds in a writable place install updates", () => {
    const mac = { ...base, platform: "darwin" as const };
    expect(resolveUpdateCapability({ ...mac, macSignature: "developerId", macLocation: "ok" })).toEqual({ kind: "self" });
    expect(resolveUpdateCapability({ ...mac, macSignature: "adhoc", macLocation: "ok" })).toEqual({ kind: "manual", reason: "unsigned" });
    expect(resolveUpdateCapability({ ...mac, macSignature: "unknown", macLocation: "ok" })).toEqual({ kind: "manual", reason: "unsigned" });
    expect(resolveUpdateCapability({ ...mac, macSignature: "developerId", macLocation: "translocated" })).toEqual({
      kind: "manual",
      reason: "location",
    });
    expect(resolveUpdateCapability({ ...mac, macSignature: "developerId", macLocation: "ok", hasUpdateConfig: false })).toEqual({
      kind: "manual",
      reason: "noUpdateConfig",
    });
  });

  it("needs the AppImage on Linux and the installer's config on Windows", () => {
    expect(resolveUpdateCapability({ ...base, platform: "linux" })).toEqual({ kind: "manual", reason: "notAppImage" });
    expect(resolveUpdateCapability({ ...base, platform: "linux", env: { APPIMAGE: "/home/u/TidyTitles.AppImage" } })).toEqual({ kind: "self" });
    expect(resolveUpdateCapability({ ...base, platform: "win32" })).toEqual({ kind: "self" });
    expect(resolveUpdateCapability({ ...base, platform: "win32", hasUpdateConfig: false })).toEqual({ kind: "manual", reason: "noUpdateConfig" });
  });
});

describe("parseCodesignDisplay", () => {
  it("reads ad-hoc, Developer ID, and unsigned bundles", () => {
    expect(
      parseCodesignDisplay("Executable=/A.app/Contents/MacOS/A\nIdentifier=com.filerenamer.tidytitles\nFormat=app bundle\nSignature=adhoc\nTeamIdentifier=not set\n"),
    ).toBe("adhoc");
    expect(
      parseCodesignDisplay(
        "Identifier=com.filerenamer.tidytitles\nAuthority=Developer ID Application: Someone (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345\n",
      ),
    ).toBe("developerId");
    expect(parseCodesignDisplay("/A.app: code object is not signed at all")).toBe("unsigned");
    expect(parseCodesignDisplay("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe("UpdateController: automatic checks", () => {
  it("checks shortly after start, downloads with progress, and ends ready", async () => {
    const t = setup();
    t.controller.start();
    expect(t.timers.scheduled).toEqual([1_000]);
    expect(t.engine.checks).toBe(0);
    await t.timers.advance(1_000);
    expect(t.engine.checks).toBe(1);
    expect(t.last().status).toEqual({ kind: "checking" });
    expect(t.last().manual).toBe(false);

    await t.engine.found("0.2.0-beta.3");
    expect(t.last().status).toEqual({ kind: "downloading", version: "0.2.0-beta.3", percent: null });
    await t.engine.progress(41.6);
    expect(t.last().status).toEqual({ kind: "downloading", version: "0.2.0-beta.3", percent: 42 });
    await t.engine.progress(41.8); // same rounded value: no new state
    expect(t.states.filter((s) => s.status.kind === "downloading")).toHaveLength(2);
    await t.engine.downloaded();
    expect(t.last().status).toEqual({ kind: "ready", version: "0.2.0-beta.3" });
    expect(t.kinds()).toEqual(["checking", "downloading", "downloading", "ready"]);
    // Ready: nothing more to check.
    expect(t.timers.scheduled).toEqual([]);
    await t.controller.check({ manual: false });
    expect(t.engine.checks).toBe(1);
  });

  it("checks again every interval while nothing is found", async () => {
    const t = setup();
    t.controller.start();
    await t.timers.advance(1_000);
    await t.engine.found(CURRENT, false);
    expect(t.last().status).toEqual({ kind: "idle" });
    expect(t.timers.scheduled).toEqual([10_000]);
    await t.timers.advance(10_000);
    expect(t.engine.checks).toBe(2);
  });

  it("does not check automatically when the setting is off", async () => {
    const t = setup({ autoCheck: false });
    t.controller.start();
    expect(t.timers.scheduled).toEqual([]);
    await t.timers.advance(100_000);
    expect(t.engine.checks).toBe(0);
  });

  it("stays silent when an automatic check fails or times out", async () => {
    const t = setup();
    t.controller.start();
    await t.timers.advance(1_000);
    await t.engine.checkFails("offline");
    expect(t.last().status).toEqual({ kind: "idle" });
    expect(t.kinds()).not.toContain("error");
    await t.timers.advance(10_000); // next check
    expect(t.engine.checks).toBe(2);
    await t.timers.advance(5_000); // its timeout
    expect(t.last().status).toEqual({ kind: "idle" });
    expect(t.kinds()).not.toContain("error");
  });
});

describe("UpdateController: manual checks", () => {
  it("reports up to date, with the current version in the state", async () => {
    const t = setup({ autoCheck: false });
    const done = t.controller.check({ manual: true });
    expect(t.last()).toMatchObject({ status: { kind: "checking" }, manual: true, checkId: 1 });
    await t.engine.found(CURRENT, false);
    await done;
    expect(t.last()).toMatchObject({ status: { kind: "upToDate" }, manual: true, currentVersion: CURRENT });
  });

  it("reports a failed check with its kind", async () => {
    const t = setup({ autoCheck: false });
    void t.controller.check({ manual: true });
    await t.engine.checkFails("offline");
    expect(t.last().status).toEqual({ kind: "error", error: "offline" });

    void t.controller.check({ manual: true });
    expect(t.last().checkId).toBe(2);
    await t.timers.advance(5_000);
    expect(t.last().status).toEqual({ kind: "error", error: "timeout" });
  });

  it("joins a running automatic check and reports its outcome", async () => {
    const t = setup();
    t.controller.start();
    await t.timers.advance(1_000);
    await t.controller.check({ manual: true });
    expect(t.engine.checks).toBe(1);
    expect(t.last()).toMatchObject({ status: { kind: "checking" }, manual: true });
    await t.engine.checkFails("notFound");
    expect(t.last().status).toEqual({ kind: "error", error: "notFound" });
  });

  it("shows the running download or the ready update instead of checking again", async () => {
    const t = setup({ autoCheck: false });
    void t.controller.check({ manual: false });
    await t.engine.found("0.2.0-beta.3");
    await t.controller.check({ manual: true });
    expect(t.engine.checks).toBe(1);
    expect(t.last()).toMatchObject({ status: { kind: "downloading" }, manual: true });
    await t.engine.downloaded();
    await t.controller.check({ manual: true });
    expect(t.engine.checks).toBe(1);
    expect(t.last()).toMatchObject({ status: { kind: "ready", version: "0.2.0-beta.3" }, manual: true });
  });
});

describe("UpdateController: no downgrade", () => {
  for (const [label, version, available] of [
    ["an older version", "0.2.0-beta.1", true],
    ["the same version", CURRENT, true],
    ["a prerelease of the current stable line", "0.2.0-alpha.9", true],
    ["a version the engine rejected", "0.3.0", false],
    ["something that is not a version", "latest", true],
  ] as const) {
    it(`ignores ${label}`, async () => {
      const t = setup({ autoCheck: false });
      void t.controller.check({ manual: true });
      await t.engine.found(version, available);
      expect(t.last().status).toEqual({ kind: "upToDate" });
      expect(t.engine.downloads).toBe(0);
    });
  }
});

describe("UpdateController: copies that cannot install updates", () => {
  it("offers the release page instead of downloading", async () => {
    const t = setup({ capability: { kind: "manual", reason: "unsigned" } });
    t.controller.start();
    await t.timers.advance(1_000);
    await t.engine.found("0.2.0-beta.3");
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.3", reason: "unsigned" });
    expect(t.engine.downloads).toBe(0);
    expect(t.controller.releasePageUrl()).toBe(`${RELEASES_URL}/tag/v0.2.0-beta.3`);
    // A later failed automatic check keeps the offer on screen.
    await t.timers.advance(10_000);
    await t.engine.checkFails("offline");
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.3", reason: "unsigned" });
  });

  it("falls back to the release page when the download fails, and stops downloading", async () => {
    const t = setup();
    t.controller.start();
    await t.timers.advance(1_000);
    await t.engine.found("0.2.0-beta.3");
    await t.engine.downloadFails();
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.3", reason: "downloadFailed" });
    expect(t.last().capability).toEqual({ kind: "manual", reason: "downloadFailed" });
    // The next periodic check only checks.
    await t.timers.advance(10_000);
    await t.engine.found("0.2.0-beta.4");
    expect(t.engine.downloads).toBe(1);
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.4", reason: "downloadFailed" });
  });

  it("reports an install-stage failure (the system updater rejected the update)", async () => {
    const t = setup({ autoCheck: false });
    void t.controller.check({ manual: false });
    await t.engine.found("0.2.0-beta.3");
    await t.engine.downloadFails(true);
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.3", reason: "installFailed" });
  });

  it("gives up on a download that stops making progress", async () => {
    const t = setup({ autoCheck: false });
    void t.controller.check({ manual: false });
    await t.engine.found("0.2.0-beta.3");
    await t.timers.advance(6_000);
    await t.engine.progress(10); // resets the watchdog
    await t.timers.advance(6_000);
    expect(t.last().status.kind).toBe("downloading");
    await t.timers.advance(1_000);
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.3", reason: "downloadFailed" });
  });

  it("does nothing when updates are off", async () => {
    const t = setup({ capability: { kind: "off", reason: "development" } });
    t.controller.start();
    await t.timers.advance(100_000);
    await t.controller.check({ manual: true });
    expect(t.engine.checks).toBe(0);
    expect(t.last()).toMatchObject({ status: { kind: "idle" }, capability: { kind: "off", reason: "development" }, manual: true });
  });
});

describe("UpdateController: restart to update", () => {
  async function ready(over: Parameters<typeof setup>[0] = {}) {
    const t = setup({ autoCheck: false, ...over });
    void t.controller.check({ manual: false });
    await t.engine.found("0.2.0-beta.3");
    await t.engine.downloaded();
    return t;
  }

  it("refuses before an update is ready", () => {
    const t = setup();
    expect(t.controller.restartToUpdate()).toBe("notReady");
    expect(t.engine.installs).toBe(0);
  });

  it("refuses while a fetch or rename is running, and restarts once idle", async () => {
    const t = await ready({ idle: false });
    expect(t.controller.restartToUpdate()).toBe("busy");
    expect(t.engine.installs).toBe(0);
    t.setIdle(true);
    expect(t.controller.restartToUpdate()).toBe("restarting");
    expect(t.engine.installs).toBe(1);
    // A second click does not start a second install.
    expect(t.controller.restartToUpdate()).toBe("notReady");
    expect(t.engine.installs).toBe(1);
  });

  it("falls back to the release page when installing fails", async () => {
    const t = await ready();
    t.controller.restartToUpdate();
    t.engine.installError();
    expect(t.last().status).toEqual({ kind: "unsupported", version: "0.2.0-beta.3", reason: "installFailed" });
    expect(t.last().capability).toEqual({ kind: "manual", reason: "installFailed" });
    expect(t.controller.restartToUpdate()).toBe("notReady");
  });
});

describe("UpdateController: the setting", () => {
  it("saves the toggle and starts or stops automatic checks", async () => {
    const t = setup({ autoCheck: true });
    t.controller.start();
    expect(t.timers.scheduled).toEqual([1_000]);
    await t.controller.setAutoCheck(false);
    expect(t.saved).toEqual([false]);
    expect(t.last().autoCheck).toBe(false);
    expect(t.timers.scheduled).toEqual([]);
    await t.timers.advance(50_000);
    expect(t.engine.checks).toBe(0);

    await t.controller.setAutoCheck(true);
    expect(t.saved).toEqual([false, true]);
    expect(t.timers.scheduled).toEqual([1_000]);
    await t.timers.advance(1_000);
    expect(t.engine.checks).toBe(1);
    // Setting the same value again is a no-op.
    await t.controller.setAutoCheck(true);
    expect(t.saved).toEqual([false, true]);
  });

  it("keeps the setting for the session when saving fails", async () => {
    const t = setup();
    const failing = new UpdateController({
      engine: t.engine,
      capability: { kind: "self" },
      currentVersion: CURRENT,
      autoCheck: true,
      saveAutoCheck: vi.fn(() => {
        throw new Error("disk full");
      }),
      isIdle: () => true,
      emit: () => {},
      timers: t.timers,
    });
    await expect(failing.setAutoCheck(false)).resolves.toBeUndefined();
    expect(failing.getState().autoCheck).toBe(false);
  });
});
