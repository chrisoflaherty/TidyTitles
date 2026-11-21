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
  HistoryEntrySummary,
  TransferMode,
  UndoKeptReason,
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
  takeOpenedPaths: "files:take-opened",
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
  getUpdateState: "updates:get",
  checkForUpdates: "updates:check",
  restartToUpdate: "updates:restart",
  openReleasePage: "updates:open-release-page",
  setAutoCheckForUpdates: "updates:set-auto-check",
  chooseFolder: "dialog:choose-folder",
  getHistory: "history:get",
  undoEntry: "history:undo-entry",
} as const;

/** Event channels (main -> renderer, `webContents.send`). */
export const EVENTS = {
  state: "event:state",
  progress: "event:progress",
  selectionRequest: "event:selection-request",
  selectionClosed: "event:selection-closed",
  menuCommand: "event:menu-command",
  updateState: "event:update-state",
  pathsOpened: "event:paths-opened",
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
  /** Move, copy, or hard link. Defaults to `[output] transfer_mode`. */
  transferMode: TransferMode;
}

/** The `[output]` folders ("" keeps files next to the originals). */
export interface OutputFolders {
  movie: string;
  tv: string;
  music: string;
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
  /** Where renamed files go, per media kind. */
  output: OutputFolders;
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
  | "settings"
  | "checkForUpdates"
  | "history";

export interface EventPayloads {
  [EVENTS.state]: AppState;
  [EVENTS.progress]: ProgressEvent | null;
  [EVENTS.selectionRequest]: SelectionRequest;
  /** The request was withdrawn (the fetch ended or was canceled). */
  [EVENTS.selectionClosed]: { id: string };
  [EVENTS.menuCommand]: MenuCommand;
  [EVENTS.updateState]: UpdateState;
  /**
   * Files or folders were opened with the app (Dock, Finder's Open With, the
   * command line) and wait in main; take them with `takeOpenedPaths`.
   */
  [EVENTS.pathsOpened]: null;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** Why this copy cannot install updates itself (it offers a download link instead). */
export type ManualUpdateReason =
  /** macOS: not signed with a Developer ID (ad-hoc), so the system updater rejects it. */
  | "unsigned"
  /** macOS: running from the disk image, a translocated copy, or a read-only folder. */
  | "location"
  /** Linux: not running from the AppImage. */
  | "notAppImage"
  /** No update configuration in the package (not installed by the installer). */
  | "noUpdateConfig"
  /** The update was downloaded but could not be installed. */
  | "installFailed"
  /** The update could not be downloaded. */
  | "downloadFailed";

/** Why updates are turned off entirely. */
export type UpdatesOffReason = "development" | "test" | "disabled";

/** How this copy of the app gets new versions. */
export type UpdateCapability =
  | { kind: "self" }
  | { kind: "manual"; reason: ManualUpdateReason }
  | { kind: "off"; reason: UpdatesOffReason };

export type UpdateErrorKind = "offline" | "timeout" | "notFound" | "unknown";

/** The updater state machine. */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  /** `percent` is null until the first progress report. */
  | { kind: "downloading"; version: string; percent: number | null }
  /** Downloaded; installs on restart or quit. */
  | { kind: "ready"; version: string }
  | { kind: "upToDate" }
  | { kind: "error"; error: UpdateErrorKind }
  /** A newer version exists but this copy cannot install it (see `capability`). */
  | { kind: "unsupported"; version: string; reason: ManualUpdateReason };

export interface UpdateState {
  status: UpdateStatus;
  capability: UpdateCapability;
  currentVersion: string;
  /** "Check for updates automatically" (stored in userData, not config.toml). */
  autoCheck: boolean;
  /** Whether the user asked for the current or most recent check. */
  manual: boolean;
  /** Increases with every check, so the renderer can tell one result from the next. */
  checkId: number;
}

export type RestartToUpdateResult = "restarting" | "busy" | "notReady";

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
      /** How the files got their new names. */
      transferMode: TransferMode;
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
  /** Files left in place on purpose (file name and why). */
  kept: { name: string; reason: UndoKeptReason }[];
}

export type UndoOutcome =
  | {
      kind: "done";
      historyFound: boolean;
      undone: number;
      missing: number;
      /** Operations with files left in place on purpose. */
      kept: number;
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
  output: Settings["output"];
  history: Settings["history"];
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
export const TRANSFER_MODE_CHOICES = ["move", "copy", "hardlink"] as const satisfies readonly TransferMode[];
/** Bounds of `[history] max_entries` (core's MAX_HISTORY_LIMIT). */
export const HISTORY_LIMIT_RANGE = { min: 1, max: 10_000 } as const;

/** A history entry as the History dialog lists it. */
export type HistoryEntryView = HistoryEntrySummary;

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
  /**
   * Add the files and folders opened with the app (Dock, Finder's Open With,
   * the command line) that wait in main. `accept` is whether a drop would be
   * accepted right now; when it is false, or main is busy, they are refused
   * with a message. Resolves to null when nothing was added.
   */
  takeOpenedPaths(accept: boolean): Promise<AddResult | null>;
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
  getUpdateState(): Promise<UpdateState>;
  /** A check the user asked for: its outcome is reported, whatever it is. */
  checkForUpdates(): Promise<void>;
  /** Restart into the downloaded version. Refused while a task is running. */
  restartToUpdate(): Promise<RestartToUpdateResult>;
  /** Open the release page of the newest known version in the browser. */
  openReleasePage(): Promise<void>;
  setAutoCheckForUpdates(enabled: boolean): Promise<void>;
  /** Pick a folder in the system dialog (starting at `current` when it exists); null when canceled. */
  chooseFolder(current?: string): Promise<string | null>;
  /** The rename history, most recent first. */
  getHistory(): Promise<HistoryEntryView[]>;
  /** Undo the history entry with this timestamp (any entry, not only the last). */
  undoEntry(timestamp: string): Promise<UndoOutcome>;
  onUpdateState(listener: (state: UpdateState) => void): Unsubscribe;
  onState(listener: (state: AppState) => void): Unsubscribe;
  onProgress(listener: (progress: ProgressEvent | null) => void): Unsubscribe;
  onSelectionRequest(listener: (request: SelectionRequest) => void): Unsubscribe;
  onSelectionClosed(listener: (event: { id: string }) => void): Unsubscribe;
  onMenuCommand(listener: (command: MenuCommand) => void): Unsubscribe;
  onPathsOpened(listener: () => void): Unsubscribe;
}
