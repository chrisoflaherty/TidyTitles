/**
 * How an operation's state is shown: a label and icon (never color alone),
 * a tone for the badge, and a row tint that keeps the Python GUI's meaning:
 *
 * - green: a confident match (auto-matched, manually selected, or music tags
 *   verified against MusicBrainz)
 * - amber: music tags that MusicBrainz could not confirm (unverified)
 * - red: skipped (no match, lookup failed, ...) or failed
 * - no tint: metadata taken from a MusicBrainz search (the Python GUI left
 *   these uncolored), or not fetched yet
 */

import type { PlannedOperation, ProviderChoice, MediaTypeChoice, ApiKeyStatus } from "@tidytitles/core";
import type { PlanState } from "../../shared/ipc";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";
export type StatusIcon = "check" | "user-check" | "alert" | "x" | "info" | "dot" | "minus";

export interface StatusView {
  label: string;
  tone: Tone;
  icon: StatusIcon;
  /** Row background tint; undefined: none. */
  rowTone?: "success" | "warning" | "danger";
  /** Longer explanation for the tooltip. */
  detail: string;
}

function matchStatus(op: PlannedOperation): StatusView {
  const status = op.mediaFile.matchedMetadata?.verificationStatus;
  switch (status) {
    case "auto_matched":
      return { label: "Auto-matched", tone: "success", icon: "check", rowTone: "success", detail: "Matched automatically: the search found one clear result." };
    case "manual_selection":
      return { label: "Selected", tone: "success", icon: "user-check", rowTone: "success", detail: "You chose this match from several results." };
    case "verified":
      return { label: "Verified", tone: "success", icon: "check", rowTone: "success", detail: "The file's tags were confirmed on MusicBrainz." };
    case "unverified":
      return { label: "Unverified", tone: "warning", icon: "alert", rowTone: "warning", detail: "Using the file's own tags; MusicBrainz could not confirm them." };
    case "from_provider":
      return { label: "From MusicBrainz", tone: "info", icon: "info", detail: "The file's tags were incomplete, so the details come from a MusicBrainz search." };
    default:
      return { label: "Ready", tone: "neutral", icon: "dot", detail: "Ready to rename." };
  }
}

function skippedStatus(op: PlannedOperation): StatusView {
  const message = op.lookupError?.message ?? op.errorMessage ?? "";
  const red = (label: string, detail: string, icon: StatusIcon = "x"): StatusView => ({
    label,
    tone: "danger",
    icon,
    rowTone: "danger",
    detail,
  });
  switch (op.skipReason) {
    case "no_match":
      return red("No match", "No metadata was found, or the match was skipped. The file will not be renamed.", "minus");
    case "lookup_failed":
      switch (op.lookupError?.kind) {
        case "authentication":
          return red("API key rejected", `The metadata service rejected the API key. Check it in Settings. ${message}`.trim(), "alert");
        case "rate_limit":
          return red("Rate limited", `The metadata service is limiting requests. Try again in a minute. ${message}`.trim(), "alert");
        default:
          return red("Lookup failed", message || "The metadata lookup failed.", "alert");
      }
    case "template_error":
      return red("Template error", message || "The naming template could not be applied.", "alert");
    case "duplicate_destination":
      return red("Duplicate name", "Another file in this list would get the same name.", "alert");
    case "would_overwrite":
      return red("Name taken", "A file with the new name already exists. Change the conflict setting to overwrite or add a version number.", "alert");
    case "same_path":
      return { label: "Already named", tone: "neutral", icon: "check", detail: "The file already has this name." };
    case "unknown_metadata":
      return red("Unknown type", message || "The metadata type is not supported.", "alert");
    default:
      return red("Skipped", message || "This file will not be renamed.", "minus");
  }
}

export function operationStatus(op: PlannedOperation | undefined, plan: PlanState): StatusView {
  if (!op || plan === "none") {
    return { label: "Not fetched", tone: "neutral", icon: "dot", detail: "Fetch metadata to see the new name." };
  }
  switch (op.status) {
    case "completed": {
      const match = matchStatus(op);
      return { label: "Renamed", tone: "success", icon: "check", rowTone: match.rowTone, detail: `Renamed. ${match.detail}` };
    }
    case "failed":
      return { label: "Failed", tone: "danger", icon: "x", rowTone: "danger", detail: op.errorMessage ?? "The rename failed." };
    case "skipped":
      return skippedStatus(op);
    default:
      return matchStatus(op);
  }
}

/** Menu order (core MEDIA_TYPE_CHOICES; the renderer must not import core values). */
export const MEDIA_TYPE_ORDER: readonly MediaTypeChoice[] = ["auto", "movie", "tv", "music"];

export const MEDIA_TYPE_LABELS: Record<MediaTypeChoice, string> = {
  auto: "Auto-detect",
  movie: "Movies",
  tv: "TV Shows",
  music: "Music",
};

/** Provider menu labels (as in the Python GUI), which depend on the keys set. */
export function providerLabel(choice: ProviderChoice, keys: ApiKeyStatus): string {
  switch (choice) {
    case "auto": {
      const parts = [keys.tmdb ? "TMDB" : null, keys.tvdb ? "TVDB" : null, "MusicBrainz"].filter(Boolean);
      return `Auto (${parts.join(" + ")})`;
    }
    case "tmdb":
      return "TMDB (movies and TV)";
    case "tvdb":
      return "TVDB (TV shows)";
    case "musicbrainz":
      return keys.tmdb || keys.tvdb ? "MusicBrainz (music)" : "MusicBrainz (music only)";
  }
}
