/**
 * Wording for the update dialog, the status-bar control, and the settings
 * tab. The UI branches on the typed fields of `UpdateState` (status kind,
 * capability reason, error kind), never on message text.
 */

import type {
  ManualUpdateReason,
  UpdateErrorKind,
  UpdatesOffReason,
  UpdateState,
  UpdateStatus,
} from "../../shared/ipc";
import { formatCount } from "./format";

export function manualReasonText(reason: ManualUpdateReason): string {
  switch (reason) {
    case "unsigned":
      return "This copy of TidyTitles isn’t signed with an Apple Developer ID, so macOS doesn’t let it update itself.";
    case "location":
      return "TidyTitles is running from a disk image or a folder it can’t change. Move it to your Applications folder to get automatic updates.";
    case "notAppImage":
      return "Automatic updates work only when TidyTitles runs from its AppImage file.";
    case "noUpdateConfig":
      return "This copy of TidyTitles wasn’t set up by its installer, so it can’t update itself.";
    case "installFailed":
      return "The update couldn’t be installed automatically.";
    case "downloadFailed":
      return "The update couldn’t be downloaded.";
  }
}

export function updateErrorText(kind: UpdateErrorKind): string {
  switch (kind) {
    case "offline":
      return "TidyTitles couldn’t reach GitHub. Check your internet connection, then try again.";
    case "timeout":
      return "The update server took too long to respond. Try again later.";
    case "notFound":
      return "No update information was found on the releases page. Try again later.";
    case "unknown":
      return "Something went wrong while checking for updates. Try again later, or get the newest version from the releases page.";
  }
}

export function updatesOffText(reason: UpdatesOffReason): string {
  switch (reason) {
    case "development":
      return "This is a development build. Updates work only in the installed app.";
    case "test":
      return "Updates are turned off in this test build.";
    case "disabled":
      return "Updates are turned off for this copy of TidyTitles (TIDYTITLES_DISABLE_UPDATES is set).";
  }
}

export function percentText(percent: number | null): string {
  return percent === null ? "" : `${formatCount(percent)}%`;
}

/**
 * What the update dialog shows. Until the check it started reports back, it
 * shows "checking" rather than the result of an earlier check.
 */
export function dialogStatus(state: UpdateState, sinceCheckId: number): UpdateStatus | { kind: "off" } {
  if (state.capability.kind === "off") return { kind: "off" };
  const s = state.status;
  if (s.kind === "checking" || s.kind === "downloading" || s.kind === "ready") return s;
  if (state.checkId > sinceCheckId) return s.kind === "idle" ? { kind: "upToDate" } : s;
  return { kind: "checking" };
}

/** One line for the Updates settings tab. */
export function updateSummary(state: UpdateState): string {
  const s = state.status;
  switch (s.kind) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading TidyTitles ${s.version}… ${percentText(s.percent)}`.trim();
    case "ready":
      return `TidyTitles ${s.version} is ready. Restart TidyTitles to install it.`;
    case "unsupported":
      return `TidyTitles ${s.version} is available. ${manualReasonText(s.reason)}`;
    case "upToDate":
      return "TidyTitles is up to date.";
    case "error":
      return updateErrorText(s.error);
    case "idle":
      if (state.capability.kind === "off") return updatesOffText(state.capability.reason);
      if (state.capability.kind === "manual") return `${manualReasonText(state.capability.reason)} New versions are offered as a download.`;
      return "New versions download in the background and install when you restart TidyTitles.";
  }
}
