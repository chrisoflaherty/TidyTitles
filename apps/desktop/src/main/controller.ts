/**
 * The desktop app's main-process state and workflow.
 *
 * Owns the file list, the session that planned the current operations, the
 * planned operations themselves, and the AbortController of a running
 * fetch. Has no Electron imports so it can be tested in plain Node; the IPC
 * layer (`ipcHandlers.ts`) validates arguments and calls in here.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  ConfigError,
  RenameSession,
  TemplateEngine,
  availableProviderChoices,
  collectMediaFiles,
  createDefaultSettings,
  forceTypeForChoice,
  getApiKeyStatus,
  isMusicFile,
  summarizeOperations,
  undoLastRename,
  type ConfigService,
  type PlannedOperation,
  type SelectableOption,
  type SelectionResult,
  type SessionOptions,
  type Settings,
} from "@tidytitles/core";
import type {
  AddResult,
  AppState,
  BusyKind,
  EditableSettings,
  EventPayloads,
  FetchOutcome,
  FileEntry,
  LastRenameInfo,
  PlanState,
  ProgressEvent,
  RenameFailure,
  RenameOutcome,
  RunOptions,
  SaveSettingsResult,
  SelectionKind,
  SettingsPayload,
  StatusMessage,
  TemplatePreview,
  TemplateSet,
  UndoOutcome,
} from "../shared/ipc";
import { EVENTS } from "../shared/ipc";
import { previewTemplates } from "./templatePreview";

export type Emit = <K extends keyof EventPayloads>(channel: K, payload: EventPayloads[K]) => void;

/** Session pieces that tests and the e2e build replace (never set in the shipped app). */
export type SessionOverrides = Pick<SessionOptions, "providers" | "fetch" | "musicParser" | "parser">;

export interface ControllerOptions {
  config: ConfigService;
  emit: Emit;
  platform?: NodeJS.Platform;
  sessionOverrides?: SessionOverrides;
}

/** Thrown into the core selection callback to cancel the whole fetch. */
export class FetchCanceledError extends Error {
  constructor() {
    super("Fetch canceled");
    this.name = "FetchCanceledError";
  }
}

interface PendingSelection {
  resolve: (result: SelectionResult) => void;
  reject: (error: unknown) => void;
  optionCount: number;
}

const COLLATOR = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
const COUNT = new Intl.NumberFormat("en-US");

function plural(n: number, one: string, many = `${one}s`): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

