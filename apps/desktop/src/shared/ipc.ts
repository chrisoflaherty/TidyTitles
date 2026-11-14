/**
 * The IPC contract between the main process and the renderer.
 *
 * Main and preload import the channel names (`IPC`, `EVENTS`) as values; the
 * renderer imports only types from this module. Every payload is plain JSON.
 *
 * Main owns the authoritative state (files, the planned operations, the
 * running fetch). The renderer receives `AppState` snapshots and refers to
 * files by id; it never sends paths back for renaming.
 */

import type {
  ApiKeyStatus,
  MediaTypeChoice,
  OperationSummary,
  PlannedOperation,
  ProviderChoice,
  SelectableOption,
  Settings,
  UndoItemStatus,
} from "@tidytitles/core";

/** Request/response channels (renderer -> main, `ipcRenderer.invoke`). */
export const IPC = {
  getState: "state:get",
  addFilesDialog: "files:add-dialog",
  addPaths: "files:add-paths",
  removeFiles: "files:remove",
  clearFiles: "files:clear",
  setOptions: "options:set",
  fetch: "fetch:start",
  cancelFetch: "fetch:cancel",
  answerSelection: "selection:answer",
  rename: "rename:start",
  undo: "undo:start",
  getSettings: "settings:get",
  previewTemplates: "settings:preview-templates",
  saveSettings: "settings:save",
  openExternal: "shell:open-external",
} as const;

