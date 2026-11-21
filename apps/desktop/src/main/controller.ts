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
  HistoryChangedError,
  RenameSession,
  TemplateEngine,
  FIELD_GROUP_LABELS,
  NAMING_PRESETS,
  getTemplateFieldDocs,
  applyTransferChecks,
  availableProviderChoices,
  collectMediaFiles,
  createDefaultSettings,
  forceTypeForChoice,
  getApiKeyStatus,
  isMusicFile,
  listHistory,
  summarizeOperations,
  undoHistoryEntry,
  undoLastRename,
  type ConfigService,
  type UndoResult,
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
  HistoryEntryView,
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
import { episodeOrderNotes, metadataLanguageChoices } from "./metadataOptions";
import { previewTemplates } from "./templatePreview";
import {
  describeLookupError,
  queryTypesFor,
  type MatchQuery,
  type PlanCorrector,
} from "@tidytitles/core";
import type {
  ChooseMatchOptions,
  ChooseMatchOutcome,
  CorrectionOutcome,
  EditableNameOutcome,
  MatchContextOutcome,
  MatchSearchOutcome,
  SetFileNameOutcome,
} from "../shared/ipc";
import {
  processWatchBatch,
  watchSessionSettings,
  type ReadyFile,
  type WatchBatchResult,
  type WatchMode,
} from "@tidytitles/core";

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
    output: { ...settings.output },
    history: { ...settings.history },
    tv: { ...settings.tv },
    metadata: { ...settings.metadata },
    watch: { ...settings.watch, folders: [...settings.watch.folders] },
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
    transferMode: "move",
  };
  private lastRename: LastRenameInfo | null = null;
  private status: StatusMessage = { text: "Ready", tone: "info" };
  /** Corrects the current plan (set by a successful fetch). */
  private corrector: PlanCorrector | null = null;
  /** The latest "Change Match" search; `chooseMatch` picks from it. */
  private lastSearch: { id: string; fileId: number; query: MatchQuery; options: SelectableOption[]; version: number } | null = null;
  /** Changes whenever the plan is dropped, so late search results are not used. */
  private planVersion = 0;

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
    this.options.transferMode = this.settings.output.transferMode;
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
      output: { movie: this.settings.output.movie, tv: this.settings.output.tv, music: this.settings.output.music },
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
    this.corrector = null;
    this.lastSearch = null;
    this.planVersion += 1;
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
    const changedTransfer = next.transferMode !== this.options.transferMode;
    this.options = next;
    this.coerceProvider();
    // A new transfer mode needs no new lookup: only hard links that cannot
    // work are marked (or unmarked) in the plan.
    if (changedTransfer && this.plan === "planned" && this.session && this.operations) {
      this.session.transferMode = next.transferMode;
      applyTransferChecks(this.operations, next.transferMode);
    }
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
      transferMode: this.options.transferMode,
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
      this.corrector = session.corrector(operations);
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

      // The list now holds the new names, so a second fetch or an undo sees
      // them. A copy or link leaves the original, which stays in the list.
      for (const [i, op] of operations.entries()) {
        const entry = this.files[i];
        if (entry && op.status === "completed" && entry.path === op.source && session.transferMode === "move") {
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

      const verb = { move: "Renamed", copy: "Copied", hardlink: "Linked" }[session.transferMode];
      this.setStatus(
        `${verb} ${plural(summary.completed, "file")}${summary.failed ? `, ${COUNT.format(summary.failed)} failed` : ""}`,
        summary.failed ? "warning" : "success",
      );
      return {
        kind: "done",
        summary,
        associatedRenamed,
        coverArtDownloaded,
        coverArtAttempted,
        transferMode: session.transferMode,
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
    return this.runUndo("Undoing the last rename…", (progressCallback) =>
      // Undo only the entry the confirmation showed; the CLI may have
      // recorded a newer one since.
      undoLastRename(this.config, {
        progressCallback,
        ...(this.lastRename ? { expectedTimestamp: this.lastRename.timestamp } : {}),
      }),
    );
  }

  /**
   * Undo any history entry, found by its timestamp. Files that later
   * renames moved or replaced are left in place and reported.
   */
  async undoEntry(timestamp: string): Promise<UndoOutcome> {
    return this.runUndo("Undoing a rename…", (progressCallback) =>
      undoHistoryEntry(this.config, timestamp, { progressCallback }),
    );
  }

  /** The rename history for the History dialog, most recent first. */
  async getHistory(): Promise<HistoryEntryView[]> {
    return listHistory(this.config);
  }

  private async runUndo(
    status: string,
    run: (progressCallback: (current: number, total: number, message: string) => void) => Promise<UndoResult>,
  ): Promise<UndoOutcome> {
    if (this.busy) return { kind: "busy" };
    this.busy = "undoing";
    this.setStatus(status);
    this.emitState();
    try {
      const result = await run((current, total, message) =>
        this.emitProgress({ phase: "undo", current, total, message }),
      );

      // Put the original names back into the list (a removed copy or link
      // was never in it: the list kept the original).
      const restored = new Map<string, string>();
      for (const item of result.items) {
        if (item.status === "undone" && !item.operation.transfer) {
          restored.set(item.operation.destination, item.operation.source);
        }
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
      else if (result.kept > 0)
        this.setStatus(`Undid ${plural(result.undone, "rename")}; ${plural(result.kept, "file")} left in place`, "warning");
      else this.setStatus(`Undid ${plural(result.undone, "rename")}`, "success");

      return {
        kind: "done",
        historyFound: result.historyFound,
        undone: result.undone,
        missing: result.missing,
        kept: result.kept,
        failed: result.failed,
        items: result.items.map((item) => ({
          name: path.basename(item.operation.destination),
          status: item.status,
          errors: item.errors,
          kept: item.kept.map((k) => ({ name: path.basename(k.path), reason: k.reason })),
        })),
      };
    } catch (error) {
      if (error instanceof HistoryChangedError) await this.refreshLastRename().catch(() => undefined);
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
  // Correcting a match or a new name
  // -------------------------------------------------------------------------

  /** The file and corrector, when the plan can be corrected now. */
  private correctable(fileId: number): { index: number; name: string; corrector: PlanCorrector } | null {
    if (this.busy || this.plan !== "planned" || !this.corrector || !this.operations) return null;
    const index = this.files.findIndex((f) => f.id === fileId);
    if (index < 0 || !this.operations[index]) return null;
    return { index, name: this.files[index]!.name, corrector: this.corrector };
  }

  /** Run a change to the plan; the list is busy meanwhile, so nothing else changes it. */
  private async correct<T>(corrector: PlanCorrector, change: () => Promise<T>): Promise<T> {
    this.busy = "correcting";
    this.emitState();
    try {
      const result = await change();
      if (this.corrector === corrector) this.operations = corrector.operations;
      return result;
    } finally {
      this.busy = null;
      this.emitState();
    }
  }

  getMatchContext(fileId: number): MatchContextOutcome {
    const target = this.correctable(fileId);
    if (!target) return { kind: "unavailable" };
    const { corrector, index } = target;
    const file = this.operations![index]!.mediaFile;
    return {
      kind: "ok",
      context: {
        fileId,
        query: corrector.query(index),
        queryTypes: queryTypesFor(file),
        parsedTitle: file.parsedInfo.title,
        similarCount: corrector.similarFiles(index).length,
      },
    };
  }

  async searchMatches(fileId: number, query: MatchQuery): Promise<MatchSearchOutcome> {
    const target = this.correctable(fileId);
    if (!target) return { kind: "unavailable" };
    if (!queryTypesFor(this.operations![target.index]!.mediaFile).includes(query.mediaType)) {
      return { kind: "unavailable" };
    }
    const version = this.planVersion;
    try {
      const result = await target.corrector.search(query);
      if (version !== this.planVersion) return { kind: "unavailable" };
      if (!result.providerAvailable) return { kind: "noProvider", mediaType: query.mediaType };
      const id = randomUUID();
      this.lastSearch = { id, fileId, query: result.query, options: result.options, version };
      return { kind: "results", searchId: id, query: result.query, options: result.options };
    } catch (error) {
      return { kind: "error", error: describeLookupError(error) };
    }
  }

  async chooseMatch(searchId: string, index: number, options: ChooseMatchOptions): Promise<ChooseMatchOutcome> {
    const search = this.lastSearch;
    if (!search || search.id !== searchId || search.version !== this.planVersion) return { kind: "unavailable" };
    const option = search.options[index];
    const target = this.correctable(search.fileId);
    if (!option || !target) return { kind: "unavailable" };
    // The season and episode may have been corrected after the show search.
    const query: MatchQuery =
      search.query.mediaType === "tv_episode"
        ? {
            ...search.query,
            ...(options.season !== undefined ? { season: options.season } : {}),
            ...(options.episode !== undefined ? { episode: options.episode } : {}),
          }
        : search.query;
    try {
      const result = await this.correct(target.corrector, () =>
        target.corrector.chooseMatch(target.index, query, option, { applyToSimilar: options.applyToSimilar }),
      );
      switch (result.kind) {
        case "applied": {
          const title = option.kind === "track" ? `${option.artist.name} – ${option.title}` : option.title;
          this.setStatus(
            result.changed.length > 1
              ? `Matched ${plural(result.changed.length, "file")} to ${title}${result.unmatched.length ? `; ${plural(result.unmatched.length, "file")} had no such episode` : ""}`
              : `Matched ${target.name} to ${title}`,
            result.unmatched.length ? "warning" : "success",
          );
          this.emitState();
          return { kind: "applied", changed: result.changed.length, unmatched: result.unmatched.length };
        }
        case "episode_not_found":
          return { kind: "episodeNotFound", season: result.season, episode: result.episode };
        case "needs_episode":
          return { kind: "needsEpisode" };
      }
    } catch (error) {
      return { kind: "error", error: describeLookupError(error) };
    }
  }

  async clearMatch(fileId: number): Promise<CorrectionOutcome> {
    const target = this.correctable(fileId);
    if (!target) return { kind: "unavailable" };
    await this.correct(target.corrector, () => target.corrector.clearMatch(target.index));
    this.setStatus(`Cleared the match for ${target.name}; it will be left as it is`);
    this.emitState();
    return { kind: "applied" };
  }

  async getEditableName(fileId: number): Promise<EditableNameOutcome> {
    const target = this.correctable(fileId);
    if (!target) return { kind: "unavailable" };
    const name = await target.corrector.editableName(target.index);
    return name ? { kind: "ok", name } : { kind: "unavailable" };
  }

  async setFileName(fileId: number, name: string | null): Promise<SetFileNameOutcome> {
    const target = this.correctable(fileId);
    if (!target) return { kind: "unavailable" };
    const result = await this.correct(target.corrector, () => target.corrector.setName(target.index, name));
    switch (result.kind) {
      case "applied":
        this.setStatus(name === null ? `${target.name} gets the template’s name again` : `New name set for ${target.name}`, "success");
        this.emitState();
        return { kind: "applied" };
      case "invalid":
        return { kind: "invalid", problem: result.problem, message: result.message };
      case "not_editable":
        return { kind: "unavailable" };
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
      fieldDocs: getTemplateFieldDocs(),
      fieldGroupLabels: { ...FIELD_GROUP_LABELS },
      presets: NAMING_PRESETS.map((p) => ({ ...p, templates: { ...p.templates }, sources: [...p.sources] })),
      preview: previewTemplates(editable.templates),
      loadError: this.configError,
      metadataLanguages: metadataLanguageChoices(this.settings.metadata.language),
      episodeOrderNotes: episodeOrderNotes(),
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
        output: {
          movie: edited.output.movie.trim(),
          tv: edited.output.tv.trim(),
          music: edited.output.music.trim(),
          transferMode: edited.output.transferMode,
        },
        history: { maxEntries: edited.history.maxEntries },
        tv: { ...edited.tv },
        metadata: { ...edited.metadata },
        watch: { ...edited.watch, folders: [...edited.watch.folders] },
      };
      const coverArtDefaultChanged = next.coverArt.enabled !== this.settings.coverArt.enabled;
      const transferDefaultChanged = next.output.transferMode !== this.settings.output.transferMode;
      await this.config.save(next);
      this.settings = next;
      this.configError = null;
      if (coverArtDefaultChanged) this.options.coverArt = next.coverArt.enabled;
      if (transferDefaultChanged) this.options.transferMode = next.output.transferMode;
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

  // -------------------------------------------------------------------------
  // Watch folders (driven by watchManager.ts)
  // -------------------------------------------------------------------------

  /** The settings as last loaded or saved. */
  get currentSettings(): Settings {
    return this.settings;
  }

  /** The config service (history, config file). */
  get configService(): ConfigService {
    return this.config;
  }

  /** The paths in the file list (by their real path, as `addPaths` compares them). */
  listedPaths(): Set<string> {
    return new Set(this.files.map((f) => realKey(f.path)));
  }

  /**
   * Look up files from a watch folder and, in automatic mode, rename the
   * unambiguous ones (`processWatchBatch`). The app is busy ("watching")
   * meanwhile. Resolves to null, touching nothing, when the app is busy or
   * the settings cannot be read.
   */
  async runWatchBatch(files: readonly ReadyFile[], mode: WatchMode): Promise<WatchBatchResult | null> {
    if (this.busy) return null;
    this.busy = "watching";
    this.setStatus("Looking up new files from the watch folders…");
    this.emitState();
    try {
      await this.reloadSettings();
      if (this.configError) return null;
      const session = new RenameSession(watchSessionSettings(this.settings, mode), {
        config: this.config,
        requireApiKeys: false,
        ...this.sessionOverrides,
      });
      const result = await processWatchBatch(session, files, {
        mode,
        settleMs: this.settings.watch.settleSeconds * 1_000,
      });
      if (result.historySaved > 0) await this.refreshLastRename();
      const renamed = result.outcomes.filter((o) => o.result === "renamed").length;
      if (renamed > 0) this.setStatus(`Renamed ${plural(renamed, "new file")} from the watch folders`, "success");
      else this.setStatus("Ready");
      return result;
    } finally {
      this.busy = null;
      this.emitState();
    }
  }
}