function realKey(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectionKind(options: readonly SelectableOption[]): SelectionKind {
  const kind = options[0]?.kind;
  return kind === "show" ? "show" : kind === "track" ? "track" : "movie";
}

export function toEditableSettings(settings: Settings): EditableSettings {
  return {
    templates: { ...settings.templates },
    api: { ...settings.api },
    associatedFiles: { ...settings.associatedFiles },
    coverArt: { ...settings.coverArt },
    conflictResolution: settings.conflictResolution,
    tvProvider: settings.tvProvider,
  };
}

export class AppController {
  private readonly config: ConfigService;
  private readonly emitEvent: Emit;
  private readonly platform: NodeJS.Platform;
  private readonly sessionOverrides: SessionOverrides;

  private settings: Settings = createDefaultSettings();
  private configError: string | null = null;
  private files: FileEntry[] = [];
  private nextFileId = 1;
  private operations: PlannedOperation[] | null = null;
  private plan: PlanState = "none";
  private session: RenameSession | null = null;
  private busy: BusyKind | null = null;
  private abort: AbortController | null = null;
  private readonly pending = new Map<string, PendingSelection>();
  private options: RunOptions = {
    mediaType: "auto",
    provider: "auto",
    // Off by default, as in the Python GUI.
    recursive: false,
    coverArt: false,
  };
  private lastRename: LastRenameInfo | null = null;
  private status: StatusMessage = { text: "Ready", tone: "info" };

  constructor(options: ControllerOptions) {
    this.config = options.config;
    this.emitEvent = options.emit;
    this.platform = options.platform ?? process.platform;
    this.sessionOverrides = options.sessionOverrides ?? {};
  }

  /** Load settings and history. Never throws; a bad config is reported in the state. */
  async init(): Promise<void> {
    await this.reloadSettings();
    this.options.coverArt = this.settings.coverArt.enabled;
    await this.refreshLastRename();
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  getState(): AppState {
    return {
      files: this.files.map((f) => ({ ...f })),
      operations: this.operations,
      plan: this.plan,
      busy: this.busy,
      options: { ...this.options },
      providerChoices: availableProviderChoices(this.settings),
      apiKeys: getApiKeyStatus(this.settings),
      lastRename: this.lastRename,
      status: this.status,
      configError: this.configError,
      configFile: this.config.configFile,
      platform: this.platform,
    };
  }

  get isBusy(): boolean {
    return this.busy !== null;
  }

  private emitState(): void {
    this.emitEvent(EVENTS.state, this.getState());
  }

  private emitProgress(progress: ProgressEvent | null): void {
    this.emitEvent(EVENTS.progress, progress);
  }

  private setStatus(text: string, tone: StatusMessage["tone"] = "info"): void {
    this.status = { text, tone };
  }

  private async reloadSettings(): Promise<void> {
    try {
      this.settings = await this.config.load();
      this.configError = null;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      this.settings = createDefaultSettings();
      this.configError = error.message;
      this.setStatus("Could not load settings; using defaults", "error");
    }
    this.coerceProvider();
  }

  /** Keep the provider option among the choices the configured keys allow. */
  private coerceProvider(): void {
    const choices = availableProviderChoices(this.settings);
    if (!choices.includes(this.options.provider)) this.options.provider = choices[0] ?? "musicbrainz";
  }

  private async refreshLastRename(): Promise<void> {
    const history = await this.config.loadHistory();
    const last = history[0];
    this.lastRename =
      last && last.operations.length > 0
        ? {
            timestamp: last.timestamp,
            operations: last.operations.length,
            files: last.operations.reduce((n, op) => n + 1 + op.associatedFiles.length, 0),
          }
        : null;
  }

  /** Drop the current plan (the list or the settings changed). */
  private resetPlan(): void {
    this.operations = null;
    this.plan = "none";
    this.session = null;
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /**
   * Add files and folders. Folders are scanned (recursively when the option
   * is on) for the selected media type's extensions. `filterExplicitFiles`
   * also applies the extension filter to files named directly (drag and
   * drop does this, as in the Python GUI).
   */
  async addPaths(paths: readonly string[], { filterExplicitFiles = true } = {}): Promise<AddResult> {
    if (this.busy) return { added: 0, total: this.files.length };
    this.busy = "adding";
    this.emitState();
    try {
      const found = await collectMediaFiles(paths, {
        recursive: this.options.recursive,
        mediaType: forceTypeForChoice(this.options.mediaType),
        filterExplicitFiles,
      });
      const seen = new Set(this.files.map((f) => realKey(f.path)));
      let added = 0;
      for (const file of found) {
        const key = realKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        this.files.push(this.makeEntry(file));
        added += 1;
      }
      this.sortFiles();
      if (added > 0) {
        this.resetPlan();
        this.setStatus(`Added ${plural(added, "file")} (${plural(this.files.length, "file")} in the list)`);
      } else if (found.length > 0) {
        this.setStatus("Those files are already in the list");
      } else {
        this.setStatus("No media files found in the added items", "warning");
      }
      return { added, total: this.files.length };
    } finally {
      this.busy = null;
      this.emitState();
    }
  }

  private makeEntry(file: string): FileEntry {
    return {
      id: this.nextFileId++,
      path: file,
      name: path.basename(file),
      directory: path.dirname(file),
      kind: isMusicFile(file) ? "audio" : "video",
    };
  }

  private sortFiles(): void {
    this.files.sort(
      (a, b) => COLLATOR.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  }

  removeFiles(ids: readonly number[]): void {
    if (this.busy) return;
    const remove = new Set(ids);
    const before = this.files.length;
    this.files = this.files.filter((f) => !remove.has(f.id));
    const removed = before - this.files.length;
    if (removed === 0) return;
    this.resetPlan();
    this.setStatus(`Removed ${plural(removed, "file")} from the list`);
    this.emitState();
  }

  clearFiles(): void {
    if (this.busy) return;
    this.files = [];
    this.resetPlan();
    this.setStatus("File list cleared");
    this.emitState();
  }

  setOptions(options: Partial<RunOptions>): void {
    if (this.busy) return;
    const next = { ...this.options, ...options };
    const changedLookup =
      next.mediaType !== this.options.mediaType || next.provider !== this.options.provider;
    this.options = next;
    this.coerceProvider();
    if (changedLookup && this.plan === "planned") {
      this.resetPlan();
      this.setStatus("Options changed. Fetch metadata again to update the new names.");
    }
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  private selectionCallback = (
    options: SelectableOption[],
    filename: string,
  ): Promise<SelectionResult> =>
    new Promise<SelectionResult>((resolve, reject) => {
      if (!this.abort || this.abort.signal.aborted) {
        reject(new FetchCanceledError());
        return;
      }
      const id = randomUUID();
      this.pending.set(id, { resolve, reject, optionCount: options.length });
      this.emitEvent(EVENTS.selectionRequest, {
        id,
        filename,
        kind: selectionKind(options),
        options,
      });
    });

  /** Answer a selection request. Unknown ids (already withdrawn) are ignored. */
  answerSelection(id: string, index: number | null): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (index !== null && (index < 0 || index >= request.optionCount)) {
      request.resolve(undefined);
      return;
    }
    request.resolve(index ?? undefined);
  }

  private withdrawSelections(error: unknown): void {
    for (const [id, request] of this.pending) {
      request.reject(error);
      this.emitEvent(EVENTS.selectionClosed, { id });
    }
    this.pending.clear();
  }

  /** Cancel a running fetch (between files, or at an open selection). */
  cancelFetch(): void {
    if (this.busy !== "fetching" || !this.abort) return;
    const error = new FetchCanceledError();
    this.abort.abort(error);
    this.withdrawSelections(error);
  }

  private createSession(): RenameSession {
    return new RenameSession(this.settings, {
      config: this.config,
      provider: this.options.provider,
      mediaType: this.options.mediaType,
      requireApiKeys: false,
      selectionCallback: this.selectionCallback,
      ...this.sessionOverrides,
    });
  }

  async fetch(): Promise<FetchOutcome> {
    if (this.busy) return { kind: "busy" };
    if (this.files.length === 0) return { kind: "empty" };

    this.busy = "fetching";
    this.resetPlan();
    this.setStatus("Fetching metadata…");
    this.emitState();

    const abort = new AbortController();
    this.abort = abort;
    try {
      await this.reloadSettings();
      if (this.configError) return { kind: "error", message: this.configError };
      const session = this.createSession();
      const operations = await session.plan(
        this.files.map((f) => f.path),
        {
          signal: abort.signal,
          progressCallback: (current, total, message, phase) =>
            this.emitProgress({ phase, current, total, message }),
        },
      );
      this.session = session;
      this.operations = operations;
      this.plan = "planned";
      const summary = summarizeOperations(operations);
      const ready = summary.pending;
      this.setStatus(
        ready > 0
          ? `${plural(ready, "file")} ready to rename${summary.skipped ? `, ${COUNT.format(summary.skipped)} skipped` : ""}`
          : "No files can be renamed",
        ready > 0 ? "success" : "warning",
      );
      return { kind: "done", summary };
    } catch (error) {
      if (abort.signal.aborted || error instanceof FetchCanceledError) {
        this.setStatus("Fetch canceled", "warning");
        return { kind: "canceled" };
      }
      const message = errorMessage(error);
      this.setStatus(`Fetch failed: ${message}`, "error");
      return { kind: "error", message };
    } finally {
      this.withdrawSelections(new FetchCanceledError());
      this.abort = null;
      this.busy = null;
      this.emitProgress(null);
      this.emitState();
    }
  }

  // -------------------------------------------------------------------------
  // Rename and undo
  // -------------------------------------------------------------------------

  async rename(): Promise<RenameOutcome> {
    if (this.busy) return { kind: "busy" };
    const operations = this.operations;
    const session = this.session;
    if (this.plan !== "planned" || !operations || !session) return { kind: "nothing" };
    if (!operations.some((op) => op.status === "pending")) return { kind: "nothing" };

    this.busy = "renaming";
    this.setStatus("Renaming files…");
    this.emitState();
    try {
      await session.execute(operations, (current, total, message) =>
        this.emitProgress({ phase: "rename", current, total, message }),
      );

      let coverArtDownloaded = 0;
      const coverArtAttempted =
        this.options.coverArt && operations.some((op) => op.status === "completed");
      if (coverArtAttempted) {
        const downloaded = await session.downloadCoverArt(operations, (current, total, message) =>
          this.emitProgress({ phase: "coverArt", current, total, message }),
        );
        coverArtDownloaded = downloaded.length;
      }

      const historySaved = await session.saveHistory(operations);

      // The list now holds the new names, so a second fetch or an undo sees them.
      for (const [i, op] of operations.entries()) {
        const entry = this.files[i];
        if (entry && op.status === "completed" && entry.path === op.source) {
          entry.path = op.destination;
          entry.name = path.basename(op.destination);
          entry.directory = path.dirname(op.destination);
        }
      }
      this.plan = "renamed";
      await this.refreshLastRename();

      const summary = summarizeOperations(operations);
      const failures: RenameFailure[] = operations
        .filter((op) => op.status === "failed")
        .map((op) => ({ name: path.basename(op.source), message: op.errorMessage ?? "Unknown error" }));
      const associatedRenamed = operations
        .filter((op) => op.status === "completed")
        .reduce((n, op) => n + op.associatedFiles.length, 0);

      this.setStatus(
        `Renamed ${plural(summary.completed, "file")}${summary.failed ? `, ${COUNT.format(summary.failed)} failed` : ""}`,
        summary.failed ? "warning" : "success",
      );
      return {
        kind: "done",
        summary,
        associatedRenamed,
        coverArtDownloaded,
        coverArtAttempted,
        failures,
        historySaved,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus(`Rename failed: ${message}`, "error");
      return { kind: "error", message };
    } finally {
      this.busy = null;
      this.emitProgress(null);
      this.emitState();
    }
  }

  /** Undo the most recent history entry (written by this app or the CLI). */
  async undo(): Promise<UndoOutcome> {
    if (this.busy) return { kind: "busy" };
    this.busy = "undoing";
    this.setStatus("Undoing the last rename…");
    this.emitState();
    try {
      const result = await undoLastRename(this.config, {
        progressCallback: (current, total, message) =>
          this.emitProgress({ phase: "undo", current, total, message }),
      });

      // Put the original names back into the list.
      const restored = new Map<string, string>();
      for (const item of result.items) {
        if (item.status === "undone") restored.set(item.operation.destination, item.operation.source);
      }
      if (restored.size > 0) {
        for (const entry of this.files) {
          const source = restored.get(entry.path);
          if (source) {
            entry.path = source;
            entry.name = path.basename(source);
            entry.directory = path.dirname(source);
          }
        }
        this.sortFiles();
        this.resetPlan();
      }
      await this.refreshLastRename();

      if (!result.historyFound) this.setStatus("There is no rename to undo", "warning");
      else if (result.failed > 0)
        this.setStatus(`Undid ${plural(result.undone, "rename")}; ${COUNT.format(result.failed)} failed`, "warning");
      else this.setStatus(`Undid ${plural(result.undone, "rename")}`, "success");

      return {
        kind: "done",
        historyFound: result.historyFound,
        undone: result.undone,
        missing: result.missing,
        failed: result.failed,
        items: result.items.map((item) => ({
          name: path.basename(item.operation.destination),
          status: item.status,
          errors: item.errors,
        })),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus(`Undo failed: ${message}`, "error");
      return { kind: "error", message };
    } finally {
      this.busy = null;
      this.emitProgress(null);
      this.emitState();
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** Settings for the dialog, including API keys (sent only on request). */
  async getSettingsPayload(): Promise<SettingsPayload> {
    await this.reloadSettings();
    this.emitState();
    const editable = toEditableSettings(this.settings);
    return {
      settings: editable,
      configFile: this.config.configFile,
      fields: TemplateEngine.getAvailableFields(),
      formatters: TemplateEngine.getAvailableFormatters(),
      preview: previewTemplates(editable.templates),
      loadError: this.configError,
    };
  }

  previewTemplates(templates: TemplateSet): TemplatePreview {
    return previewTemplates(templates);
  }

  /** Validate and save edited settings (already shape-checked by the IPC layer). */
  async saveSettings(edited: EditableSettings): Promise<SaveSettingsResult> {
    if (this.busy) return { ok: false, errors: ["Wait for the current task to finish."] };

    const preview = previewTemplates(edited.templates);
    const templateErrors: Partial<Record<keyof TemplateSet, string[]>> = {};
    for (const key of ["movie", "tv", "music"] as const) {
      if (preview[key].errors.length > 0) templateErrors[key] = preview[key].errors;
    }
    if (Object.keys(templateErrors).length > 0) {
      return { ok: false, errors: ["Fix the template errors before saving."], templateErrors };
    }

    this.busy = "saving";
    try {
      // Keep settings the dialog does not edit (dry_run, providers.movie, ...).
      const base = this.configError ? createDefaultSettings() : this.settings;
      const next: Settings = {
        ...base,
        templates: { ...edited.templates },
        api: {
          tmdbApiKey: edited.api.tmdbApiKey.trim(),
          tvdbApiKey: edited.api.tvdbApiKey.trim(),
          tvdbPin: edited.api.tvdbPin.trim(),
        },
        associatedFiles: { ...edited.associatedFiles },
        coverArt: {
          ...edited.coverArt,
          filename: edited.coverArt.filename.trim() || base.coverArt.filename,
          musicFilename: edited.coverArt.musicFilename.trim() || base.coverArt.musicFilename,
        },
        conflictResolution: edited.conflictResolution,
        tvProvider: edited.tvProvider,
      };
      const coverArtDefaultChanged = next.coverArt.enabled !== this.settings.coverArt.enabled;
      await this.config.save(next);
      this.settings = next;
      this.configError = null;
      if (coverArtDefaultChanged) this.options.coverArt = next.coverArt.enabled;
      this.coerceProvider();
      if (this.plan === "planned") {
        this.resetPlan();
        this.setStatus("Settings saved. Fetch metadata again to apply them.", "success");
      } else {
        this.setStatus("Settings saved", "success");
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, errors: [`Could not save settings: ${errorMessage(error)}`] };
    } finally {
      this.busy = null;
      this.emitState();
    }
  }
}
