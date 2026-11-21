/**
 * Renderer UI state: a copy of the main-process snapshot for display, plus
 * what only the window cares about (open dialog, selected row, drag state).
 */

import type { PlannedOperation } from "@tidytitles/core";
import type {
  AppState,
  FileEntry,
  ProgressEvent,
  RenameOutcome,
  SelectionRequest,
  UndoOutcome,
  UpdateState,
} from "../../shared/ipc";

export type Modal =
  | { kind: "settings"; tab?: "output" }
  | { kind: "history" }
  | { kind: "confirmRename" }
  | { kind: "confirmUndo" }
  | { kind: "renameResult"; outcome: Extract<RenameOutcome, { kind: "done" }> }
  | { kind: "undoResult"; outcome: Extract<UndoOutcome, { kind: "done" }> }
  | { kind: "error"; title: string; message: string }
  /** The update dialog, opened by "Check for Updates…"; `sinceCheckId` is the check count when it opened. */
  | { kind: "updates"; sinceCheckId: number }
  | { kind: "confirmRestart" }
  /** "Change Match" for a file in the list. */
  | { kind: "changeMatch"; fileId: number }
  /** "Edit New Name" for a file in the list. */
  | { kind: "editName"; fileId: number };

export interface UiState {
  app: AppState | null;
  progress: ProgressEvent | null;
  /** Open selection request from main (at most one at a time). */
  selection: SelectionRequest | null;
  modal: Modal | null;
  selectedFileId: number | null;
  /** Nesting depth of dragenter/dragleave over the window. */
  dragDepth: number;
  updates: UpdateState | null;
  /** The status-bar note of this manual check was dismissed. */
  dismissedCheckId: number;
}

export type Action =
  | { type: "state"; state: AppState }
  | { type: "progress"; progress: ProgressEvent | null }
  | { type: "selectionRequest"; request: SelectionRequest }
  | { type: "selectionDone"; id: string }
  | { type: "openModal"; modal: Modal }
  | { type: "closeModal" }
  | { type: "selectFile"; id: number | null }
  | { type: "dragEnter" }
  | { type: "dragLeave" }
  | { type: "dragEnd" }
  | { type: "updateState"; state: UpdateState }
  | { type: "dismissUpdateNote" };

export const initialUiState: UiState = {
  app: null,
  progress: null,
  selection: null,
  modal: null,
  selectedFileId: null,
  dragDepth: 0,
  updates: null,
  dismissedCheckId: 0,
};

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "state": {
      const ids = new Set(action.state.files.map((f) => f.id));
      const selectedFileId =
        state.selectedFileId !== null && ids.has(state.selectedFileId) ? state.selectedFileId : null;
      // A finished fetch withdraws any selection still on screen.
      const selection = action.state.busy === "fetching" ? state.selection : null;
      const progress = action.state.busy === null ? null : state.progress;
      return { ...state, app: reconcileAppState(state.app, action.state), selectedFileId, selection, progress };
    }
    case "progress":
      return { ...state, progress: action.progress };
    case "selectionRequest":
      return { ...state, selection: action.request };
    case "selectionDone":
      return state.selection?.id === action.id ? { ...state, selection: null } : state;
    case "openModal":
      return { ...state, modal: action.modal };
    case "closeModal":
      return { ...state, modal: null };
    case "selectFile":
      return { ...state, selectedFileId: action.id };
    case "dragEnter":
      return { ...state, dragDepth: state.dragDepth + 1 };
    case "dragLeave":
      return { ...state, dragDepth: Math.max(0, state.dragDepth - 1) };
    case "dragEnd":
      return { ...state, dragDepth: 0 };
    case "updateState":
      return { ...state, updates: action.state };
    case "dismissUpdateNote":
      return { ...state, dismissedCheckId: state.updates?.checkId ?? state.dismissedCheckId };
  }
}

// ---------------------------------------------------------------------------
// Structural sharing
// ---------------------------------------------------------------------------

/** Deep equality for plain JSON-like values (what arrives over IPC). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  // A missing key and an undefined value are the same absent value.
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k in ao) if (!sameJson(ao[k], bo[k])) return false;
  for (const k in bo) if (!(k in ao) && bo[k] !== undefined) return false;
  return true;
}

function sameFile(a: FileEntry, b: FileEntry): boolean {
  return a.id === b.id && a.path === b.path && a.name === b.name && a.directory === b.directory && a.kind === b.kind;
}

/**
 * Every snapshot from main arrives as new objects. Keep the previous object
 * for each file and operation that did not change (and the previous arrays
 * when nothing in them did), so memoized rows and derived layouts skip the
 * files a state change did not touch.
 */
export function reconcileAppState(prev: AppState | null, next: AppState): AppState {
  if (!prev) return next;
  const prevIndex = new Map<number, number>();
  prev.files.forEach((f, i) => prevIndex.set(f.id, i));

  let filesSame = prev.files.length === next.files.length;
  const files = next.files.map((f, i) => {
    const j = prevIndex.get(f.id);
    const old = j === undefined ? undefined : prev.files[j];
    if (old && sameFile(old, f)) {
      if (j !== i) filesSame = false;
      return old;
    }
    filesSame = false;
    return f;
  });

  let operations = next.operations;
  if (operations && prev.operations) {
    const prevOps = prev.operations;
    let opsSame = filesSame && prevOps.length === operations.length;
    operations = operations.map((op, i): PlannedOperation => {
      const j = prevIndex.get(next.files[i]?.id ?? -1);
      const old = j === undefined ? undefined : prevOps[j];
      if (old && sameJson(old, op)) {
        if (j !== i) opsSame = false;
        return old;
      }
      opsSame = false;
      return op;
    });
    if (opsSame) operations = prevOps;
  }

  return {
    ...next,
    files: filesSame ? prev.files : files,
    operations,
    options: sameJson(prev.options, next.options) ? prev.options : next.options,
    output: sameJson(prev.output, next.output) ? prev.output : next.output,
  };
}

/** Counts for the status bar. */
export interface ListCounts {
  files: number;
  ready: number;
  skipped: number;
  completed: number;
  failed: number;
}

export function listCounts(app: AppState): ListCounts {
  const counts: ListCounts = { files: app.files.length, ready: 0, skipped: 0, completed: 0, failed: 0 };
  for (const op of app.operations ?? []) {
    if (op.status === "pending") counts.ready += 1;
    else if (op.status === "skipped") counts.skipped += 1;
    else if (op.status === "completed") counts.completed += 1;
    else if (op.status === "failed") counts.failed += 1;
  }
  return counts;
}

/** What the toolbar and menu allow (mirrors main's `commandEnabled`). */
export function availability(app: AppState | null) {
  const idle = app !== null && app.busy === null;
  const pending = app?.operations?.some((op) => op.status === "pending") ?? false;
  return {
    add: idle,
    clear: idle && (app?.files.length ?? 0) > 0,
    fetch: idle && (app?.files.length ?? 0) > 0,
    cancelFetch: app?.busy === "fetching",
    rename: idle && app?.plan === "planned" && pending,
    undo: idle && app?.lastRename != null,
    settings: idle,
    history: idle,
  };
}
