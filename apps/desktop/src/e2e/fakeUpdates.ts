/**
 * A scripted update engine for the END-TO-END TEST BUILD.
 *
 * TEST CODE ONLY. Used by `src/e2e/main.ts` when TIDYTITLES_E2E_FAKE_UPDATES=1
 * so the update UI can be driven without a network: the test resolves each
 * check and download from the main process through
 * `globalThis.__tidytitlesFakeUpdates`. `scripts/check-build.mjs` fails the
 * production build if this code reaches `out/`.
 */

import type { UpdateErrorKind } from "../shared/ipc";
import type { UpdateEngine } from "../main/updater";

class FakeEngineError extends Error {
  constructor(readonly kind: UpdateErrorKind) {
    super(`fake ${kind}`);
  }
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class ScriptedUpdateEngine implements UpdateEngine {
  private pendingCheck: Pending<{ version: string; available: boolean }> | null = null;
  private pendingDownload: (Pending<void> & { onProgress: (percent: number) => void }) | null = null;
  private installErrorListeners: ((error: unknown) => void)[] = [];
  installRequested = 0;

  check() {
    return new Promise<{ version: string; available: boolean }>((resolve, reject) => {
      this.pendingCheck = { resolve, reject };
    });
  }

  download(onProgress: (percent: number) => void) {
    return new Promise<void>((resolve, reject) => {
      this.pendingDownload = { resolve, reject, onProgress };
    });
  }

  quitAndInstall() {
    this.installRequested += 1;
  }

  onInstallError(listener: (error: unknown) => void) {
    this.installErrorListeners.push(listener);
  }

  classifyError(error: unknown): UpdateErrorKind {
    return error instanceof FakeEngineError ? error.kind : "unknown";
  }

  // --- driven by the test ---------------------------------------------------

  get waiting(): { check: boolean; download: boolean } {
    return { check: this.pendingCheck !== null, download: this.pendingDownload !== null };
  }

  resolveCheck(version: string, available = true) {
    this.pendingCheck?.resolve({ version, available });
    this.pendingCheck = null;
  }

  failCheck(kind: UpdateErrorKind) {
    this.pendingCheck?.reject(new FakeEngineError(kind));
    this.pendingCheck = null;
  }

  progress(percent: number) {
    this.pendingDownload?.onProgress(percent);
  }

  finishDownload() {
    this.pendingDownload?.resolve();
    this.pendingDownload = null;
  }

  failDownload() {
    this.pendingDownload?.reject(new FakeEngineError("offline"));
    this.pendingDownload = null;
  }

  failInstall() {
    for (const listener of this.installErrorListeners) listener(new Error("fake install failure"));
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __tidytitlesFakeUpdates: ScriptedUpdateEngine | undefined;
}
