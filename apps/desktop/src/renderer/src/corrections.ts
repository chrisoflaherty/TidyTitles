/**
 * Renderer logic for correcting a match or a new name: which row actions
 * apply to an operation, and the search form of the "Change Match" dialog.
 * Main checks everything again; this only decides what to offer.
 */

import type { LookupErrorInfo, MatchQuery, MatchQueryType, PlannedOperation } from "@tidytitles/core";
import type { AppState } from "../../shared/ipc";

export type RowAction = "changeMatch" | "editName" | "resetName" | "clearMatch";

export interface RowActionItem {
  action: RowAction;
  label: string;
  /** Shown in the menu; the row handles the key itself. */
  shortcut?: string;
  enabled: boolean;
}

/** Corrections are possible while a plan is waiting to be renamed and nothing else runs. */
export function canCorrect(app: Pick<AppState, "plan" | "busy">): boolean {
  return app.plan === "planned" && app.busy === null;
}

/** The file has a name from its match (possibly one another file also gets). */
export function hasEditableName(op: PlannedOperation | undefined): boolean {
  return (
    op?.mediaFile.matchedMetadata !== undefined &&
    (op.status === "pending" || op.skipReason === "duplicate_destination")
  );
}

export function hasCustomName(op: PlannedOperation | undefined): boolean {
  return op?.mediaFile.correction?.customName !== undefined;
}

export function rowActions(op: PlannedOperation | undefined): RowActionItem[] {
  const items: RowActionItem[] = [
    { action: "changeMatch", label: "Change Match…", shortcut: "Enter", enabled: op !== undefined },
    { action: "editName", label: "Edit New Name…", shortcut: "F2", enabled: hasEditableName(op) },
  ];
  if (hasCustomName(op)) items.push({ action: "resetName", label: "Use Template Name", enabled: hasEditableName(op) });
  items.push({ action: "clearMatch", label: "Clear Match", enabled: op?.mediaFile.matchedMetadata !== undefined });
  return items;
}

// ---------------------------------------------------------------------------
// Search form
// ---------------------------------------------------------------------------

/** The dialog's fields, as typed. */
export interface QueryForm {
  mediaType: MatchQueryType;
  title: string;
  year: string;
  season: string;
  episode: string;
  artist: string;
  album: string;
}

const numberText = (n: number | undefined) => (n === undefined ? "" : String(n));

export function formFromQuery(query: MatchQuery): QueryForm {
  return {
    mediaType: query.mediaType,
    title: query.title,
    year: query.mediaType !== "music" ? numberText(query.year) : "",
    season: query.mediaType === "tv_episode" ? numberText(query.season) : "",
    episode: query.mediaType === "tv_episode" ? numberText(query.episode) : "",
    artist: query.mediaType === "music" ? (query.artist ?? "") : "",
    album: query.mediaType === "music" ? (query.album ?? "") : "",
  };
}

export type FormField = "title" | "year" | "season" | "episode";

/** A number field's value: undefined when empty; null when not a whole number. */
function parseWhole(text: string): number | undefined | null {
  const t = text.trim();
  if (t === "") return undefined;
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

export type FormResult = { ok: true; query: MatchQuery } | { ok: false; field: FormField; message: string };

export function queryFromForm(form: QueryForm): FormResult {
  const title = form.title.trim();
  if (title === "") return { ok: false, field: "title", message: "Type what to search for." };
  const numbers: Partial<Record<"year" | "season" | "episode", number>> = {};
  const fields = form.mediaType === "tv_episode" ? (["year", "season", "episode"] as const) : (["year"] as const);
  if (form.mediaType !== "music") {
    for (const field of fields) {
      const value = parseWhole(form[field]);
      if (value === null) return { ok: false, field, message: "Use a whole number." };
      if (value !== undefined) numbers[field] = value;
    }
  }
  switch (form.mediaType) {
    case "movie":
      return { ok: true, query: { mediaType: "movie", title, ...numbers } };
    case "tv_episode":
      return { ok: true, query: { mediaType: "tv_episode", title, ...numbers } };
    case "music": {
      const artist = form.artist.trim();
      const album = form.album.trim();
      return {
        ok: true,
        query: { mediaType: "music", title, ...(artist ? { artist } : {}), ...(album ? { album } : {}) },
      };
    }
  }
}

export const QUERY_TYPE_LABELS: Record<MatchQueryType, string> = {
  movie: "Movie",
  tv_episode: "TV episode",
  music: "Music",
};

/** Why a kind of search has no service, and what to do about it. */
export function noProviderMessage(mediaType: MatchQueryType): string {
  switch (mediaType) {
    case "movie":
      return "Searching for movies needs a TMDB API key. Add one in Settings, and choose Auto or TMDB as the provider.";
    case "tv_episode":
      return "Searching for TV shows needs a TVDB or TMDB API key. Add one in Settings, and choose a provider that covers TV.";
    case "music":
      return "Music is searched on MusicBrainz. Choose Auto or MusicBrainz as the provider to search for music.";
  }
}

export function lookupErrorMessage(error: LookupErrorInfo): string {
  switch (error.kind) {
    case "authentication":
      return `The metadata service rejected the API key. Check it in Settings. ${error.message}`.trim();
    case "rate_limit":
      return "The metadata service is limiting requests. Try again in a minute.";
    default:
      return `The search failed: ${error.message}`;
  }
}
