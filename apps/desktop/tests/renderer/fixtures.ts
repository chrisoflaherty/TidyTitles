import { vi } from "vitest";
import {
  createEpisode,
  createMovie,
  createParsedInfo,
  createRenameOperation,
  createTVShow,
  type MatchedMetadata,
  type PlannedOperation,
} from "@tidytitles/core";
import type {
  AppState,
  EventPayloads,
  FileEntry,
  SettingsPayload,
  TidyTitlesApi,
} from "../../src/shared/ipc";
import { EVENTS } from "../../src/shared/ipc";

export function file(id: number, name: string, dir = "/media"): FileEntry {
  return { id, path: `${dir}/${name}`, name, directory: dir, kind: /\.(mp3|flac)$/.test(name) ? "audio" : "video" };
}

export function op(
  f: FileEntry,
  fields: Partial<PlannedOperation> & { newName?: string; metadata?: MatchedMetadata } = {},
): PlannedOperation {
  const { newName, metadata, ...rest } = fields;
  return {
    ...createRenameOperation({
      source: f.path,
      destination: newName ? `${f.directory}/${newName}` : f.path,
      mediaFile: { path: f.path, parsedInfo: createParsedInfo({ title: f.name }), matchedMetadata: metadata },
    }),
    ...rest,
  };
}

export const matrix = createMovie({ id: 603, title: "The Matrix", originalTitle: "The Matrix", year: 1999, releaseDate: "1999-03-31" });
export const pilot = createEpisode({
  show: createTVShow({ id: 1, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008 }),
  season: 1,
  episode: 1,
  title: "Pilot",
});

export function appState(over: Partial<AppState> = {}): AppState {
  return {
    files: [],
    operations: null,
    plan: "none",
    busy: null,
    options: { mediaType: "auto", provider: "auto", recursive: true, coverArt: false },
    providerChoices: ["auto", "tmdb", "tvdb", "musicbrainz"],
    apiKeys: { tmdb: true, tvdb: true },
    lastRename: null,
    status: { text: "Ready", tone: "info" },
    configError: null,
    configFile: "/config/config.toml",
    platform: "darwin",
    ...over,
  };
}

export function settingsPayload(): SettingsPayload {
  return {
    settings: {
      templates: { movie: "{title} ({year})", tv: "{title} - S{season2}E{episode2}", music: "{artist}/{title}" },
      api: { tmdbApiKey: "tmdb-secret", tvdbApiKey: "", tvdbPin: "" },
      associatedFiles: { enabled: true, subtitles: true, nfo: true, images: true },
      coverArt: { enabled: false, filename: "poster.jpg", musicFilename: "cover.jpg", overwrite: false, size: "w500" },
      conflictResolution: "skip",
      tvProvider: "tvdb",
    },
    configFile: "/config/config.toml",
    fields: { title: "Title", year: "Year" },
    formatters: { lower: "Lowercase" },
    preview: {
      movie: { preview: "The Matrix (1999).mkv", errors: [] },
      tv: { preview: "Breaking Bad - S01E01.mkv", errors: [] },
      music: { preview: "Pink Floyd/Comfortably Numb.flac", errors: [] },
    },
    loadError: null,
  };
}

type Listener = (payload: never) => void;

/** A fake preload API with an event emitter for main-process events. */
export function createFakeApi(state: AppState = appState()) {
  const listeners = new Map<string, Set<Listener>>();
  const on = (channel: string) => (listener: Listener) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
    return () => listeners.get(channel)!.delete(listener);
  };
  const api = {
    platform: "darwin",
    getState: vi.fn<TidyTitlesApi["getState"]>(async () => state),
    addFilesDialog: vi.fn<TidyTitlesApi["addFilesDialog"]>(async () => null),
    addPaths: vi.fn<TidyTitlesApi["addPaths"]>(async () => ({ added: 0, total: 0 })),
    pathForFile: vi.fn<TidyTitlesApi["pathForFile"]>((f: File) => `/dropped/${f.name}`),
    removeFiles: vi.fn<TidyTitlesApi["removeFiles"]>(async () => undefined),
    clearFiles: vi.fn<TidyTitlesApi["clearFiles"]>(async () => undefined),
    setOptions: vi.fn<TidyTitlesApi["setOptions"]>(async () => undefined),
    fetch: vi.fn<TidyTitlesApi["fetch"]>(async () => ({ kind: "canceled" })),
    cancelFetch: vi.fn<TidyTitlesApi["cancelFetch"]>(async () => undefined),
    answerSelection: vi.fn<TidyTitlesApi["answerSelection"]>(async () => undefined),
    rename: vi.fn<TidyTitlesApi["rename"]>(async () => ({ kind: "nothing" })),
    undo: vi.fn<TidyTitlesApi["undo"]>(async () => ({ kind: "busy" })),
    getSettings: vi.fn<TidyTitlesApi["getSettings"]>(async () => settingsPayload()),
    previewTemplates: vi.fn<TidyTitlesApi["previewTemplates"]>(async () => settingsPayload().preview),
    saveSettings: vi.fn<TidyTitlesApi["saveSettings"]>(async () => ({ ok: true })),
    openExternal: vi.fn<TidyTitlesApi["openExternal"]>(async () => undefined),
    onState: on(EVENTS.state),
    onProgress: on(EVENTS.progress),
    onSelectionRequest: on(EVENTS.selectionRequest),
    onSelectionClosed: on(EVENTS.selectionClosed),
    onMenuCommand: on(EVENTS.menuCommand),
  } satisfies TidyTitlesApi;

  const emit = <K extends keyof EventPayloads>(channel: K, payload: EventPayloads[K]) => {
    for (const l of listeners.get(channel) ?? []) (l as (p: EventPayloads[K]) => void)(payload);
  };
  Object.defineProperty(window, "tidytitles", { value: api, configurable: true });
  return { api, emit };
}