/** Event channels (main -> renderer, `webContents.send`). */
export const EVENTS = {
  state: "event:state",
  progress: "event:progress",
  selectionRequest: "event:selection-request",
  selectionClosed: "event:selection-closed",
  menuCommand: "event:menu-command",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** `process.platform` of the main process. */
export type Platform = "darwin" | "win32" | "linux" | (string & {});

export type FileKind = "video" | "audio";

/** A file in the list. */
export interface FileEntry {
  /** Stable id for this entry while it is in the list. */
  id: number;
  path: string;
  name: string;
  directory: string;
  kind: FileKind;
}

/** What main is doing right now (null: idle). */
export type BusyKind = "adding" | "fetching" | "renaming" | "undoing" | "saving";

/** Toolbar options for the next fetch / rename. */
export interface RunOptions {
  mediaType: MediaTypeChoice;
  provider: ProviderChoice;
  /** Scan subfolders when adding folders. */
  recursive: boolean;
  /** Download cover art after renaming. Defaults to `[cover_art] enabled`. */
  coverArt: boolean;
}

/**
 * - "none": no fetch has run for the current list
 * - "planned": `operations` holds a plan that can be renamed
 * - "renamed": `operations` holds the results of a rename
 */
export type PlanState = "none" | "planned" | "renamed";

export type StatusTone = "info" | "success" | "warning" | "error";

export interface StatusMessage {
  text: string;
  tone: StatusTone;
}

/** The most recent history entry (what Undo will revert). */
export interface LastRenameInfo {
  /** Local time, "YYYY-MM-DDTHH:MM:SS[.ffffff]" (no offset). */
  timestamp: string;
  /** Number of main files in the entry. */
  operations: number;
  /** Main plus associated files. */
  files: number;
}

/** Snapshot of the main-process state, pushed on every change. */
export interface AppState {
  files: FileEntry[];
  /** One operation per file, index-aligned with `files`, when `plan` is not "none". */
  operations: PlannedOperation[] | null;
  plan: PlanState;
  busy: BusyKind | null;
  options: RunOptions;
  providerChoices: ProviderChoice[];
  apiKeys: ApiKeyStatus;
  lastRename: LastRenameInfo | null;
  status: StatusMessage;
  /** Set when config.toml could not be loaded. */
  configError: string | null;
  configFile: string;
  platform: Platform;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ProgressPhase = "parse" | "fetch" | "rename" | "coverArt" | "undo";

export interface ProgressEvent {
  phase: ProgressPhase;
  current: number;
  total: number;
  message: string;
}

export type SelectionKind = "movie" | "show" | "track";

/** Main asks the renderer to choose among several matches. */
export interface SelectionRequest {
  /** Correlation id; answer with `answerSelection(id, ...)`. */
  id: string;
  filename: string;
  kind: SelectionKind;
  options: SelectableOption[];
}

export type MenuCommand =
  | "addFiles"
  | "addFolder"
  | "clear"
  | "fetch"
  | "cancelFetch"
  | "rename"
  | "undo"
  | "settings";

export interface EventPayloads {
  [EVENTS.state]: AppState;
  [EVENTS.progress]: ProgressEvent | null;
  [EVENTS.selectionRequest]: SelectionRequest;
  /** The request was withdrawn (the fetch ended or was canceled). */
  [EVENTS.selectionClosed]: { id: string };
  [EVENTS.menuCommand]: MenuCommand;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface AddResult {
  added: number;
  total: number;
}

export type FetchOutcome =
  | { kind: "done"; summary: OperationSummary }
  | { kind: "canceled" }
  | { kind: "error"; message: string }
  | { kind: "busy" }
  | { kind: "empty" };

export interface RenameFailure {
  name: string;
  message: string;
}

export type RenameOutcome =
  | {
      kind: "done";
      summary: OperationSummary;
      /** Associated files moved along with completed operations. */
      associatedRenamed: number;
      coverArtDownloaded: number;
      /** Whether cover art download was attempted. */
      coverArtAttempted: boolean;
      failures: RenameFailure[];
      historySaved: number;
    }
  | { kind: "error"; message: string }
  | { kind: "busy" }
  | { kind: "nothing" };

export interface UndoItemView {
  name: string;
  status: UndoItemStatus;
  errors: string[];
}

export type UndoOutcome =
  | {
      kind: "done";
      historyFound: boolean;
      undone: number;
      missing: number;
      failed: number;
      items: UndoItemView[];
    }
  | { kind: "error"; message: string }
  | { kind: "busy" };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TemplateSet {
  movie: string;
  tv: string;
  music: string;
}

export interface TemplatePreviewItem {
  /** Rendered sample filename; undefined when the template has errors. */
  preview?: string;
  errors: string[];
}

export type TemplatePreview = Record<keyof TemplateSet, TemplatePreviewItem>;

/** What the settings dialog edits. A subset of core `Settings`. */
export interface EditableSettings {
  templates: TemplateSet;
  api: Settings["api"];
  associatedFiles: Settings["associatedFiles"];
  coverArt: Settings["coverArt"];
  conflictResolution: string;
  tvProvider: string;
}

export interface SettingsPayload {
  settings: EditableSettings;
  configFile: string;
  /** Template field name -> description. */
  fields: Record<string, string>;
  /** Formatter syntax -> description. */
  formatters: Record<string, string>;
  preview: TemplatePreview;
  /** Set when config.toml could not be loaded; `settings` are then the defaults. */
  loadError: string | null;
}

export type SaveSettingsResult =
  | { ok: true }
  | { ok: false; errors: string[]; templateErrors?: Partial<Record<keyof TemplateSet, string[]>> };

export const CONFLICT_CHOICES = ["skip", "overwrite", "auto_version"] as const;
export const COVER_SIZE_CHOICES = ["w92", "w154", "w185", "w342", "w500", "w780", "original"] as const;
export const TV_PROVIDER_CHOICES = ["tvdb", "tmdb"] as const;

// ---------------------------------------------------------------------------
// The API exposed on `window.tidytitles`
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

export interface TidyTitlesApi {
  readonly platform: Platform;
  getState(): Promise<AppState>;
  addFilesDialog(kind: "files" | "folder"): Promise<AddResult | null>;
  /** Add dropped files and folders. */
  addPaths(paths: string[]): Promise<AddResult>;
  /** The filesystem path of a dropped `File`, or "" when it has none. */
  pathForFile(file: File): string;
  removeFiles(ids: number[]): Promise<void>;
  clearFiles(): Promise<void>;
  setOptions(options: Partial<RunOptions>): Promise<void>;
  fetch(): Promise<FetchOutcome>;
  cancelFetch(): Promise<void>;
  /** Answer a selection request: an option index, or null to skip the file. */
  answerSelection(id: string, index: number | null): Promise<void>;
  rename(): Promise<RenameOutcome>;
  undo(): Promise<UndoOutcome>;
  getSettings(): Promise<SettingsPayload>;
  previewTemplates(templates: TemplateSet): Promise<TemplatePreview>;
  saveSettings(settings: EditableSettings): Promise<SaveSettingsResult>;
  /** Open an https URL in the default browser. */
  openExternal(url: string): Promise<void>;
  onState(listener: (state: AppState) => void): Unsubscribe;
  onProgress(listener: (progress: ProgressEvent | null) => void): Unsubscribe;
  onSelectionRequest(listener: (request: SelectionRequest) => void): Unsubscribe;
  onSelectionClosed(listener: (event: { id: string }) => void): Unsubscribe;
  onMenuCommand(listener: (command: MenuCommand) => void): Unsubscribe;
}
